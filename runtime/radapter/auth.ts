import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Env } from '../types';
import type { RuntimeAdapterAuthLevel, RuntimeAdapterAuthRole } from './types';

const AUTH_DOMAIN = 'xln-radapter-v1';
const CAPABILITY_PREFIX = 'xlnra1';
const DEFAULT_CAPABILITY_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_CAPABILITY_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CAPABILITY_AUDIENCE = 'xln-runtime';
const DEFAULT_CAPABILITY_KEY_ID = 'default';

export type RuntimeAdapterAuthVerification = {
  level: RuntimeAdapterAuthLevel;
  expiresAtMs: number | null;
  audience: string;
  keyId: string;
  tokenId: string;
};

export type RuntimeAdapterCapabilityOptions = {
  audience?: string;
  keyId?: string;
  tokenId?: string;
};

export type RuntimeAdapterAuthVerifyOptions = {
  audience?: string;
  maxTtlMs?: number;
  revokedTokenIds?: ReadonlySet<string>;
};

const normalizeAuthLevel = (role: RuntimeAdapterAuthRole): RuntimeAdapterAuthLevel => {
  if (role === 'read' || role === 'inspect') return 'inspect';
  if (role === 'full' || role === 'admin') return 'admin';
  throw new Error(`RADAPTER_AUTH_ROLE_UNSUPPORTED: ${String(role)}`);
};

const normalizedSeed = (seed: string): string => {
  const normalizedSeed = String(seed || '').trim();
  if (!normalizedSeed) throw new Error('RADAPTER_AUTH_SEED_REQUIRED');
  if (runtimeAdapterStrongAuthSeedRequired()) {
    const minBytes = runtimeAdapterAuthSeedMinBytes();
    if (Buffer.byteLength(normalizedSeed, 'utf8') < minBytes) {
      throw new Error(`RADAPTER_AUTH_SEED_TOO_WEAK: minBytes=${minBytes}`);
    }
  }
  return normalizedSeed;
};

const truthyEnv = (name: string): boolean => {
  const raw = typeof process !== 'undefined' ? String(process.env[name] || '').trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const runtimeAdapterStrongAuthSeedRequired = (): boolean => {
  const nodeEnv = typeof process !== 'undefined' ? String(process.env['NODE_ENV'] || '').trim().toLowerCase() : '';
  return nodeEnv === 'production' || truthyEnv('XLN_RADAPTER_REQUIRE_STRONG_AUTH_SEED');
};

const runtimeAdapterAuthSeedMinBytes = (): number => {
  const raw = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_AUTH_SEED_MIN_BYTES'] || '').trim() : '';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 32;
};

const runtimeAdapterCapabilityTtlMs = (): number => {
  const raw = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_TOKEN_TTL_MS'] || '').trim() : '';
  if (!raw) return DEFAULT_CAPABILITY_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CAPABILITY_TTL_MS;
};

const runtimeAdapterCapabilityMaxTtlMs = (): number => {
  const raw = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_TOKEN_MAX_TTL_MS'] || '').trim() : '';
  if (!raw) return DEFAULT_CAPABILITY_MAX_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CAPABILITY_MAX_TTL_MS;
};

const normalizeTokenField = (value: string, label: string): string => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`RADAPTER_AUTH_${label}_REQUIRED`);
  if (Buffer.byteLength(normalized, 'utf8') > 256) throw new Error(`RADAPTER_AUTH_${label}_TOO_LONG`);
  return normalized;
};

const encodeTokenField = (value: string, label: string): string =>
  Buffer.from(normalizeTokenField(value, label), 'utf8').toString('base64url');

const decodeTokenField = (value: string, label: string): string | null => {
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    return normalizeTokenField(Buffer.from(raw, 'base64url').toString('utf8'), label);
  } catch {
    return null;
  }
};

export const resolveRuntimeAdapterAuthAudience = (env: Env | null): string => {
  const explicit = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_AUDIENCE'] || '').trim() : '';
  if (explicit) return normalizeTokenField(explicit.toLowerCase(), 'AUDIENCE');
  const runtimeId = String(env?.runtimeId || '').trim().toLowerCase();
  return runtimeId ? normalizeTokenField(runtimeId, 'AUDIENCE') : DEFAULT_CAPABILITY_AUDIENCE;
};

export const runtimeAdapterRevokedTokenIds = (): Set<string> => {
  const raw = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_REVOKED_JTIS'] || '').trim() : '';
  if (!raw) return new Set();
  return new Set(raw.split(',').map(value => value.trim()).filter(Boolean));
};

const hmacHex = (seed: string, payload: string): string =>
  createHmac('sha256', normalizedSeed(seed))
    .update(payload)
    .digest('hex');

export const deriveRuntimeAdapterCapabilityToken = (
  seed: string,
  role: RuntimeAdapterAuthRole,
  expiresAtMs = Date.now() + runtimeAdapterCapabilityTtlMs(),
  options: RuntimeAdapterCapabilityOptions = {},
): string => {
  const level = normalizeAuthLevel(role);
  const exp = Math.floor(Number(expiresAtMs));
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    throw new Error('RADAPTER_AUTH_EXPIRY_REQUIRED');
  }
  const ttl = exp - Date.now();
  const maxTtlMs = runtimeAdapterCapabilityMaxTtlMs();
  if (ttl > maxTtlMs) {
    throw new Error(`RADAPTER_AUTH_TTL_EXCEEDED: maxTtlMs=${maxTtlMs}`);
  }
  const audience = normalizeTokenField(String(options.audience || resolveRuntimeAdapterAuthAudience(null)).toLowerCase(), 'AUDIENCE');
  const keyId = normalizeTokenField(String(options.keyId || DEFAULT_CAPABILITY_KEY_ID), 'KID');
  const tokenId = normalizeTokenField(String(options.tokenId || randomBytes(16).toString('hex')), 'JTI');
  const signature = hmacHex(seed, `${AUTH_DOMAIN}:cap:${level}:${exp}:${audience}:${keyId}:${tokenId}`);
  const tokenRole = level === 'inspect' ? 'read' : 'full';
  return [
    CAPABILITY_PREFIX,
    tokenRole,
    String(exp),
    encodeTokenField(audience, 'AUDIENCE'),
    encodeTokenField(keyId, 'KID'),
    encodeTokenField(tokenId, 'JTI'),
    signature,
  ].join('.');
};

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

export const resolveRuntimeAdapterAuthSeed = (env: Env | null): string | null => {
  const fromEnv = typeof process !== 'undefined' ? String(process.env['XLN_RADAPTER_AUTH_SEED'] || '').trim() : '';
  if (fromEnv) return normalizedSeed(fromEnv);
  if (truthyEnv('XLN_RADAPTER_REQUIRE_AUTH_SEED')) return null;
  if (!truthyEnv('XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH')) return null;
  const runtimeSeed = String(env?.runtimeSeed || '').trim();
  return runtimeSeed ? normalizedSeed(runtimeSeed) : null;
};

export const verifyRuntimeAdapterAuthKey = (
  seed: string | null,
  key: unknown,
  options: RuntimeAdapterAuthVerifyOptions = {},
): RuntimeAdapterAuthLevel | null => {
  return verifyRuntimeAdapterAuthCredential(seed, key, options)?.level ?? null;
};

export const verifyRuntimeAdapterAuthCredential = (
  seed: string | null,
  key: unknown,
  options: RuntimeAdapterAuthVerifyOptions = {},
): RuntimeAdapterAuthVerification | null => {
  if (!seed || typeof key !== 'string' || key.trim().length === 0) return null;
  const candidate = key.trim();
  const parts = candidate.split('.');
  if (parts.length === 7 && parts[0] === CAPABILITY_PREFIX) {
    const role = parts[1] as RuntimeAdapterAuthRole | undefined;
    const expiresAtMs = Math.floor(Number(parts[2]));
    const audience = decodeTokenField(parts[3] || '', 'AUDIENCE');
    const keyId = decodeTokenField(parts[4] || '', 'KID');
    const tokenId = decodeTokenField(parts[5] || '', 'JTI');
    const signature = parts[6] || '';
    if (!role || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
    if (!audience || !keyId || !tokenId) return null;
    const expectedAudience = normalizeTokenField(String(options.audience || resolveRuntimeAdapterAuthAudience(null)).toLowerCase(), 'AUDIENCE');
    if (audience !== expectedAudience) return null;
    if ((expiresAtMs - Date.now()) > (options.maxTtlMs ?? runtimeAdapterCapabilityMaxTtlMs())) return null;
    if (options.revokedTokenIds?.has(tokenId)) return null;
    let level: RuntimeAdapterAuthLevel;
    try {
      level = normalizeAuthLevel(role);
    } catch {
      return null;
    }
    const expected = hmacHex(seed, `${AUTH_DOMAIN}:cap:${level}:${expiresAtMs}:${audience}:${keyId}:${tokenId}`);
    if (constantTimeEquals(signature, expected)) return { level, expiresAtMs, audience, keyId, tokenId };
    return null;
  }
  return null;
};
