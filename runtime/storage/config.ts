import type { Env } from '../types';
import {
  DEFAULT_ACCOUNT_MERKLE_RADIX,
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_FRAME_DB_MAX_BYTES,
  DEFAULT_FRAME_DB_RETAIN_FRAMES,
  DEFAULT_MATERIALIZE_PERIOD_FRAMES,
  DEFAULT_RETAIN_SNAPSHOTS,
  DEFAULT_SNAPSHOT_PERIOD_FRAMES,
} from './keys';
import type { StorageRuntimeConfig } from './types';

const parseStorageBoolean = (value: unknown, label: string): boolean => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`STORAGE_CONFIG_${label}_INVALID:${String(value)}`);
};

const positiveStorageInteger = (value: unknown, label: string): number => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`STORAGE_CONFIG_${label}_INVALID:${String(value)}`);
  }
  return normalized;
};

const resolveCanonicalHashPeriodFrames = (env: Env): number => {
  const period =
    env.runtimeConfig?.storage?.canonicalHashPeriodFrames ??
    process.env['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'];
  if (period === undefined) return 0;
  const normalized = Number(period);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`STORAGE_CONFIG_CANONICAL_HASH_PERIOD_FRAMES_INVALID:${String(period)}`);
  }
  return normalized;
};

export const resolveStorageRuntimeConfig = (env: Env): Required<StorageRuntimeConfig> => {
  const raw = env.runtimeConfig?.storage;
  const radix = raw?.accountMerkleRadix ?? DEFAULT_ACCOUNT_MERKLE_RADIX;
  if (radix !== 16 && radix !== 256) {
    throw new Error(`STORAGE_CONFIG_ACCOUNT_MERKLE_RADIX_INVALID:${String(radix)}`);
  }
  return {
    enabled: raw?.enabled === undefined ? true : parseStorageBoolean(raw.enabled, 'ENABLED'),
    snapshotPeriodFrames: positiveStorageInteger(
      raw?.snapshotPeriodFrames ?? DEFAULT_SNAPSHOT_PERIOD_FRAMES,
      'SNAPSHOT_PERIOD_FRAMES',
    ),
    retainSnapshots: positiveStorageInteger(raw?.retainSnapshots ?? DEFAULT_RETAIN_SNAPSHOTS, 'RETAIN_SNAPSHOTS'),
    epochMaxBytes: positiveStorageInteger(raw?.epochMaxBytes ?? DEFAULT_EPOCH_MAX_BYTES, 'EPOCH_MAX_BYTES'),
    frameDbMaxBytes: positiveStorageInteger(raw?.frameDbMaxBytes ?? DEFAULT_FRAME_DB_MAX_BYTES, 'FRAME_DB_MAX_BYTES'),
    frameDbRetainFrames: positiveStorageInteger(
      raw?.frameDbRetainFrames ?? DEFAULT_FRAME_DB_RETAIN_FRAMES,
      'FRAME_DB_RETAIN_FRAMES',
    ),
    materializePeriodFrames: positiveStorageInteger(
      raw?.materializePeriodFrames ?? DEFAULT_MATERIALIZE_PERIOD_FRAMES,
      'MATERIALIZE_PERIOD_FRAMES',
    ),
    canonicalHashPeriodFrames: resolveCanonicalHashPeriodFrames(env),
    accountMerkleRadix: radix,
  };
};
