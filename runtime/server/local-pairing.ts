import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  deriveRuntimeAdapterCapabilityToken,
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
} from '../radapter/auth';
import { safeStringify } from '../protocol/serialization';
import type { Env } from '../types';

const DEFAULT_PAIRING_TTL_MS = 60_000;
const DEFAULT_CAPABILITY_TTL_MS = 60 * 60 * 1_000;
const MAX_PENDING_PAIRINGS = 16;
const MAX_BODY_BYTES = 4 * 1024;

type PendingPairing = Readonly<{ expiresAt: number }>;

export type LocalPairingController = Readonly<{
  enabled: boolean;
  handle: (request: Request, pathname: string, env: Env | null) => Promise<Response | null>;
}>;

type LocalPairingOptions = Readonly<{
  controlToken?: string;
  instanceId?: string;
  version?: string;
  pairingTtlMs?: number;
  capabilityTtlMs?: number;
}>;

const jsonResponse = (body: unknown, status = 200): Response => new Response(safeStringify(body), {
  status,
  headers: {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  },
});

const normalizedSecret = (value: unknown): string => String(value || '').trim();

const equalSecret = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const bearerToken = (request: Request): string => {
  const match = String(request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return normalizedSecret(match?.[1]);
};

const pairingDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

export const isTrustedLocalPairingOrigin = (request: Request): boolean => {
  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== 'http:' || !isLoopbackHostname(requestUrl.hostname)) return false;
  const origin = normalizedSecret(request.headers.get('origin'));
  if (origin !== requestUrl.origin) return false;
  const fetchSite = normalizedSecret(request.headers.get('sec-fetch-site')).toLowerCase();
  return !fetchSite || fetchSite === 'same-origin';
};

const readJsonBody = async (request: Request): Promise<Record<string, unknown>> => {
  const declaredBytes = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
    throw new Error('LOCAL_PAIRING_BODY_TOO_LARGE');
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('LOCAL_PAIRING_BODY_TOO_LARGE');
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LOCAL_PAIRING_BODY_INVALID');
  }
  return value as Record<string, unknown>;
};

const runtimeWsUrl = (requestUrl: string): string => {
  const url = new URL(requestUrl);
  url.protocol = 'ws:';
  url.pathname = '/rpc';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const runtimeManifest = (env: Env, requestUrl: string, capabilityTtlMs: number, now: number) => {
  const seed = resolveRuntimeAdapterAuthSeed(env);
  if (!seed) throw new Error('LOCAL_PAIRING_RUNTIME_AUTH_SEED_MISSING');
  const expiresAt = now + capabilityTtlMs;
  const audience = resolveRuntimeAdapterAuthAudience(env);
  return {
    v: 1 as const,
    issuedAt: now,
    expiresAt,
    entries: [{
      label: 'Local xln',
      access: 'admin' as const,
      wsUrl: runtimeWsUrl(requestUrl),
      token: deriveRuntimeAdapterCapabilityToken(seed, 'full', expiresAt, {
        audience,
        keyId: 'local-ui',
      }),
    }],
  };
};

export const createLocalPairingController = (options: LocalPairingOptions = {}): LocalPairingController => {
  const controlToken = normalizedSecret(options.controlToken);
  if (controlToken && Buffer.byteLength(controlToken) < 32) {
    throw new Error('LOCAL_PAIRING_CONTROL_TOKEN_TOO_SHORT');
  }
  if (!controlToken) return { enabled: false, handle: async () => null };

  const instanceId = normalizedSecret(options.instanceId);
  const version = normalizedSecret(options.version);
  const pairingTtlMs = Math.max(10_000, Math.floor(options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS));
  const capabilityTtlMs = Math.max(60_000, Math.floor(options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS));
  const pending = new Map<string, PendingPairing>();

  const pruneExpired = (now: number): void => {
    for (const [digest, pairing] of pending) {
      if (pairing.expiresAt <= now) pending.delete(digest);
    }
  };

  const issue = (now: number): { token: string; expiresAt: number } => {
    pruneExpired(now);
    if (pending.size >= MAX_PENDING_PAIRINGS) throw new Error('LOCAL_PAIRING_LIMIT_REACHED');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + pairingTtlMs;
    pending.set(pairingDigest(token), { expiresAt });
    return { token, expiresAt };
  };

  const consume = (token: string, now: number): boolean => {
    pruneExpired(now);
    const digest = pairingDigest(token);
    const pairing = pending.get(digest);
    if (!pairing || pairing.expiresAt <= now) return false;
    pending.delete(digest);
    return true;
  };

  const handle = async (request: Request, pathname: string, env: Env | null): Promise<Response | null> => {
    if (pathname === '/api/local-pairing/status' && request.method === 'GET') {
      return jsonResponse({ ok: true, enabled: true, ready: env !== null, instanceId, version });
    }

    if (pathname === '/api/local-pairing/issue' && request.method === 'POST') {
      if (!equalSecret(bearerToken(request), controlToken)) {
        return jsonResponse({ ok: false, error: 'LOCAL_PAIRING_CONTROL_UNAUTHORIZED' }, 401);
      }
      if (!env) return jsonResponse({ ok: false, error: 'LOCAL_PAIRING_RUNTIME_NOT_READY' }, 503);
      const pairing = issue(Date.now());
      return jsonResponse({ ok: true, pairingToken: pairing.token, expiresAt: pairing.expiresAt });
    }

    if (pathname !== '/api/local-pairing/consume' || request.method !== 'POST') return null;
    if (!isTrustedLocalPairingOrigin(request)) {
      return jsonResponse({ ok: false, error: 'LOCAL_PAIRING_ORIGIN_REJECTED' }, 403);
    }
    if (!env) return jsonResponse({ ok: false, error: 'LOCAL_PAIRING_RUNTIME_NOT_READY' }, 503);

    try {
      const body = await readJsonBody(request);
      const token = normalizedSecret(body['pairingToken']);
      if (!token || !consume(token, Date.now())) {
        return jsonResponse({ ok: false, error: 'LOCAL_PAIRING_TOKEN_INVALID_OR_EXPIRED' }, 401);
      }
      return jsonResponse({ ok: true, manifest: runtimeManifest(env, request.url, capabilityTtlMs, Date.now()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'LOCAL_PAIRING_BODY_TOO_LARGE' ? 413 : 400;
      return jsonResponse({ ok: false, error: message }, status);
    }
  };

  return { enabled: true, handle };
};
