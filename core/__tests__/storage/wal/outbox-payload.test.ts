import { describe, expect, test } from 'bun:test';
import type { RoutedEntityInput } from '../../../runtime/types';
import {
  prepareRuntimeOutputRows,
  readRuntimeOutputRows,
} from '../../../storage/wal/outbox-payload';
import { MAX_PHYSICAL_STORAGE_VALUE_BYTES } from '../../../storage/codec/bounded-value';
import {
  MAX_ENTITY_CONTEXT_PAYLOAD_BYTES,
  prepareEntityContextPayloadRows,
  readEntityContextPayloads,
} from '../../../storage/wal/entity-context-payload';
import {
  prepareRuntimeMachineGraphRows,
  readRuntimeMachineGraph,
} from '../../../storage/wal/runtime-machine-graph';
import {
  buildCanonicalRuntimeStateSnapshot,
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimePostStateView,
  buildStorageRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../../../storage/wal/snapshot';
import { validateDurableRuntimeMachineSnapshot } from '../../../storage/wal/runtime-machine-schema';
import { createEmptyEnv } from '../../../runtime';
import { encodeBuffer } from '../../../storage/codec/codec';
import { keyEntityContextPayload } from '../../../storage/keys';

const ENTITY_ID = `0x${'11'.repeat(32)}`;
const SIGNER_ID = `0x${'22'.repeat(20)}`;
const RUNTIME_HEIGHT = 17;

const output = (tag: string): RoutedEntityInput => ({
  entityId: ENTITY_ID,
  signerId: SIGNER_ID,
  entityTxs: [],
  debugTag: tag,
});

const memoryReader = (rows: ReadonlyArray<Readonly<{ key: Buffer; value: Buffer }>>) => {
  const values = new Map(rows.map(row => [row.key.toString('hex'), row.value]));
  return {
    get: async (key: Buffer): Promise<Buffer> => {
      const value = values.get(key.toString('hex'));
      if (!value) {
        const error = new Error('LEVEL_NOT_FOUND') as Error & { code: string };
        error.code = 'LEVEL_NOT_FOUND';
        throw error;
      }
      return value;
    },
    keys: async function* (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) {
      const keys = [...values.keys()]
        .sort()
        .filter(key => !options?.gte || key >= options.gte.toString('hex'))
        .filter(key => !options?.lt || key < options.lt.toString('hex'));
      if (options?.reverse) keys.reverse();
      for (const key of keys) yield Buffer.from(key, 'hex');
    },
  };
};

describe('path-keyed Runtime outbox rows', () => {
  test('stores duplicate values at permanent ordered paths', async () => {
    const left = output('left');
    const right = output('right');
    const prepared = prepareRuntimeOutputRows(7, [left, right, left]);

    expect(prepared.commitment.count).toBe(3);
    expect(prepared.rows).toHaveLength(3);
    expect(prepared.rows.map(row => row.key.toString('hex'))).toEqual([
      '13000000000000000700000000',
      '13000000000000000700000001',
      '13000000000000000700000002',
    ]);
    const restored = await readRuntimeOutputRows(
      memoryReader(prepared.rows),
      7,
      prepared.commitment,
    );
    expect(restored.map(item => item.debugTag)).toEqual(['left', 'right', 'left']);
  });

  test('fails closed on missing or corrupted ordered bytes', async () => {
    const prepared = prepareRuntimeOutputRows(9, [output('safe')]);
    await expect(readRuntimeOutputRows(memoryReader([]), 9, prepared.commitment))
      .rejects.toThrow('STORAGE_RUNTIME_OUTPUT_ROW_MISSING');

    const row = prepared.rows[0]!;
    const corrupted = [{ ...row, value: Buffer.from(row.value.map((byte, index) =>
      index === row.value.length - 1 ? byte ^ 1 : byte)) }];
    await expect(readRuntimeOutputRows(memoryReader(corrupted), 9, prepared.commitment))
      .rejects.toThrow('STORAGE_RUNTIME_OUTPUT_DIGEST_MISMATCH');
  });

  test('chunks one large flat MessagePack row under static owner keys', async () => {
    const large: RoutedEntityInput = {
      ...output('large-batch'),
      entityTxs: [{
        type: 'runtimeOutput',
        data: {
          protocol: 'cross-j',
          sourceEntityId: ENTITY_ID,
          targetEntityId: ENTITY_ID,
          entityTxs: Array.from({ length: 32 }, (_, index) => ({
            type: 'chat' as const,
            data: { from: ENTITY_ID, message: `${index}:${'x'.repeat(512)}` },
          })),
        },
      }],
    };
    const prepared = prepareRuntimeOutputRows(11, [large]);

    expect(prepared.commitment.count).toBe(1);
    expect(prepared.rows.length).toBeGreaterThan(1);
    expect(prepared.rows.every(row => row.value.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES)).toBe(true);
    const [restored] = await readRuntimeOutputRows(memoryReader(prepared.rows), 11, prepared.commitment);
    expect(restored).toEqual(large);
  });

  test('stores Account frame transactions as bounded typed records', async () => {
    const accountTxs = Array.from({ length: 200 }, (_, index) => ({
      type: 'direct_payment' as const,
      data: {
        tokenId: 1,
        amount: BigInt(index + 1),
        route: [ENTITY_ID, `0x${'44'.repeat(32)}`],
        deliveryMode: 'direct' as const,
        fromEntityId: ENTITY_ID,
        toEntityId: `0x${'44'.repeat(32)}`,
        description: `${index}:${'x'.repeat(512)}`,
      },
    }));
    const large: RoutedEntityInput = {
      ...output('large-account-frame'),
      entityTxs: [{
        type: 'accountInput',
        data: {
          kind: 'frame',
          fromEntityId: ENTITY_ID,
          toEntityId: `0x${'44'.repeat(32)}`,
          domain: { chainId: 31337, depositoryAddress: `0x${'55'.repeat(20)}` },
          disputeConfig: { leftResponseSeconds: 86_400, rightResponseSeconds: 86_400 },
          proposal: {
            frame: {
              height: 1,
              timestamp: 1,
              jHeight: 0,
              accountTxs,
              prevFrameHash: 'genesis',
              accountStateRoot: `0x${'66'.repeat(32)}`,
              stateHash: `0x${'77'.repeat(32)}`,
              byLeft: true,
              deltas: [],
            },
          },
        },
      }],
    };
    const prepared = prepareRuntimeOutputRows(12, [large]);

    expect(prepared.rows.length).toBeGreaterThan(1);
    expect(prepared.rows.every(row => row.value.byteLength < MAX_PHYSICAL_STORAGE_VALUE_BYTES)).toBe(true);
    const [restored] = await readRuntimeOutputRows(memoryReader(prepared.rows), 12, prepared.commitment);
    expect(restored).toEqual(large);
  });

  test('empty outbox still has an explicit stable commitment', async () => {
    const prepared = prepareRuntimeOutputRows(13, []);
    expect(prepared.rows).toEqual([]);
    expect(prepared.commitment.count).toBe(0);
    expect(prepared.commitment.digest).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(readRuntimeOutputRows(memoryReader([]), 13, prepared.commitment))
      .resolves.toEqual([]);
  });
});

describe('path-addressed Entity replay contexts', () => {
  test('round-trips exact replica-bound context without a frame blob', async () => {
    const replicaId = `${ENTITY_ID}:${SIGNER_ID}`;
    const context = {
      version: 1 as const,
      proposerReplicaId: replicaId,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 2,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1 as const, entries: [], originated: [] },
    };
    const prepared = prepareEntityContextPayloadRows(
      RUNTIME_HEIGHT,
      new Map([[replicaId, context]]),
    );
    expect(prepared.refs.size).toBe(1);
    // An empty context is the manifest alone: prepared HTLCs are stored one
    // leaf each, so a frame that prepared none writes no HTLC rows.
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.rows.every(row => row.value.byteLength < MAX_ENTITY_CONTEXT_PAYLOAD_BYTES)).toBe(true);
    const restored = await readEntityContextPayloads(
      memoryReader(prepared.rows),
      RUNTIME_HEIGHT,
      prepared.refs,
    );
    expect(restored.get(replicaId)).toEqual(context);
  });

  test('a wide batch of prepared HTLCs stays inside the record cap', async () => {
    const replicaId = `${ENTITY_ID}:${SIGNER_ID}`;
    const entries = Array.from({ length: 120 }, (_, index) => ({
      binding: {
        fromEntityId: ENTITY_ID,
        toEntityId: `0x${index.toString(16).padStart(64, '0')}`,
        domain: { chainId: 31337, depositoryAddress: `0x${'aa'.repeat(20)}` },
        accountFrameHash: `0x${'44'.repeat(32)}`,
        accountHeight: index + 1,
        lockId: `0x${index.toString(16).padStart(64, '0')}`,
        envelopeHash: `0x${'55'.repeat(32)}`,
        hashlock: `0x${'66'.repeat(32)}`,
        tokenId: 1,
        amount: 1_000n,
        timelock: 10n,
        revealBeforeHeight: 100,
      },
      outcome: { kind: 'final' as const, secret: `0x${'77'.repeat(32)}` },
    }));
    const context = {
      version: 1 as const,
      proposerReplicaId: replicaId,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 3,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1 as const, entries, originated: [] },
    };
    const prepared = prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[replicaId, context]]));
    // One leaf per entry, two digest pages, one manifest.
    expect(prepared.rows).toHaveLength(entries.length + 3);
    expect(prepared.rows.every(row => row.value.byteLength < MAX_ENTITY_CONTEXT_PAYLOAD_BYTES)).toBe(true);
    const restored = await readEntityContextPayloads(
      memoryReader(prepared.rows), RUNTIME_HEIGHT, prepared.refs,
    );
    expect(restored.get(replicaId)).toEqual(context);
  });

  test('binds catch-up context to the recipient Entity without rewriting its proposer', async () => {
    const proposerReplicaId = `${ENTITY_ID}:${SIGNER_ID}`;
    const recipientReplicaId = `${ENTITY_ID}:0x${'55'.repeat(20)}`;
    const context = {
      version: 1 as const,
      proposerReplicaId,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 2,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1 as const, entries: [], originated: [] },
    };
    const prepared = prepareEntityContextPayloadRows(
      RUNTIME_HEIGHT,
      new Map([[recipientReplicaId, context]]),
    );
    const restored = await readEntityContextPayloads(
      memoryReader(prepared.rows),
      RUNTIME_HEIGHT,
      prepared.refs,
    );
    expect(restored.get(recipientReplicaId)?.proposerReplicaId)
      .toBe(proposerReplicaId);
  });

  test('in-process skip encodes the same rows as a second parse', () => {
    const replicaId = `${ENTITY_ID}:${SIGNER_ID}`;
    const context = {
      version: 1 as const,
      proposerReplicaId: replicaId,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 2,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1 as const, entries: [], originated: [] },
    };
    const parsed = prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[replicaId, context]]));
    const skipped = prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[replicaId, context]]), true);
    expect([...skipped.refs.entries()]).toEqual([...parsed.refs.entries()]);
    expect(skipped.rows.map(row => row.value.toString('hex')))
      .toEqual(parsed.rows.map(row => row.value.toString('hex')));
  });

  test('in-process skip still binds the replica identity', () => {
    const wrongReplicaId = `${`0x${'44'.repeat(32)}`}:${SIGNER_ID}`;
    expect(() => prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[wrongReplicaId, {
      version: 1,
      proposerReplicaId: `${ENTITY_ID}:${SIGNER_ID}`,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 2,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1, entries: [], originated: [] },
    }]]), true)).toThrow('STORAGE_ENTITY_CONTEXT_REPLICA_BINDING');
  });

  test('rejects a context stored under another replica identity', () => {
    const wrongReplicaId = `${`0x${'44'.repeat(32)}`}:${SIGNER_ID}`;
    expect(() => prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[wrongReplicaId, {
      version: 1,
      proposerReplicaId: `${ENTITY_ID}:${SIGNER_ID}`,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 2,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1, entries: [], originated: [] },
    }]]))).toThrow('STORAGE_ENTITY_CONTEXT_REPLICA_BINDING');
  });

  test('uses a permanent logical key while the committed digest verifies changing bytes', async () => {
    const replicaId = `${ENTITY_ID}:${SIGNER_ID}`;
    const base = {
      version: 1 as const,
      proposerReplicaId: replicaId,
      entityId: ENTITY_ID,
      proposerSignerId: SIGNER_ID,
      parentFrameHash: `0x${'33'.repeat(32)}`,
      height: 2,
      gossipProfiles: [],
      peerAssertions: [],
      htlc: { version: 1 as const, entries: [], originated: [] },
    };
    const first = prepareEntityContextPayloadRows(RUNTIME_HEIGHT, new Map([[replicaId, base]]));
    const second = prepareEntityContextPayloadRows(
      RUNTIME_HEIGHT,
      new Map([[replicaId, { ...base, height: 3 }]]),
    );
    const expectedKey = keyEntityContextPayload(RUNTIME_HEIGHT, replicaId, 'manifest', 0);
    expect(first.rows[0]?.key).toEqual(expectedKey);
    expect(second.rows[0]?.key).toEqual(expectedKey);
    expect(first.refs.get(replicaId)).not.toBe(second.refs.get(replicaId));
    const manifest = first.rows[0]!;
    const corrupted = [{
      ...manifest,
      value: Buffer.from(manifest.value.map((byte, index) =>
        index === manifest.value.length - 1 ? byte ^ 1 : byte)),
    }];
    await expect(readEntityContextPayloads(
      memoryReader(corrupted), RUNTIME_HEIGHT, first.refs,
    )).rejects.toThrow('STORAGE_ENTITY_CONTEXT_PAYLOAD_HASH_MISMATCH');
  });
});

describe('Patricia-addressed Runtime checkpoints', () => {
  test('keeps transport bodies and route keys out of the bounded WAL graph', () => {
    const largeOutput = {
      ...output('large-transport'),
      debugTag: 'x'.repeat(12_000),
    };
    const env = createEmptyEnv('runtime-machine-bounded-outbox');
    env.pendingNetworkOutputs = [largeOutput];

    const machine = buildDurableRuntimeMachineSnapshot(env);
    expect(machine['pendingNetworkOutputs']).toBeUndefined();
    expect(machine['pendingOutputs']).toBeUndefined();
    expect(machine['networkInbox']).toBeUndefined();
    expect(prepareRuntimeMachineGraphRows(8, machine).rows.every(
      row => row.value.byteLength < 10_000,
    )).toBe(true);
    expect(buildStorageRuntimeMachineSnapshot(env)).toEqual(machine);
  });

  test('RAM transport queues cannot change durable machine/root while runtimeOutputs payload stays separate', () => {
    const env = createEmptyEnv('runtime-machine-queue-isolation');
    const queued = output('ram-queue-body');
    const emptyMachine = buildDurableRuntimeMachineSnapshot(env);
    const emptyCheckpoint = buildCanonicalRuntimeStateSnapshot(env);
    const emptyView = buildReplayVerifiableRuntimePostStateView(env);
    const emptyRoot = prepareRuntimeMachineGraphRows(3, emptyMachine).root;
    const emptyOutbox = prepareRuntimeOutputRows(3, []);

    env.pendingOutputs = [queued];
    env.networkInbox = [queued];
    env.pendingNetworkOutputs = [queued];

    const queuedMachine = buildDurableRuntimeMachineSnapshot(env);
    const queuedCheckpoint = buildCanonicalRuntimeStateSnapshot(env);
    const queuedView = buildReplayVerifiableRuntimePostStateView(env);
    const queuedRoot = prepareRuntimeMachineGraphRows(3, queuedMachine).root;
    const queuedOutbox = prepareRuntimeOutputRows(3, [queued]);

    expect(queuedMachine).toEqual(emptyMachine);
    expect(queuedCheckpoint).toEqual(emptyCheckpoint);
    expect(queuedView).toEqual(emptyView);
    expect(queuedRoot).toEqual(emptyRoot);
    expect(queuedMachine['pendingOutputs']).toBeUndefined();
    expect(queuedMachine['networkInbox']).toBeUndefined();
    expect(queuedMachine['pendingNetworkOutputs']).toBeUndefined();
    expect(queuedOutbox.commitment.digest).not.toBe(emptyOutbox.commitment.digest);
    expect(queuedOutbox.commitment.count).toBe(1);
    expect(emptyOutbox.commitment.count).toBe(0);

    const restored = createEmptyEnv('runtime-machine-queue-isolation-restored');
    restoreDurableRuntimeSnapshot(restored, queuedMachine);
    expect(restored.pendingOutputs).toEqual([]);
    expect(restored.networkInbox).toEqual([]);
    expect(restored.pendingNetworkOutputs).toEqual([]);
    expect(() => validateDurableRuntimeMachineSnapshot({
      ...queuedMachine,
      pendingNetworkOutputs: [queued],
    }, 'RUNTIME_MACHINE')).toThrow('RUNTIME_MACHINE_FIELDS');
  });

  test('restores an exact validated machine without a frame blob', async () => {
    const machine = buildDurableRuntimeMachineSnapshot(
      createEmptyEnv('runtime-machine-fields'),
    );
    const prepared = prepareRuntimeMachineGraphRows(1, machine);
    if (!prepared.root) throw new Error('TEST_RUNTIME_MACHINE_ROOT_MISSING');
    expect(prepared.root.leafCount).toBeGreaterThan(0);
    expect(prepared.rows.every(row => row.value.byteLength < 10_000)).toBe(true);
    const restored = await readRuntimeMachineGraph(
      memoryReader(prepared.rows),
      1,
      prepared.root,
    );
    expect(restored).toEqual(machine);
  });

  test('stores a previously oversized infrastructure map as bounded graph rows', async () => {
    const env = createEmptyEnv('runtime-machine-large-infrastructure');
    env.infrastructure = {
      entityEncryptionSeeds: new Map(Array.from({ length: 512 }, (_, index) => [
        `0x${index.toString(16).padStart(64, '0')}`,
        `0x${index.toString(16).padStart(128, '0')}`,
      ])),
    };
    const machine = buildDurableRuntimeMachineSnapshot(env);
    expect(encodeBuffer(machine['infrastructure']).byteLength).toBeGreaterThan(100_000);

    const prepared = prepareRuntimeMachineGraphRows(7, machine);
    if (!prepared.root) throw new Error('TEST_RUNTIME_MACHINE_ROOT_MISSING');
    expect(prepared.rows.every(row => row.value.byteLength < 10_000)).toBe(true);
    expect(await readRuntimeMachineGraph(memoryReader(prepared.rows), 7, prepared.root))
      .toEqual(machine);
  });
});
