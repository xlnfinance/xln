import { describe, expect, test } from 'bun:test';

import {
  recoverStorageDbFromHistory,
  hydrateConsumptionRootNodesFromStorage,
} from '../../../storage';
import {
  buildHistoryViewPuts,
  prepareHistoryViewCommit,
  putHistoryViewCommit,
  readHistoryViewHead,
  readHistoryViewRuntimeActivity,
} from '../../../storage/history/history-view';
import { decodeBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { liveKeyForDoc } from '../../../storage/schema/doc-refs';
import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  keyCertifiedBoardNode,
  keyConsumptionNode,
} from '../../../storage/keys';
import type {
  RuntimeDbLike,
  StorageHead,
  StorageRuntimeConfig,
} from '../../../storage/types';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  getCertifiedBoardStackKey,
  putCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  verifyConsumptionProof,
} from '../../../entity/consumption/consumption-accumulator';
import { getConsumptionNodeStore } from '../../../entity/consumption/consumption-store';
import { createEmptyEnv } from '../../../runtime';

const entityId = `0x${'11'.repeat(32)}`;

const config: Required<StorageRuntimeConfig> = {
  enabled: true,
  snapshotPeriodFrames: 256,
  retainSnapshots: 3,
  epochMaxBytes: 1_000_000,
  historyViewMaxBytes: 1_000_000,
  historyViewRetainFrames: 128,
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

const head = (latestHeight: number, latestMaterializedHeight: number): StorageHead => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  latestHeight,
  latestMaterializedHeight,
  latestSnapshotHeight: 0,
  snapshotPeriodFrames: config.snapshotPeriodFrames,
  retainSnapshots: config.retainSnapshots,
  epochMaxBytes: config.epochMaxBytes,
  accountMerkleRadix: config.accountMerkleRadix,
  epochReplayBytes: 0,
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
    await recoverStorageDbFromHistory({ db: currentDb, walDb: historyDb, config });
    expect(decodeBuffer(await currentDb.get(keyCertifiedBoardNode(nodeHash)))).toEqual(node);
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
      { version: 1, nodes: [] },
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

  test('rejects current DB state that is ahead of authoritative history DB', async () => {
    const currentDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(4, 4))]]);
    const historyDb = makeMemoryDb([[KEY_HEAD, encodeBuffer(head(3, 3))]]);

    await expect(recoverStorageDbFromHistory({ db: currentDb, walDb: historyDb, config }))
      .rejects.toThrow('STORAGE_CURRENT_AHEAD_OF_HISTORY');
  });

  test('history-view activity rows and head can be committed by the caller batch', async () => {
    const historyDb = makeMemoryDb();
    const puts = buildHistoryViewPuts({
      height: 7,
      timestamp: 700,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{ id: 1, category: 'system', level: 'info', message: 'durable', timestamp: 700 }],
      touchedEntities: [entityId],
      touchedAccounts: [],
      touchedBookEntities: [],
    });
    const plan = await prepareHistoryViewCommit({ db: historyDb, height: 7, puts, config });
    const batch = historyDb.batch();
    putHistoryViewCommit(batch, plan);
    await batch.write();

    const activity = await readHistoryViewRuntimeActivity(historyDb, 7);
    expect(activity?.logs[0]?.message).toBe('durable');

    const frameHead = await readHistoryViewHead(historyDb, config);
    expect(frameHead.latestHeight).toBe(7);
    expect(frameHead.retainedBytes).toBe(plan.writtenBytes);
  });

});
