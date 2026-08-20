import { describe, expect, test } from 'bun:test';
import type { RoutedEntityInput } from '../../../runtime/types';
import {
  MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES,
  prepareRuntimeOutputPayloadRows,
  readRuntimeOutputPayloads,
} from '../../../storage/wal/outbox-payload';
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
  buildDurableRuntimeMachineSnapshot,
  buildStorageRuntimeMachineSnapshot,
} from '../../../storage/wal/snapshot';
import { createEmptyEnv } from '../../../runtime';
import { encodeBuffer } from '../../../storage/codec/codec';
import { buildRouteOutputKey } from '../../../runtime/delivery/topology/output-routing';

const ENTITY_ID = `0x${'11'.repeat(32)}`;
const SIGNER_ID = `0x${'22'.repeat(20)}`;

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
      if (!value) throw new Error('LEVEL_NOT_FOUND');
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

describe('content-addressed Runtime outbox payloads', () => {
  test('deduplicates disk rows while preserving ordered references', async () => {
    const left = output('left');
    const right = output('right');
    const prepared = prepareRuntimeOutputPayloadRows([left, right, left]);

    expect(prepared.refs).toHaveLength(3);
    expect(prepared.rows).toHaveLength(2);
    expect(prepared.refs[0]).toBe(prepared.refs[2]);
    const restored = await readRuntimeOutputPayloads(
      memoryReader(prepared.rows),
      prepared.refs,
    );
    expect(restored.map(item => item.debugTag)).toEqual(['left', 'right', 'left']);
  });

  test('fails closed on missing or corrupted payload bytes', async () => {
    const prepared = prepareRuntimeOutputPayloadRows([output('safe')]);
    await expect(readRuntimeOutputPayloads(memoryReader([]), prepared.refs))
      .rejects.toThrow('STORAGE_RUNTIME_OUTPUT_PAYLOAD_MISSING');

    const row = prepared.rows[0]!;
    const corrupted = [{ ...row, value: Buffer.from([...row.value, 0]) }];
    await expect(readRuntimeOutputPayloads(memoryReader(corrupted), prepared.refs))
      .rejects.toThrow('STORAGE_RUNTIME_OUTPUT_PAYLOAD_HASH_MISMATCH');
  });

  test('stores a large routed batch as one manifest plus bounded EntityTx leaves', async () => {
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
    const prepared = prepareRuntimeOutputPayloadRows([large]);

    expect(prepared.refs).toHaveLength(1);
    expect(prepared.rows).toHaveLength(36);
    expect(prepared.rows.every(row => row.value.byteLength <= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES)).toBe(true);
    const [restored] = await readRuntimeOutputPayloads(memoryReader(prepared.rows), prepared.refs);
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
    const prepared = prepareRuntimeOutputPayloadRows([large]);

    expect(prepared.rows).toHaveLength(207);
    expect(prepared.rows.every(row => row.value.byteLength <= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES)).toBe(true);
    const [restored] = await readRuntimeOutputPayloads(memoryReader(prepared.rows), prepared.refs);
    expect(restored).toEqual(large);
  });

  test('rejects a payload row larger than the LevelDB record budget', () => {
    const oversized = output('x'.repeat(MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES));
    expect(() => prepareRuntimeOutputPayloadRows([oversized]))
      .toThrow('STORAGE_RUNTIME_OUTPUT_PAYLOAD_TOO_LARGE');
  });
});

describe('content-addressed Entity replay contexts', () => {
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
      new Map([[replicaId, context]]),
    );
    expect(prepared.refs.size).toBe(1);
    // An empty context is the manifest alone: prepared HTLCs are stored one
    // leaf each, so a frame that prepared none writes no HTLC rows.
    expect(prepared.rows).toHaveLength(1);
    expect(prepared.rows.every(row => row.value.byteLength <= MAX_ENTITY_CONTEXT_PAYLOAD_BYTES)).toBe(true);
    const restored = await readEntityContextPayloads(
      memoryReader(prepared.rows),
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
    const prepared = prepareEntityContextPayloadRows(new Map([[replicaId, context]]));
    // One leaf per entry, two reference pages holding their hashes, one manifest.
    expect(prepared.rows).toHaveLength(entries.length + 3);
    expect(prepared.rows.every(row => row.value.byteLength <= MAX_ENTITY_CONTEXT_PAYLOAD_BYTES)).toBe(true);
    const restored = await readEntityContextPayloads(memoryReader(prepared.rows), prepared.refs);
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
      new Map([[recipientReplicaId, context]]),
    );
    const restored = await readEntityContextPayloads(
      memoryReader(prepared.rows),
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
    const parsed = prepareEntityContextPayloadRows(new Map([[replicaId, context]]));
    const skipped = prepareEntityContextPayloadRows(new Map([[replicaId, context]]), true);
    expect([...skipped.refs.entries()]).toEqual([...parsed.refs.entries()]);
    expect(skipped.rows.map(row => row.value.toString('hex')))
      .toEqual(parsed.rows.map(row => row.value.toString('hex')));
  });

  test('in-process skip still binds the replica identity', () => {
    const wrongReplicaId = `${`0x${'44'.repeat(32)}`}:${SIGNER_ID}`;
    expect(() => prepareEntityContextPayloadRows(new Map([[wrongReplicaId, {
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
    expect(() => prepareEntityContextPayloadRows(new Map([[wrongReplicaId, {
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
});

describe('Patricia-addressed Runtime checkpoints', () => {
  test('keeps transport bodies and route keys out of the bounded WAL graph', () => {
    const largeOutput = {
      ...output('large-transport'),
      debugTag: 'x'.repeat(12_000),
    };
    const env = createEmptyEnv('runtime-machine-bounded-outbox');
    env.pendingNetworkOutputs = [largeOutput];
    env.infrastructure = {
      deferredNetworkMeta: new Map([[
        buildRouteOutputKey(largeOutput),
        { attempts: 7, nextRetryAt: 9_000_000_000_000 },
      ]]),
    };

    expect(() => prepareRuntimeMachineGraphRows(
      8,
      buildDurableRuntimeMachineSnapshot(env),
    )).toThrow('STORAGE_RUNTIME_MACHINE_PENDING_OUTPUTS_DUPLICATED');

    const machine = buildStorageRuntimeMachineSnapshot(env);
    expect(machine['pendingNetworkOutputs']).toBeUndefined();
    expect((machine['infrastructure'] as Record<string, unknown> | undefined)?.['deferredNetworkMeta'])
      .toBeUndefined();
    expect(prepareRuntimeMachineGraphRows(8, machine).rows.every(
      row => row.value.byteLength < 10_000,
    )).toBe(true);
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
