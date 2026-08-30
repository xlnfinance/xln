import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { resolveStorageRuntimeConfig } from '../../../storage';
import {
  DEFAULT_EPOCH_MAX_BYTES,
  DEFAULT_RETAIN_SNAPSHOTS,
} from '../../../storage/keys';
import { ensureRuntimeConfig } from '../../../runtime/loop/loop-environment.ts';
import { decodeRuntimeConfig } from '../../../storage/wal/runtime-machine-schema';
import { buildDurableRuntimeMachineSnapshot } from '../../../storage/wal/snapshot';
import { measureRuntimeFrameCloneBytes } from '../../../runtime/frame/clone';

describe('storage config', () => {
  test('keeps performance budgets opt-in and measures deterministic clone payload bytes', () => {
    const env = createEmptyEnv('frame-performance-budget');
    expect(env.runtimeConfig?.performance).toBeUndefined();
    const first = measureRuntimeFrameCloneBytes(env);
    const second = measureRuntimeFrameCloneBytes(env);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);

    env.runtimeConfig = { performance: { maxCloneBytes: first, maxReducerMs: 25 } };
    expect(ensureRuntimeConfig(env).performance).toEqual({
      maxCloneBytes: first,
      maxReducerMs: 25,
    });
    env.runtimeConfig.performance = { maxWalMs: 0 };
    expect(() => ensureRuntimeConfig(env)).toThrow(
      'RUNTIME_CONFIG_PERFORMANCE_MAXWALMS_INVALID:0',
    );
  });

  test('uses sparse full-state checkpoints without weakening per-frame WAL chaining', () => {
    const env = createEmptyEnv('sparse-storage-checkpoints');
    env.runtimeConfig = { ...(env.runtimeConfig || {}) };
    expect(resolveStorageRuntimeConfig(env).canonicalHashPeriodFrames).toBe(0);
    expect(resolveStorageRuntimeConfig(env).materializePeriodFrames).toBe(1_000);
    expect(resolveStorageRuntimeConfig(env).snapshotPeriodFrames).toBe(10_000);
    expect(resolveStorageRuntimeConfig(env)).toMatchObject({
      retainSnapshots: Number.MAX_SAFE_INTEGER,
      epochMaxBytes: Number.MAX_SAFE_INTEGER,
    });
    expect([
      DEFAULT_RETAIN_SNAPSHOTS,
      DEFAULT_EPOCH_MAX_BYTES,
    ]).toEqual(Array(2).fill(Number.MAX_SAFE_INTEGER));
    env.runtimeConfig = { storage: { canonicalHashPeriodFrames: 37 } };
    expect(resolveStorageRuntimeConfig(env).canonicalHashPeriodFrames).toBe(37);
  });

  test('rejects invalid limits instead of silently disabling retention with NaN', () => {
    for (const [field, value] of [
      ['snapshotPeriodFrames', Number.NaN],
      ['retainSnapshots', 0],
      ['epochMaxBytes', -1],
      ['materializePeriodFrames', Number.POSITIVE_INFINITY],
    ] as const) {
      const env = createEmptyEnv(`invalid-storage-${field}`);
      env.runtimeConfig = { storage: { [field]: value } } as typeof env.runtimeConfig;
      expect(() => resolveStorageRuntimeConfig(env)).toThrow(`STORAGE_CONFIG_${field.replaceAll(/([A-Z])/g, '_$1').toUpperCase()}_INVALID`);
    }
  });

  test('persists a fail-fast epoch byte override into each fresh Runtime config', () => {
    const previous = process.env['XLN_STORAGE_EPOCH_MAX_BYTES'];
    try {
      process.env['XLN_STORAGE_EPOCH_MAX_BYTES'] = '33554432';
      const env = createEmptyEnv('forced-production-epoch');
      expect(env.runtimeConfig?.storage?.epochMaxBytes).toBe(33_554_432);
      expect(resolveStorageRuntimeConfig(env).epochMaxBytes).toBe(33_554_432);

      process.env['XLN_STORAGE_EPOCH_MAX_BYTES'] = '0';
      expect(() => createEmptyEnv('invalid-forced-production-epoch'))
        .toThrow('RUNTIME_CONFIG_STORAGE_EPOCH_MAX_BYTES_INVALID:0');
    } finally {
      if (previous === undefined) delete process.env['XLN_STORAGE_EPOCH_MAX_BYTES'];
      else process.env['XLN_STORAGE_EPOCH_MAX_BYTES'] = previous;
    }
  });

  test('persists a fail-fast snapshot cadence override into each fresh Runtime config', () => {
    const previous = process.env['XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES'];
    try {
      process.env['XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES'] = '32';
      const env = createEmptyEnv('forced-soundcheck-snapshot-cadence');
      expect(env.runtimeConfig?.storage?.snapshotPeriodFrames).toBe(32);
      expect(resolveStorageRuntimeConfig(env).snapshotPeriodFrames).toBe(32);

      process.env['XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES'] = '0';
      expect(() => createEmptyEnv('invalid-forced-snapshot-cadence'))
        .toThrow('RUNTIME_CONFIG_STORAGE_SNAPSHOT_PERIOD_FRAMES_INVALID:0');
    } finally {
      if (previous === undefined) delete process.env['XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES'];
      else process.env['XLN_STORAGE_SNAPSHOT_PERIOD_FRAMES'] = previous;
    }
  });

  test('persists a fail-fast materialization cadence override into each fresh Runtime config', () => {
    const previous = process.env['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'];
    try {
      process.env['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'] = '1';
      const env = createEmptyEnv('forced-rust-handoff-materialization-cadence');
      expect(env.runtimeConfig?.storage?.materializePeriodFrames).toBe(1);
      expect(resolveStorageRuntimeConfig(env).materializePeriodFrames).toBe(1);

      process.env['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'] = '0';
      expect(() => createEmptyEnv('invalid-forced-materialization-cadence'))
        .toThrow('RUNTIME_CONFIG_STORAGE_MATERIALIZE_PERIOD_FRAMES_INVALID:0');
    } finally {
      if (previous === undefined) delete process.env['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'];
      else process.env['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'] = previous;
    }
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

  test('does not use the verification flag as a second writer configuration path', () => {
    const previous = process.env['XLN_STORAGE_VERIFY_CANONICAL'];
    try {
      process.env['XLN_STORAGE_VERIFY_CANONICAL'] = '1';
      expect(resolveStorageRuntimeConfig(createEmptyEnv('single-canonical-writer-config')).canonicalHashPeriodFrames)
        .toBe(0);
    } finally {
      if (previous === undefined) delete process.env['XLN_STORAGE_VERIFY_CANONICAL'];
      else process.env['XLN_STORAGE_VERIFY_CANONICAL'] = previous;
    }
  });
});

test('a runtime config written before the dead snapshot knob was removed replays unchanged', () => {
  // The runtime machine hash covers this config. Dropping a persisted field would
  // change that hash and make every journal recorded before the removal fail
  // to replay, so the field is carried through untouched.
  const decoded = decodeRuntimeConfig(
    { minFrameDelayMs: 25, snapshotIntervalFrames: 7, storage: { snapshotPeriodFrames: 10_000 } },
    'TEST_RUNTIME_CONFIG',
  ) as Record<string, unknown>;
  expect(decoded['minFrameDelayMs']).toBe(25);
  expect(decoded['snapshotIntervalFrames']).toBe(7);

  // And it survives into the next snapshot that Runtime writes, because the
  // hash covers the config: a Runtime restored from an old checkpoint keeps
  // the field until an explicit offline migration retires it.
  const env = createEmptyEnv('preserved-snapshot-knob');
  env.runtimeConfig = decoded;
  const snapshot = buildDurableRuntimeMachineSnapshot(env) as Record<string, unknown>;
  const persisted = snapshot['runtimeConfig'] as Record<string, unknown>;
  expect(persisted['snapshotIntervalFrames']).toBe(7);
});
