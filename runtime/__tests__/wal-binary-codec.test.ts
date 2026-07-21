import { describe, expect, test } from 'bun:test';

import { decodeBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';
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
  replicaMetaDigest: `0x${'22'.repeat(32)}`,
  replicaMetaCheckpoint: false,
  replicaMetaStateMode: 'live-head',
  runtimeInput: { runtimeTxs: [], entityInputs: [] },
  runtimeStateHash: `0x${'11'.repeat(32)}`,
  logs: [{ id: 1, level: 'info', category: 'system', message: 'frame', timestamp: 123 }],
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

  test('round-trips account-ack consensus origins and rejects unknown lanes at the WAL boundary', () => {
    const sourceEntityId = `0x${'31'.repeat(32)}`;
    const targetEntityId = `0x${'32'.repeat(32)}`;
    const signerId = `0x${'33'.repeat(20)}`;
    const accountAckInput = {
      entityId: targetEntityId,
      signerId,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin: {
            sourceEntityId,
            lane: 'account-ack',
            sequence: 10n,
            semanticHash: `0x${'34'.repeat(32)}`,
            height: 19,
            frameHash: `0x${'35'.repeat(32)}`,
            outputIndex: 0,
          },
          outputHanko: `0x${'36'.repeat(65)}`,
          targetEntityId,
          entityTxs: [{
            type: 'accountInput',
            data: {
              kind: 'ack',
              fromEntityId: sourceEntityId,
              toEntityId: targetEntityId,
              ack: {
                height: 10,
                frameHash: `0x${'37'.repeat(32)}`,
                frameHanko: `0x${'38'.repeat(65)}`,
              },
            },
          }],
        },
      }],
    } as never;
    const env = createEmptyEnv('wal-account-ack-origin');
    env.runtimeInput = { runtimeTxs: [], entityInputs: [accountAckInput] };
    env.runtimeMempool = env.runtimeInput;
    const frame: PersistedFrameJournal = {
      ...journal(),
      runtimeInput: structuredClone(env.runtimeInput),
      runtimeMachine: buildDurableRuntimeMachineSnapshot(env),
    };

    const decoded = decodePersistedFrameJournal(encodePersistedFrameJournal(frame), frame.height);
    const decodedTx = decoded?.runtimeInput.entityInputs[0]?.entityTxs?.[0];
    if (decodedTx?.type !== 'consensusOutput') throw new Error('TEST_CONSENSUS_OUTPUT_MISSING');
    expect(decodedTx.data.origin).toMatchObject({
      lane: 'account-ack',
      sequence: 10n,
      semanticHash: `0x${'34'.repeat(32)}`,
      frameHash: `0x${'35'.repeat(32)}`,
    });

    const corrupt = structuredClone(frame) as PersistedFrameJournal;
    const machineInput = corrupt.runtimeMachine?.['runtimeInput'] as typeof env.runtimeInput;
    const machineTx = machineInput?.entityInputs[0]?.entityTxs?.[0];
    if (machineTx?.type !== 'consensusOutput') throw new Error('TEST_MACHINE_CONSENSUS_OUTPUT_MISSING');
    machineTx.data.origin.lane = 'unknown-account-lane' as never;
    expect(() => decodePersistedFrameJournal(encodePersistedFrameJournal(corrupt), corrupt.height))
      .toThrow('_ORIGIN_LANE');
  });

  test('rejects debug JSON at the authoritative WAL boundary', () => {
    expect(() => decodePersistedFrameJournal(encodeBinaryPayload(journal(), 'json'), 0))
      .toThrow('WAL_CODEC_MSGPACK_REQUIRED');
  });

  test('rejects missing, type-confused, and extra journal fields', () => {
    const missingInput = { ...journal() } as Record<string, unknown>;
    delete missingInput['runtimeInput'];
    expect(() => decodePersistedFrameJournal(encodeBinaryPayload(missingInput), 7))
      .toThrow('WAL_FIELDS_INVALID:missing=runtimeInput');

    expect(() => decodePersistedFrameJournal(encodeBinaryPayload({
      ...journal(),
      height: '7',
    }), 7)).toThrow('WAL_HEIGHT_INVALID');

    expect(() => decodePersistedFrameJournal(encodeBinaryPayload({
      ...journal(),
      logs: 'not-an-array',
    }), 7)).toThrow('WAL_LOGS_INVALID:height=7');

    const encoded = encodeBinaryPayload({ ...journal(), unexpected: true });
    expect(() => decodePersistedFrameJournal(encoded, 7)).toThrow('WAL_FIELDS_INVALID');
    expect(decodeBinaryPayload(encoded)).toBeTruthy();
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
    const restored = createEmptyEnv('wal-durable-runtime');

    restoreDurableRuntimeSnapshot(restored, checkpoint);

    expect(restored.runtimeInput).toEqual(env.runtimeInput);
    expect(restored.runtimeMempool).toBe(restored.runtimeInput);
    expect(restored.runtimeConfig).toEqual(env.runtimeConfig);
    expect(restored.pendingOutputs).toEqual(env.pendingOutputs);
    // Authenticated gossip routes are a rebuildable transport cache. They are
    // deliberately excluded from the input-only WAL machine: P2P can update
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
    const env = createEmptyEnv('wal-durable-empty-trigger');
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
    const restored = createEmptyEnv('wal-durable-empty-trigger-restored');
    restoreDurableRuntimeSnapshot(restored, checkpoint);

    expect(restored.runtimeMempool?.entityInputs).toEqual([emptyTrigger]);
  });

  test('durable runtime snapshot rejects corrupted jurisdiction block numbers', () => {
    const env = createEmptyEnv('wal-invalid-j-height');
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
