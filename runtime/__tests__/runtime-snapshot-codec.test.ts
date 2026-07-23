import { describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../runtime';
import {
  buildCanonicalEnvSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';

describe('runtime snapshot codec', () => {
  test('time-machine snapshots preserve complete runtime input and routed output metadata', () => {
    const env = createEmptyEnv('runtime-snapshot-complete-input');
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
    const env = createEmptyEnv('durable-runtime-snapshot');
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
        {
          runtimeId: `0x${'55'.repeat(20)}`,
          runtimeEncPubKey: `0x${'56'.repeat(32)}`,
          lastUpdated: 123,
        },
      ]]),
      runtimeAdapterCommandFrontiers: new Map([[
        `0x${'65'.repeat(32)}`,
        {
          lastContiguousSequence: 7,
          lastInputHash: `0x${'66'.repeat(32)}`,
          lastCommandId: 'durable-command-0001',
          observedHeight: 7,
          expiresAtMs: 123_000,
        },
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
    const restored = createEmptyEnv('durable-runtime-snapshot-restored');

    restoreDurableRuntimeSnapshot(restored, checkpoint);

    expect(restored.runtimeInput).toEqual(env.runtimeInput);
    expect(restored.runtimeMempool).toBe(restored.runtimeInput);
    expect(restored.runtimeConfig).toEqual(env.runtimeConfig);
    expect(restored.pendingOutputs).toEqual(env.pendingOutputs);
    // Authenticated gossip routes are a rebuildable transport cache. They are
    // deliberately excluded from the durable Runtime machine: P2P can update
    // them between frames, so persisting them would make replay depend on
    // nondeterministic network timing.
    expect(checkpoint.runtimeState?.verifiedProfileRoutes).toBeUndefined();
    expect(restored.runtimeState?.verifiedProfileRoutes).toBeUndefined();
    expect(restored.runtimeState?.runtimeAdapterCommandFrontiers).toEqual(env.runtimeState.runtimeAdapterCommandFrontiers);
    expect(restored.jReplicas.get('Testnet')).toEqual(expect.objectContaining({
      blockNumber: 44n,
      stateRoot: new Uint8Array(32).fill(7),
      lastBlockTimestamp: 0,
    }));
    expect(restored.jReplicas.get('Testnet')?.jadapter).toBeUndefined();
  });

  test('durable runtime snapshot retains explicit triggers and drops scheduled-wake-only inputs', () => {
    const env = createEmptyEnv('durable-runtime-empty-trigger');
    const entityId = `0x${'71'.repeat(32)}`;
    const signerId = `0x${'72'.repeat(20)}`;
    const emptyTrigger = { entityId, signerId, entityTxs: [] };
    env.runtimeInput = {
      runtimeTxs: [],
      entityInputs: [emptyTrigger, {
        entityId,
        signerId,
        entityTxs: [{
          type: 'scheduledWake',
          data: {
            version: 1,
            proposerSignerId: signerId,
            dueAt: 123,
            jobs: [],
          },
        }],
      }],
    };
    env.runtimeMempool = env.runtimeInput;

    const checkpoint = buildDurableRuntimeMachineSnapshot(env);
    const restored = createEmptyEnv('durable-runtime-empty-trigger-restored');
    restoreDurableRuntimeSnapshot(restored, checkpoint);

    expect(restored.runtimeMempool?.entityInputs).toEqual([emptyTrigger]);
  });

  test('durable runtime snapshot rejects corrupted jurisdiction block numbers', () => {
    const env = createEmptyEnv('durable-runtime-invalid-j-height');
    env.jReplicas.set('Corrupt', {
      name: 'Corrupt',
      blockNumber: 'not-a-height' as never,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 300,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
    });

    expect(() => buildDurableRuntimeMachineSnapshot(env))
      .toThrow('RUNTIME_MACHINE_J_BLOCK_NUMBER_INVALID:not-a-height');
    env.jReplicas.get('Corrupt')!.blockNumber = -1n;
    expect(() => buildDurableRuntimeMachineSnapshot(env))
      .toThrow('RUNTIME_MACHINE_J_BLOCK_NUMBER_NEGATIVE:-1');
  });
});
