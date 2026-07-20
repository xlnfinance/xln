import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import { resolveStorageRuntimeConfig } from '../storage';

describe('storage config', () => {
  test('uses sparse full-state checkpoints without weakening per-frame WAL chaining', () => {
    const env = createEmptyEnv('sparse-storage-checkpoints');
    expect(resolveStorageRuntimeConfig(env).canonicalHashPeriodFrames).toBe(100);
    expect(resolveStorageRuntimeConfig(env).materializePeriodFrames).toBe(100);
    env.runtimeConfig = { storage: { canonicalHashPeriodFrames: 37 } };
    expect(resolveStorageRuntimeConfig(env).canonicalHashPeriodFrames).toBe(37);
  });

  test('rejects invalid limits instead of silently disabling retention with NaN', () => {
    for (const [field, value] of [
      ['snapshotPeriodFrames', Number.NaN],
      ['retainSnapshots', 0],
      ['epochMaxBytes', -1],
      ['frameDbMaxBytes', 'invalid'],
      ['frameDbRetainFrames', 1.5],
      ['materializePeriodFrames', Number.POSITIVE_INFINITY],
    ] as const) {
      const env = createEmptyEnv(`invalid-storage-${field}`);
      env.runtimeConfig = { storage: { [field]: value } } as typeof env.runtimeConfig;
      expect(() => resolveStorageRuntimeConfig(env)).toThrow(`STORAGE_CONFIG_${field.replaceAll(/([A-Z])/g, '_$1').toUpperCase()}_INVALID`);
    }
  });

  test('accepts an explicit 10 TiB hub budget without losing integer precision', () => {
    const env = createEmptyEnv('large-hub-storage');
    const tenTiB = 10 * 1024 ** 4;
    env.runtimeConfig = { storage: { frameDbMaxBytes: tenTiB } };
    expect(resolveStorageRuntimeConfig(env).frameDbMaxBytes).toBe(tenTiB);
  });

  test('rejects invalid booleans, canonical periods, and merkle radix', () => {
    const env = createEmptyEnv('invalid-storage-shapes');
    env.runtimeConfig = { storage: { enabled: 'maybe' as never } };
    expect(() => resolveStorageRuntimeConfig(env)).toThrow('STORAGE_CONFIG_ENABLED_INVALID');
    env.runtimeConfig = { storage: { canonicalHashPeriodFrames: -1 } };
    expect(() => resolveStorageRuntimeConfig(env)).toThrow('STORAGE_CONFIG_CANONICAL_HASH_PERIOD_FRAMES_INVALID');
    env.runtimeConfig = { storage: { accountMerkleRadix: 32 as never } };
    expect(() => resolveStorageRuntimeConfig(env)).toThrow('STORAGE_CONFIG_ACCOUNT_MERKLE_RADIX_INVALID');
  });
});
