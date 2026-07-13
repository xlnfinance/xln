import { describe, expect, test } from 'bun:test';

import { serializeTaggedJson } from '../protocol/serialization';
import {
  decodePersistedFrameJournal,
  encodePersistedFrameJournal,
  type PersistedFrameJournal,
} from '../wal/store';
import { createEmptyEnv } from '../runtime';
import {
  buildCanonicalEnvSnapshot,
  buildDurableRuntimeMachineSnapshot,
  buildRuntimeRecoveryCheckpointSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';

const journal = (): PersistedFrameJournal => ({
  height: 7,
  timestamp: 123,
  runtimeInput: { runtimeTxs: [], entityInputs: [] },
  runtimeStateHash: `0x${'11'.repeat(32)}`,
  logs: [{ level: 'info', category: 'runtime', message: 'frame', timestamp: 123 }],
});

describe('WAL binary codec', () => {
  test('canonical recovery snapshot normalizes absent legacy runtime input', () => {
    const env = createEmptyEnv('wal-legacy-input');
    env.runtimeInput = undefined as never;
    env.runtimeMempool = undefined;

    const snapshot = buildRuntimeRecoveryCheckpointSnapshot(env);

    expect(snapshot['runtimeInput']).toEqual({ runtimeTxs: [], entityInputs: [] });
  });

  test('writes MessagePack and preserves BigInt-capable tagged values', () => {
    const encoded = encodePersistedFrameJournal(journal());
    expect(encoded[0]).toBe(0x01);
    expect(decodePersistedFrameJournal(encoded, 0)).toEqual(journal());
  });

  test('reads legacy tagged JSON during migration', () => {
    expect(decodePersistedFrameJournal(serializeTaggedJson(journal()), 0)).toEqual(journal());
  });

  test('time-machine snapshots preserve complete runtime input and routed output metadata', () => {
    const env = createEmptyEnv('wal-complete-input');
    const runtimeInput = {
      runtimeTxs: [],
      entityInputs: [],
      jInputs: [{ jurisdictionName: 'Testnet', jTxs: [] }],
      timestamp: 123,
      queuedAt: 120,
    };
    const runtimeOutputs = [{
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'22'.repeat(20)}`,
      runtimeId: `0x${'33'.repeat(20)}`,
      from: `0x${'44'.repeat(20)}`,
      entityTxs: [],
    }];

    const snapshot = buildCanonicalEnvSnapshot(env, {
      runtimeInput,
      runtimeOutputs,
      description: 'complete-input',
    });

    expect(snapshot.runtimeInput).toEqual(runtimeInput);
    expect(snapshot.runtimeOutputs).toEqual(runtimeOutputs);
  });

  test('durable runtime snapshot helper restores queues config and failover outbox', () => {
    const env = createEmptyEnv('wal-durable-runtime');
    env.runtimeConfig = { minFrameDelayMs: 25, snapshotIntervalFrames: 7 };
    env.runtimeInput = {
      runtimeTxs: [],
      entityInputs: [],
      jInputs: [{ jurisdictionName: 'Testnet', jTxs: [] }],
      queuedAt: 120,
    };
    env.runtimeMempool = env.runtimeInput;
    env.pendingOutputs = [{
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'22'.repeat(20)}`,
      runtimeId: `0x${'33'.repeat(20)}`,
      entityTxs: [],
    }];
    env.runtimeState = {
      verifiedProfileRoutes: new Map([[
        `0x${'44'.repeat(32)}`,
        { runtimeId: `0x${'55'.repeat(20)}`, lastUpdated: 123 },
      ]]),
      runtimeAdapterCommandResults: new Map([[
        'durable-command-0001',
        { inputHash: `0x${'66'.repeat(32)}`, result: { height: 7 }, recordedAt: 123 },
      ]]),
    };
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 44n,
      stateRoot: new Uint8Array(32).fill(7),
      mempool: [],
      blockDelayMs: 300,
      lastBlockTimestamp: 123,
      position: { x: 0, y: 50, z: 0 },
    });
    const checkpoint = buildDurableRuntimeMachineSnapshot(env);
    const restored = createEmptyEnv('wal-durable-runtime');

    restoreDurableRuntimeSnapshot(restored, checkpoint);

    expect(restored.runtimeInput).toEqual(env.runtimeInput);
    expect(restored.runtimeMempool).toBe(restored.runtimeInput);
    expect(restored.runtimeConfig).toEqual(env.runtimeConfig);
    expect(restored.pendingOutputs).toEqual(env.pendingOutputs);
    expect(restored.runtimeState?.verifiedProfileRoutes).toEqual(env.runtimeState.verifiedProfileRoutes);
    expect(restored.runtimeState?.runtimeAdapterCommandResults).toEqual(env.runtimeState.runtimeAdapterCommandResults);
    expect(restored.jReplicas.get('Testnet')).toEqual(expect.objectContaining({
      blockNumber: 44n,
      stateRoot: new Uint8Array(32).fill(7),
    }));
    expect(restored.jReplicas.get('Testnet')?.jadapter).toBeUndefined();
  });
});
