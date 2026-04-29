import { createHmac, timingSafeEqual } from 'crypto';
import type { Env } from '../types';
import type { RuntimeAdapterAuthLevel } from './types';

const AUTH_DOMAIN = 'xln-radapter-v1';

export const deriveRuntimeAdapterAuthKey = (seed: string, level: RuntimeAdapterAuthLevel): string => {
  const normalizedSeed = String(seed || '').trim();
  if (!normalizedSeed) throw new Error('RADAPTER_AUTH_SEED_REQUIRED');
  return createHmac('sha256', normalizedSeed)
    .update(`${AUTH_DOMAIN}:${level}`)
    .digest('hex');
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
  const runtimeSeed = String(env?.runtimeSeed || '').trim();
  return runtimeSeed || null;
};

export const verifyRuntimeAdapterAuthKey = (
  seed: string | null,
  key: unknown,
): RuntimeAdapterAuthLevel | null => {
  if (!seed || typeof key !== 'string' || key.trim().length === 0) return null;
  const candidate = key.trim();
  const admin = deriveRuntimeAdapterAuthKey(seed, 'admin');
  if (constantTimeEquals(candidate, admin)) return 'admin';
  const inspect = deriveRuntimeAdapterAuthKey(seed, 'inspect');
  if (constantTimeEquals(candidate, inspect)) return 'inspect';
  return null;
};
