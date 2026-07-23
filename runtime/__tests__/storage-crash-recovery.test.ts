import { describe, expect, test } from 'bun:test';

import {
  recoverStorageDbFromHistory,
  hydrateConsumptionRootNodesFromStorage,
} from '../storage';
import {
  buildFrameDbPuts,
  prepareFrameDbCommit,
  putFrameDbCommit,
  readFrameDbHead,
  readFrameDbRuntimeActivity,
} from '../storage/frame-db';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { liveKeyForDoc } from '../storage/doc-refs';
import { prepareStorageStateHashes } from '../storage/hashes';
import {
  KEY_HEAD,
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  STORAGE_SCHEMA_VERSION,
  keyCertifiedBoardNode,
  keyConsumptionNode,
  keyDiff,
} from '../storage/keys';
import type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDiffRecord,
  StorageDoc,
  StorageEntityCoreDoc,
  StorageHead,
  StorageMerkleBranchDoc,
  StorageMerkleLeafDoc,
  StorageRuntimeConfig,
} from '../storage/types';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardStackKey,
  putCertifiedBoardRecord,
} from '../jurisdiction/board-registry';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  verifyConsumptionProof,
} from '../entity/consumption-accumulator';
import { getConsumptionNodeStore } from '../entity/consumption-store';
import { createEmptyEnv } from '../runtime';

const entityId = `0x${'11'.repeat(32)}`;
type PreparedStorageHashes = Awaited<ReturnType<typeof prepareStorageStateHashes>>;

const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 1_000_000,
  frameDbMaxBytes: 1_000_000,
  frameDbRetainFrames: 128,
  materializePeriodFrames: 1,
  accountMerkleRadix: 16,
};

const makeMemoryDb = (entries: Array<[Buffer, Buffer]> = []): RuntimeDbLike => {
  const store = new Map<string, { key: Buffer; value: Buffer }>();
  for (const [key, value] of entries) {
    store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
  }
  return {
    get: async (key: Buffer) => {
      const item = store.get(key.toString('hex'));
      if (!item) {
        const error = new Error('NotFound') as Error & { code?: string; notFound?: boolean };
        error.code = 'LEVEL_NOT_FOUND';
        error.notFound = true;
        throw error;
      }
      return Buffer.from(item.value);
    },
    batch: () => ({
      put: (key: Buffer, value: Buffer) => {
        store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
      },
      del: (key: Buffer) => {
        store.delete(key.toString('hex'));
      },
      write: async () => {},
    }),
    keys: async function* (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) {
      const ordered = Array.from(store.values()).map((item) => item.key).sort(Buffer.compare);
      if (options?.reverse) ordered.reverse();
      for (const key of ordered) {
        if (options?.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options?.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
};

const entityDoc = (height: number): StorageEntityCoreDoc => ({
  entityId,
  height,
  timestamp: height,
  messages: [],
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [entityId],
    shares: { [entityId]: 1n },
  },
  reserves: new Map([[1, BigInt(height)]]),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: {
    name: `entity-${height}`,
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const entityDiff = (height: number): StorageDiffRecord => {
  const doc: StorageDoc = { family: 'entity', entityId, value: entityDoc(height) };
  return { height, puts: [doc], dels: [] };
};

const accountId = (prefix: string): string => `0x${prefix.padEnd(64, '0')}`;

const accountDoc = (counterpartyId: string, version: number): StorageAccountDoc => ({
  rightEntity: counterpartyId,
  currentHeight: version,
} as unknown as StorageAccountDoc);

const accountPut = (counterpartyId: string, version: number): StorageDoc => ({
  family: 'account',
  entityId,
  counterpartyId,
  value: accountDoc(counterpartyId, version),
});

const merkleEntries = (prepared: PreparedStorageHashes): Array<[Buffer, Buffer]> =>
  prepared.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]);

const applyMerkleDiff = (
  entries: Array<[Buffer, Buffer]>,
  prepared: PreparedStorageHashes,
): Array<[Buffer, Buffer]> => {
  const rows = new Map<string, [Buffer, Buffer]>();
  for (const [key, value] of entries) rows.set(key.toString('hex'), [Buffer.from(key), Buffer.from(value)]);
  for (const key of prepared.merkleDels) rows.delete(key.toString('hex'));
  for (const put of prepared.merklePuts) rows.set(put.key.toString('hex'), [Buffer.from(put.key), Buffer.from(put.value)]);
  return Array.from(rows.values()).sort(([left], [right]) => Buffer.compare(left, right));
};

const entityHash = (prepared: PreparedStorageHashes): string =>
  prepared.entityHashDocs.get(entityId)?.hash ?? '';

const expectNoMerklePutDeleteOverlap = (prepared: PreparedStorageHashes): void => {
  const putKeys = new Set(prepared.merklePuts.map((item) => item.key.toString('hex')));
  expect(prepared.merkleDels.some((key) => putKeys.has(key.toString('hex')))).toBe(false);
};

const head = (latestHeight: number, latestMaterializedHeight: number): StorageHead => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  latestHeight,
  latestMaterializedHeight,
  latestSnapshotHeight: 0,
  snapshotPeriodFrames: config.snapshotPeriodFrames,
  retainSnapshots: config.retainSnapshots,
  epochMaxBytes: config.epochMaxBytes,
  accountMerkleRadix: config.accountMerkleRadix,
  retainedHistoryBytes: 0,
});

describe('storage crash recovery', () => {
  test('copies immutable certified-board nodes before publishing recovered current head', async () => {
    const stackKey = getCertifiedBoardStackKey({
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      entityProviderAddress: `0x${'22'.repeat(20)}`,
    });
    const update = putCertifiedBoardRecord(new Map(), EMPTY_CERTIFIED_BOARD_ROOT, {
      stackKey,
      entityId,
      boardHash: `0x${'33'.repeat(32)}`,
      boardEpoch: 0,
      previousBoardHash: `0x${'00'.repeat(32)}`,
      previousBoardValidUntil: 0,
      activatedAtJHeight: 1,
      logIndex: 0,
      blockHash: `0x${'44'.repeat(32)}`,
      transactionHash: `0x${'55'.repeat(32)}`,
      source: 'EntityRegistered',
    });
    const [nodeHash, node] = [...update.newNodes][0]!;
    const currentDb = makeMemoryDb();
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(1, 0))],
      [keyCertifiedBoardNode(nodeHash), encodeBuffer(node)],
    ]);
    await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
    expect(decodeBuffer(await currentDb.get(keyCertifiedBoardNode(nodeHash)))).toEqual(node);
    expect(decodeBuffer<StorageHead>(await currentDb.get(KEY_HEAD)).latestHeight).toBe(1);
  });

  test('recovers committed consumption witnesses before publishing current head', async () => {
    const inserted = applyConsumptionOutput(createEmptyConsumptionAccumulator(), {
      targetEntityId: entityId,
      sourceEntityId: `0x${'22'.repeat(32)}`,
      lane: 'generic',
      sequence: 1,
      semanticHash: `0x${'33'.repeat(32)}`,
      outputHash: `0x${'44'.repeat(32)}`,
      outputHanko: '0x01',
    }, { version: 2, nodes: [] });
    const node = inserted.newNodes[0]!;
    const stale = applyConsumptionOutput(createEmptyConsumptionAccumulator(), {
      targetEntityId: entityId,
      sourceEntityId: `0x${'55'.repeat(32)}`,
      lane: 'generic',
      sequence: 1,
      semanticHash: `0x${'66'.repeat(32)}`,
      outputHash: `0x${'77'.repeat(32)}`,
      outputHanko: '0x02',
    }, { version: 2, nodes: [] }).newNodes[0]!;
    const currentDb = makeMemoryDb([[keyConsumptionNode(stale.hash), encodeBuffer(stale.node)]]);
    const core = entityDoc(1);
    core.consumptionAccumulator = inserted.state;
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(1, 1))],
      [keyDiff(1), encodeBuffer({
        height: 1,
        puts: [{ family: 'entity', entityId, value: core }],
        dels: [],
      } satisfies StorageDiffRecord)],
      [keyConsumptionNode(node.hash), encodeBuffer(node.node)],
    ]);

    await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
    expect(decodeBuffer(await currentDb.get(keyConsumptionNode(node.hash)))).toEqual(node.node);
    await expect(currentDb.get(keyConsumptionNode(stale.hash))).rejects.toMatchObject({
      code: 'LEVEL_NOT_FOUND',
    });
    expect(decodeBuffer<StorageHead>(await currentDb.get(KEY_HEAD)).latestHeight).toBe(1);
  });

  test('hydrates the complete reachable consumption DAG and rejects an incomplete restore', async () => {
    const firstIdentity = {
      targetEntityId: entityId,
      sourceEntityId: `0x${'22'.repeat(32)}`,
      lane: 'generic' as const,
      sequence: 1,
      semanticHash: `0x${'33'.repeat(32)}`,
      outputHash: `0x${'44'.repeat(32)}`,
      outputHanko: '0x01',
    };
    const first = applyConsumptionOutput(
      createEmptyConsumptionAccumulator(),
      firstIdentity,
      { version: 2, nodes: [] },
    );
    const firstStore = new Map(first.newNodes.map(({ hash, node }) => [hash, node]));
    const secondIdentity = {
      ...firstIdentity,
      sourceEntityId: `0x${'55'.repeat(32)}`,
      semanticHash: `0x${'66'.repeat(32)}`,
      outputHash: `0x${'77'.repeat(32)}`,
      outputHanko: '0x02',
    };
    const second = applyConsumptionOutput(
      first.state,
      secondIdentity,
      createConsumptionProof(firstStore, first.state.root, getConsumptionKey(secondIdentity)),
    );
    const nodes = [...first.newNodes, ...second.newNodes];
    const db = makeMemoryDb(nodes.map(({ hash, node }) => [keyConsumptionNode(hash), encodeBuffer(node)]));
    const env = createEmptyEnv('consumption storage hydrate');

    await hydrateConsumptionRootNodesFromStorage(env, db, second.state);
    expect(getConsumptionNodeStore(env).size).toBe(3);
    const membership = createConsumptionProof(
      getConsumptionNodeStore(env),
      second.state.root,
      getConsumptionKey(firstIdentity),
    );
    expect(verifyConsumptionProof(second.state.root, getConsumptionKey(firstIdentity), membership).status)
      .toBe('member');

    const incompleteDb = makeMemoryDb(nodes.slice(1).map(({ hash, node }) => [
      keyConsumptionNode(hash),
      encodeBuffer(node),
    ]));
    await expect(hydrateConsumptionRootNodesFromStorage(
      createEmptyEnv('consumption storage missing'),
      incompleteDb,
      second.state,
    )).rejects.toThrow('CONSUMPTION_NODE_MISSING');
  });

  test('replays materialized diffs into current DB and catches up head from history DB', async () => {
    const diff1 = entityDiff(1);
    const diff2 = entityDiff(2);
    const currentDb = makeMemoryDb();
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(3, 2))],
      [keyDiff(1), encodeBuffer(diff1)],
      [keyDiff(2), encodeBuffer(diff2)],
    ]);

    const result = await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
    expect(result.recovered).toBe(true);

    const recoveredHead = decodeBuffer<StorageHead>(await currentDb.get(KEY_HEAD));
    expect(recoveredHead.latestHeight).toBe(3);
    expect(recoveredHead.latestMaterializedHeight).toBe(2);

    const recoveredDoc = decodeBuffer<StorageEntityCoreDoc>(await currentDb.get(liveKeyForDoc(diff2.puts[0]!)));
    expect(recoveredDoc.height).toBe(2);
    expect(recoveredDoc.profile.name).toBe('entity-2');
  });

  test('rejects current DB state that is ahead of authoritative history DB', async () => {
    const currentDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(4, 4))]]);
    const historyDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(3, 3))]]);

    await expect(recoverStorageDbFromHistory({ db: currentDb, historyDb, config }))
      .rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_HISTORY');
  });

  test('frame DB activity rows and head can be committed by the caller batch', async () => {
    const historyDb = makeMemoryDb();
    const puts = buildFrameDbPuts({
      height: 7,
      timestamp: 700,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{ id: 1, category: 'system', level: 'info', message: 'durable', timestamp: 700 }],
      touchedEntities: [entityId],
      touchedAccounts: [],
      touchedBookEntities: [],
      frameDbRecords: [],
    });
    const plan = await prepareFrameDbCommit({ db: historyDb, height: 7, puts, config });
    const batch = historyDb.batch();
    putFrameDbCommit(batch, plan);
    await batch.write();

    const activity = await readFrameDbRuntimeActivity(historyDb, 7);
    expect(activity?.logs[0]?.message).toBe('durable');

    const frameHead = await readFrameDbHead(historyDb, config);
    expect(frameHead.latestHeight).toBe(7);
    expect(frameHead.retainedBytes).toBe(plan.writtenBytes);
  });

  test('storage hash preparation remains usable on recovered live docs', async () => {
    const diff1 = entityDiff(1);
    const diff2 = entityDiff(2);
    const currentDb = makeMemoryDb();
    const historyDb = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head(2, 2))],
      [keyDiff(1), encodeBuffer(diff1)],
      [keyDiff(2), encodeBuffer(diff2)],
    ]);

    const result = await recoverStorageDbFromHistory({ db: currentDb, historyDb, config });
    const diff3 = entityDiff(3);
    const prepared = await prepareStorageStateHashes({
      db: currentDb,
      puts: diff3.puts,
      dels: [],
      ...(result.entityHashDocs ? { entityHashDocs: result.entityHashDocs } : {}),
    });

    expect(prepared.entityHashes).toHaveLength(1);
    expect(prepared.entityHashes[0]?.entityId).toBe(entityId);
  });

  test('merkle flush diff cancels split then collapse in one frame', async () => {
    const left = accountId('1');
    const right = accountId('2');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(left, 1)],
      dels: [],
    });

    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(right, 1)],
      dels: [{ family: 'account', entityId, counterpartyId: right }],
    });

    expect(entityHash(prepared)).toBe(entityHash(initial));
    expect(prepared.entityHashDocs.get(entityId)?.cellCount).toBe(1);
    expect(prepared.merkleDels).toHaveLength(0);
    expectNoMerklePutDeleteOverlap(prepared);
  });

  test('merkle flush diff handles collapse then split without deleting surviving leaves', async () => {
    const survivor = accountId('1');
    const removed = accountId('2');
    const addedUnderSurvivorPrefix = accountId('12');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(survivor, 1), accountPut(removed, 1)],
      dels: [],
    });

    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(addedUnderSurvivorPrefix, 1)],
      dels: [{ family: 'account', entityId, counterpartyId: removed }],
    });
    const reference = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(survivor, 1), accountPut(addedUnderSurvivorPrefix, 1)],
      dels: [],
    });

    expect(entityHash(prepared)).toBe(entityHash(reference));
    expect(prepared.entityHashDocs.get(entityId)?.cellCount).toBe(2);
    expect(prepared.merkleDels.length).toBeGreaterThan(0);
    expectNoMerklePutDeleteOverlap(prepared);
  });

  test('merkle editor can flush, reload from db, and continue to the same root', async () => {
    const a = accountId('1');
    const b = accountId('2');
    const c = accountId('3');
    const d = accountId('31');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(a, 1), accountPut(b, 1), accountPut(c, 1)],
      dels: [],
    });
    const first = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(a, 2)],
      dels: [{ family: 'account', entityId, counterpartyId: b }],
    });
    const afterFirstEntries = applyMerkleDiff(merkleEntries(initial), first);

    const second = await prepareStorageStateHashes({
      db: makeMemoryDb(afterFirstEntries),
      puts: [accountPut(c, 2), accountPut(d, 1)],
      dels: [],
    });
    const reference = await prepareStorageStateHashes({
      db: makeMemoryDb(merkleEntries(initial)),
      puts: [accountPut(a, 2), accountPut(c, 2), accountPut(d, 1)],
      dels: [{ family: 'account', entityId, counterpartyId: b }],
    });

    expect(entityHash(second)).toBe(entityHash(reference));
    expect(second.entityHashDocs.get(entityId)?.cellCount).toBe(3);
    expectNoMerklePutDeleteOverlap(first);
    expectNoMerklePutDeleteOverlap(second);
  });

  test('incremental merkle edit rejects a corrupted persisted branch hash', async () => {
    const a = accountId('1');
    const b = accountId('2');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(a, 1), accountPut(b, 1)],
      dels: [],
    });
    const corrupted = merkleEntries(initial).map(([key, value]) => {
      if (key[0] !== KEY_MERKLE_BRANCH) return [key, value] as [Buffer, Buffer];
      const branch = decodeBuffer<StorageMerkleBranchDoc>(value);
      return [key, encodeBuffer({ ...branch, hash: `0x${'ff'.repeat(32)}` })] as [Buffer, Buffer];
    });

    await expect(prepareStorageStateHashes({
      db: makeMemoryDb(corrupted),
      puts: [accountPut(a, 2)],
      dels: [],
    })).rejects.toThrow('STORAGE_MERKLE_BRANCH_INTEGRITY_MISMATCH');
  });

  test('incremental merkle edit rejects a corrupted persisted leaf hash', async () => {
    const a = accountId('1');
    const b = accountId('2');
    const initial = await prepareStorageStateHashes({
      db: makeMemoryDb(),
      puts: [accountPut(a, 1), accountPut(b, 1)],
      dels: [],
    });
    const corrupted = merkleEntries(initial).map(([key, value]) => {
      if (key[0] !== KEY_MERKLE_LEAF) return [key, value] as [Buffer, Buffer];
      const leaf = decodeBuffer<StorageMerkleLeafDoc>(value);
      return [key, encodeBuffer({ ...leaf, hash: `0x${'ff'.repeat(32)}` })] as [Buffer, Buffer];
    });

    await expect(prepareStorageStateHashes({
      db: makeMemoryDb(corrupted),
      puts: [accountPut(a, 2)],
      dels: [],
    })).rejects.toThrow('STORAGE_MERKLE_LEAF_INTEGRITY_MISMATCH');
  });
});
