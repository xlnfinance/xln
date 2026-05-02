import { createHmac, timingSafeEqual } from 'crypto';
import type { Env } from '../types';
import type { RuntimeAdapterAuthLevel, RuntimeAdapterAuthRole } from './types';

const AUTH_DOMAIN = 'xln-radapter-v1';
const CAPABILITY_PREFIX = 'xlnra1';
const DEFAULT_CAPABILITY_TTL_MS = 60 * 60 * 1_000;

export type RuntimeAdapterAuthVerification = {
  level: RuntimeAdapterAuthLevel;
  expiresAtMs: number | null;
};

const normalizeAuthLevel = (role: RuntimeAdapterAuthRole): RuntimeAdapterAuthLevel => {
  if (role === 'read' || role === 'inspect') return 'inspect';
  if (role === 'full' || role === 'admin') return 'admin';
  throw new Error(`RADAPTER_AUTH_ROLE_UNSUPPORTED: ${String(role)}`);
};

const normalizedSeed = (seed: string): string => {
  const normalizedSeed = String(seed || '').trim();
  if (!normalizedSeed) throw new Error('RADAPTER_AUTH_SEED_REQUIRED');
  return normalizedSeed;
};

const truthyEnv = (name: string): boolean => {
  const raw = typeof process !== 'undefined' ? String(process.env[name] || '').trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const runtimeAdapterCapabilityTtlMs = (): number => {
  const raw = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_TOKEN_TTL_MS'] || '').trim() : '';
  if (!raw) return DEFAULT_CAPABILITY_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CAPABILITY_TTL_MS;
};

const hmacHex = (seed: string, payload: string): string =>
  createHmac('sha256', normalizedSeed(seed))
    .update(payload)
    .digest('hex');

export const deriveRuntimeAdapterCapabilityToken = (
  seed: string,
  role: RuntimeAdapterAuthRole,
  expiresAtMs = Date.now() + runtimeAdapterCapabilityTtlMs(),
): string => {
  const level = normalizeAuthLevel(role);
  const exp = Math.floor(Number(expiresAtMs));
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    throw new Error('RADAPTER_AUTH_EXPIRY_REQUIRED');
  }
  const signature = hmacHex(seed, `${AUTH_DOMAIN}:cap:${level}:${exp}`);
  const tokenRole = level === 'inspect' ? 'read' : 'full';
  return `${CAPABILITY_PREFIX}.${tokenRole}.${exp}.${signature}`;
};

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

export const resolveRuntimeAdapterAuthSeed = (env: Env | null): string | null => {
  const fromEnv = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_AUTH_SEED'] || '').trim() : '';
  if (fromEnv) return fromEnv;
  if (truthyEnv('XLN_RADAPTER_REQUIRE_AUTH_SEED')) return null;
  if (!truthyEnv('XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH')) return null;
  const runtimeSeed = String(env?.runtimeSeed || '').trim();
  return runtimeSeed || null;
};

export const verifyRuntimeAdapterAuthKey = (
  seed: string | null,
  key: unknown,
): RuntimeAdapterAuthLevel | null => {
  return verifyRuntimeAdapterAuthCredential(seed, key)?.level ?? null;
};

export const verifyRuntimeAdapterAuthCredential = (
  seed: string | null,
  key: unknown,
): RuntimeAdapterAuthVerification | null => {
  if (!seed || typeof key !== 'string' || key.trim().length === 0) return null;
  const candidate = key.trim();
  const parts = candidate.split('.');
  if (parts.length === 4 && parts[0] === CAPABILITY_PREFIX) {
    const role = parts[1] as RuntimeAdapterAuthRole | undefined;
    const expiresAtMs = Math.floor(Number(parts[2]));
    const signature = parts[3] || '';
    if (!role || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
    let level: RuntimeAdapterAuthLevel;
    try {
      level = normalizeAuthLevel(role);
    } catch {
      return null;
    }
    const expected = hmacHex(seed, `${AUTH_DOMAIN}:cap:${level}:${expiresAtMs}`);
    if (constantTimeEquals(signature, expected)) return { level, expiresAtMs };
    return null;
  }
  return null;
};
