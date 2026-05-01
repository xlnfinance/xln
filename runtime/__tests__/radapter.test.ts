import { expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { ethers } from 'ethers';

import {
  deriveRuntimeAdapterAuthKey,
  deriveRuntimeAdapterCapabilityToken,
  resolveRuntimeAdapterAuthSeed,
  verifyRuntimeAdapterAuthCredential,
  verifyRuntimeAdapterAuthKey,
} from '../radapter/auth';
import { decodeRuntimeAdapterMessage, encodeRuntimeAdapterMessage } from '../radapter/codec';
import { RemoteRuntimeAdapter } from '../radapter/remote';
import { resolveRuntimeAdapterRead } from '../radapter/resolve';
import { broadcastRuntimeAdapterTick, handleRuntimeAdapterMessage } from '../radapter/server';
import { decodeBuffer, encodeBuffer } from '../storage/codec';
import { prepareStorageStateHashes } from '../storage/hashes';
import {
  KEY_HEAD,
  hexBytes,
  keyLiveAccount,
  keyLiveEntity,
  keyMerkleLeafPrefix,
  keyMerkleRoot,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotManifest,
  textBytes,
} from '../storage/keys';
import { keyLiveDocHash } from '../storage/doc-refs';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import { loadEntityStateFromStorage, loadEntityViewPageFromStorage } from '../storage/read';
import type {
  RuntimeDbLike,
  StorageEntityHashDoc,
  StorageHead,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
  StorageSnapshotManifest,
} from '../storage/types';
import type { EntityReplica, Env } from '../types';
import type { BookState } from '../orderbook';
import { DEFAULT_SPREAD_DISTRIBUTION, type OrderbookExtState } from '../orderbook/types';

const entityId = `0x${'aa'.repeat(32)}`;
const counterpartyId = `0x${'bb'.repeat(32)}`;

const makeEnv = (): Env => ({
  height: 7,
  timestamp: 700,
  runtimeSeed: 'seed',
  eReplicas: new Map<string, EntityReplica>([
    [`${entityId}:signer`, {
      entityId,
      signerId: 'signer',
      mempool: [],
      isProposer: true,
      state: {
        entityId,
        height: 7,
        timestamp: 700,
        messages: [],
        nonces: new Map(),
        proposals: new Map(),
        config: { mode: 'proposer-based', threshold: 1n, validators: ['signer'], shares: { signer: 1n } },
        reserves: new Map([[1, 100n]]),
        accounts: new Map([
          [counterpartyId, {
            leftEntity: entityId,
            rightEntity: counterpartyId,
            status: 'active',
            mempool: [],
            currentFrame: {
              height: 1,
              timestamp: 700,
              jHeight: 0,
              accountTxs: [],
              prevFrameHash: 'genesis',
              stateHash: '0x1',
              deltas: [],
            },
            deltas: new Map(),
            locks: new Map(),
            swapOffers: new Map(),
            globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
            currentHeight: 1,
            pendingSignatures: [],
            rollbackCount: 0,
            proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nonce: 0 },
            proofBody: { tokenIds: [], deltas: [] },
            pendingWithdrawals: new Map(),
            requestedRebalance: new Map(),
            requestedRebalanceFeeState: new Map(),
            rebalancePolicy: new Map(),
            leftJObservations: [],
            rightJObservations: [],
            jEventChain: [],
            lastFinalizedJHeight: 0,
            disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
            onChainSettlementNonce: 0,
          }],
        ]),
        deferredAccountProposals: new Map(),
        lastFinalizedJHeight: 0,
        jBlockObservations: [],
        jBlockChain: [],
        entityEncPubKey: 'pub',
        entityEncPrivKey: 'priv',
        profile: { name: 'Adapter Test', isHub: false, avatar: '', bio: '', website: '' },
        htlcRoutes: new Map(),
        htlcFeesEarned: 0n,
        htlcNotes: new Map(),
        lockBook: new Map(),
        swapTradingPairs: [],
        pendingSwapFillRatios: new Map(),
      },
    } as EntityReplica],
  ]),
}) as Env;

const makeBook = (price: bigint): BookState => ({
  params: { bucketWidthTicks: 1n, maxOrders: 100, stpPolicy: 0 },
  orders: new Map(),
  bidBuckets: new Map([[price.toString(), { bucketId: price, pricesAsc: [price], levels: new Map() }]]),
  askBuckets: new Map([[(price + 1n).toString(), { bucketId: price + 1n, pricesAsc: [price + 1n], levels: new Map() }]]),
  bidBucketIdsDesc: [price],
  askBucketIdsAsc: [price + 1n],
  nextSeq: 1,
  tradeCount: 0,
  tradeQtySum: 0n,
  eventHash: 0n,
});

const makeOrderbookExt = (books: Map<string, BookState>): OrderbookExtState => ({
  books,
  orderPairs: new Map(),
  referrals: new Map(),
  hubProfile: {
    entityId,
    name: 'Adapter Test Hub',
    spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
    referenceTokenId: 1,
    minTradeSize: 0n,
    supportedPairs: Array.from(books.keys()),
  },
});

const makeMemoryDb = (entries: Array<[Buffer, Buffer]>): RuntimeDbLike => {
  const store = new Map<string, { key: Buffer; value: Buffer }>();
  const putValue = (key: Buffer, value: Buffer): void => {
    store.set(key.toString('hex'), { key: Buffer.from(key), value: Buffer.from(value) });
  };
  for (const [key, value] of entries) putValue(key, value);
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
    batch: () => {
      const puts: Array<[Buffer, Buffer]> = [];
      const dels: Buffer[] = [];
      return {
        put: (key: Buffer, value: Buffer) => {
          puts.push([Buffer.from(key), Buffer.from(value)]);
        },
        del: (key: Buffer) => {
          dels.push(Buffer.from(key));
        },
        write: async () => {
          for (const key of dels) store.delete(key.toString('hex'));
          for (const [key, value] of puts) putValue(key, value);
        },
      };
    },
    keys: async function* (options?: { gte?: Buffer; lt?: Buffer }) {
      const ordered = Array.from(store.values())
        .map((item) => item.key)
        .sort(Buffer.compare);
      for (const key of ordered) {
        if (options?.gte && Buffer.compare(key, options.gte) < 0) continue;
        if (options?.lt && Buffer.compare(key, options.lt) >= 0) continue;
        yield Buffer.from(key);
      }
    },
  };
};

const snapshotAccountKey = (height: number, entity: string, counterparty: string): Buffer =>
  Buffer.concat([keySnapshotAccountPrefix(height, entity), hexBytes(counterparty)]);

const snapshotBookKey = (height: number, entity: string, pairId: string): Buffer =>
  Buffer.concat([keySnapshotBookPrefix(height, entity), textBytes(pairId)]);

const docHashBytes = (raw: Buffer): Buffer =>
  Buffer.from(ethers.keccak256(raw).slice(2), 'hex');

const capabilityTokenUnchecked = (seed: string, role: 'read' | 'full', expiresAtMs: number): string => {
  const level = role === 'read' ? 'inspect' : 'admin';
  const signature = createHmac('sha256', seed)
    .update(`xln-radapter-v1:cap:${level}:${expiresAtMs}`)
    .digest('hex');
  return `xlnra1.${role}.${expiresAtMs}.${signature}`;
};

test('runtime adapter auth keys are scoped by level', () => {
  const inspect = deriveRuntimeAdapterAuthKey('seed', 'inspect');
  const admin = deriveRuntimeAdapterAuthKey('seed', 'admin');
  const readToken = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000);
  const fullToken = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
  expect(inspect).not.toBe(admin);
  expect(verifyRuntimeAdapterAuthKey('seed', inspect)).toBe('inspect');
  expect(verifyRuntimeAdapterAuthKey('seed', admin)).toBe('admin');
  expect(verifyRuntimeAdapterAuthCredential('seed', readToken)?.level).toBe('inspect');
  expect(verifyRuntimeAdapterAuthCredential('seed', fullToken)?.level).toBe('admin');
  expect(() => deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() - 1)).toThrow('RADAPTER_AUTH_EXPIRY_REQUIRED');
  expect(verifyRuntimeAdapterAuthKey('seed', `${admin.slice(0, -1)}0`)).toBe(null);
});

test('runtime adapter can require expiring capability tokens', () => {
  const previous = process.env['XLN_RADAPTER_REQUIRE_CAPABILITY'];
  process.env['XLN_RADAPTER_REQUIRE_CAPABILITY'] = '1';
  try {
    const legacy = deriveRuntimeAdapterAuthKey('seed', 'admin');
    const token = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
    expect(verifyRuntimeAdapterAuthCredential('seed', legacy)).toBe(null);
    expect(verifyRuntimeAdapterAuthCredential('seed', token)?.level).toBe('admin');
  } finally {
    if (previous === undefined) {
      delete process.env['XLN_RADAPTER_REQUIRE_CAPABILITY'];
    } else {
      process.env['XLN_RADAPTER_REQUIRE_CAPABILITY'] = previous;
    }
  }
});

test('runtime adapter can require explicit auth seed', () => {
  const previousRequireSeed = process.env['XLN_RADAPTER_REQUIRE_AUTH_SEED'];
  const previousAuthSeed = process.env['XLN_RADAPTER_AUTH_SEED'];
  process.env['XLN_RADAPTER_REQUIRE_AUTH_SEED'] = '1';
  try {
    delete process.env['XLN_RADAPTER_AUTH_SEED'];
    expect(resolveRuntimeAdapterAuthSeed(makeEnv())).toBe(null);
    process.env['XLN_RADAPTER_AUTH_SEED'] = 'explicit-auth-seed';
    expect(resolveRuntimeAdapterAuthSeed(makeEnv())).toBe('explicit-auth-seed');
  } finally {
    if (previousRequireSeed === undefined) {
      delete process.env['XLN_RADAPTER_REQUIRE_AUTH_SEED'];
    } else {
      process.env['XLN_RADAPTER_REQUIRE_AUTH_SEED'] = previousRequireSeed;
    }
    if (previousAuthSeed === undefined) {
      delete process.env['XLN_RADAPTER_AUTH_SEED'];
    } else {
      process.env['XLN_RADAPTER_AUTH_SEED'] = previousAuthSeed;
    }
  }
});

test('runtime adapter resolver reads live head and entity paths', async () => {
  const env = makeEnv();
  const head = await resolveRuntimeAdapterRead<{ latestHeight: number }>({ env }, 'head');
  const entities = await resolveRuntimeAdapterRead<Array<{ entityId: string; label: string }>>({ env }, 'entities');
  const entity = await resolveRuntimeAdapterRead<{ entityId: string; profile: { name: string } }>({ env }, `entity/${entityId}`);
  const accounts = await resolveRuntimeAdapterRead<{ items: Array<{ currentHeight: number }>; nextCursor: string | null }>(
    { env },
    `entity/${entityId}/accounts`,
  );

  expect(head.latestHeight).toBe(7);
  expect(entities).toEqual([{ entityId, label: 'Adapter Test', height: 7 }]);
  expect(entity.entityId).toBe(entityId);
  expect(entity.profile.name).toBe('Adapter Test');
  expect(accounts.items).toHaveLength(1);
  expect(accounts.items[0]?.currentHeight).toBe(1);
  expect(accounts.nextCursor).toBe(null);
});

test('runtime adapter resolver returns a bounded view frame for the app shell', async () => {
  const env = makeEnv();
  const frame = await resolveRuntimeAdapterRead<{
    height: number;
    entities: Array<{ entityId: string }>;
    activeEntityId: string | null;
    activeEntity: {
      core: { entityId: string; profile?: { name?: string } };
      accounts: { items: Array<{ leftEntity: string; rightEntity: string }>; nextCursor: string | null };
      books: { items: unknown[] };
    } | null;
  }>({ env }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });

  expect(frame.height).toBe(7);
  expect(frame.entities.map((entity) => entity.entityId)).toEqual([entityId]);
  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.activeEntity?.core.profile?.name).toBe('Adapter Test');
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.leftEntity).toBe(entityId);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
  expect(frame.activeEntity?.accounts.nextCursor).toBe(null);
  expect(frame.activeEntity?.books.items).toEqual([]);
});

test('runtime adapter view frame defaults to 10 accounts and cursor pagination', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const base = replica.state.accounts.get(counterpartyId)!;
  replica.state.accounts.clear();
  for (let i = 0; i < 12; i += 1) {
    const id = `0x${(i + 1).toString(16).padStart(64, '0')}`;
    replica.state.accounts.set(id, {
      ...base,
      rightEntity: id,
      proofHeader: { ...base.proofHeader, toEntity: id },
    });
  }

  const first = await resolveRuntimeAdapterRead<{
    activeEntity: { accounts: { items: Array<{ rightEntity: string }>; nextCursor: string | null } } | null;
  }>({ env }, 'view-frame');
  expect(first.activeEntity?.accounts.items).toHaveLength(10);
  expect(first.activeEntity?.accounts.nextCursor).toBe(`0x${'0a'.padStart(64, '0')}`);

  const second = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    nextCursor: string | null;
  }>({ env }, `entity/${entityId}/accounts`, { cursor: first.activeEntity?.accounts.nextCursor || undefined });
  expect(second.items).toHaveLength(2);
  expect(second.items.map((item) => item.rightEntity)).toEqual([
    `0x${'0b'.padStart(64, '0')}`,
    `0x${'0c'.padStart(64, '0')}`,
  ]);
  expect(second.nextCursor).toBe(null);
});

test('runtime adapter view frame honors the requested entity id', async () => {
  const env = makeEnv();
  const first = Array.from(env.eReplicas.values())[0]!;
  const secondEntityId = `0x${'cc'.repeat(32)}`;
  env.eReplicas.set(`${secondEntityId}:signer`, {
    ...first,
    entityId: secondEntityId,
    signerId: 'other-signer',
    state: {
      ...first.state,
      entityId: secondEntityId,
      accounts: new Map(),
      profile: { ...first.state.profile, name: 'Requested Entity' },
    },
  } as EntityReplica);

  const frame = await resolveRuntimeAdapterRead<{
    activeEntityId: string | null;
    activeEntity: { core: { entityId: string; profile?: { name?: string } } } | null;
  }>({ env }, 'view-frame', { entityId: secondEntityId });

  expect(frame.activeEntityId).toBe(secondEntityId);
  expect(frame.activeEntity?.core.entityId).toBe(secondEntityId);
  expect(frame.activeEntity?.core.profile?.name).toBe('Requested Entity');
});

test('runtime adapter historical view frame uses paged storage loader instead of full entity load', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  let fullLoadCalled = false;
  let pagedLoadCalled = false;

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: { accounts: { items: Array<{ rightEntity: string }> } } | null;
  }>({
    env,
    readHead: async () => ({
      schemaVersion: 1,
      latestHeight: 9,
      latestMaterializedHeight: 8,
      latestSnapshotHeight: 8,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 0,
    }),
    listEntityIdsAtHeight: async () => [entityId],
    loadEntityState: async () => {
      fullLoadCalled = true;
      return null;
    },
    loadEntityViewPage: async () => {
      pagedLoadCalled = true;
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: { items: [projectAccountDoc(account)], nextCursor: null },
        books: { items: [], nextCursor: null },
      };
    },
  }, 'view-frame', { atHeight: 8, accountsLimit: 1 });

  expect(pagedLoadCalled).toBe(true);
  expect(fullLoadCalled).toBe(false);
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
});

test('storage-backed historical view pages support desc account and book cursors', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const baseAccount = replica.state.accounts.get(counterpartyId)!;
  const snapshotHeight = 4;
  const latestHeight = 5;
  const accountIds = [1, 2, 3].map((value) => `0x${value.toString(16).padStart(64, '0')}`);
  const head: StorageHead = {
    schemaVersion: 1,
    latestHeight,
    latestMaterializedHeight: latestHeight,
    latestSnapshotHeight: snapshotHeight,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    retainedHistoryBytes: 0,
  };
  const manifest: StorageSnapshotManifest = { height: snapshotHeight, createdAt: 400, docCount: 6 };
  const core = projectEntityCoreDoc(replica.state, replica);
  const db = makeMemoryDb([
    [KEY_HEAD, encodeBuffer(head)],
    [keySnapshotManifest(snapshotHeight), encodeBuffer(manifest)],
    [keySnapshotEntity(snapshotHeight, entityId), encodeBuffer(core)],
    ...accountIds.map((id) => [
      snapshotAccountKey(snapshotHeight, entityId, id),
      encodeBuffer(projectAccountDoc({
        ...baseAccount,
        rightEntity: id,
        proofHeader: { ...baseAccount.proofHeader, toEntity: id },
      })),
    ] as [Buffer, Buffer]),
    [snapshotBookKey(snapshotHeight, entityId, '1/1'), encodeBuffer(makeBook(101n))],
    [snapshotBookKey(snapshotHeight, entityId, '1/2'), encodeBuffer(makeBook(102n))],
  ]);

  const first = await loadEntityViewPageFromStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    entityId,
    height: snapshotHeight,
    accountQuery: { limit: 2, sortDir: 'desc' },
    bookQuery: { limit: 1 },
  });
  expect(first?.accounts.items.map((item) => item.rightEntity)).toEqual([accountIds[2], accountIds[1]]);
  expect(first?.accounts.nextCursor).toBe(accountIds[1]);
  expect(first?.books.items.map((item) => item.pairId)).toEqual(['1/1']);
  expect(first?.books.nextCursor).toBe('1/1');

  const second = await loadEntityViewPageFromStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    entityId,
    height: snapshotHeight,
    accountQuery: { limit: 2, sortDir: 'desc', cursor: first?.accounts.nextCursor || undefined },
    bookQuery: { limit: 1, cursor: first?.books.nextCursor || undefined },
  });
  expect(second?.accounts.items.map((item) => item.rightEntity)).toEqual([accountIds[0]]);
  expect(second?.accounts.nextCursor).toBe(null);
  expect(second?.books.items.map((item) => item.pairId)).toEqual(['1/2']);
  expect(second?.books.nextCursor).toBe(null);
});

test('storage live recovery can verify stored doc hashes', async () => {
  const previous = process.env['XLN_STORAGE_VERIFY_DOC_HASHES'];
  process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] = '1';
  try {
    const env = makeEnv();
    const replica = Array.from(env.eReplicas.values())[0]!;
    const account = replica.state.accounts.get(counterpartyId)!;
    const head: StorageHead = {
      schemaVersion: 1,
      latestHeight: env.height,
      latestMaterializedHeight: env.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 0,
    };
    const coreRaw = encodeBuffer(projectEntityCoreDoc(replica.state, replica));
    const accountRaw = encodeBuffer(projectAccountDoc(account));
    const db = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), coreRaw],
      [keyLiveAccount(entityId, counterpartyId), accountRaw],
      [keyLiveDocHash({ family: 'entity', entityId }), docHashBytes(coreRaw)],
      [keyLiveDocHash({ family: 'account', entityId, counterpartyId }), docHashBytes(accountRaw)],
    ]);

    const state = await loadEntityStateFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
    });
    expect(state?.accounts.has(counterpartyId)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env['XLN_STORAGE_VERIFY_DOC_HASHES'];
    else process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] = previous;
  }
});

test('storage live recovery rejects corrupted doc hash side values', async () => {
  const previous = process.env['XLN_STORAGE_VERIFY_DOC_HASHES'];
  process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] = '1';
  try {
    const env = makeEnv();
    const replica = Array.from(env.eReplicas.values())[0]!;
    const account = replica.state.accounts.get(counterpartyId)!;
    const head: StorageHead = {
      schemaVersion: 1,
      latestHeight: env.height,
      latestMaterializedHeight: env.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 0,
    };
    const coreRaw = encodeBuffer(projectEntityCoreDoc(replica.state, replica));
    const accountRaw = encodeBuffer(projectAccountDoc(account));
    const db = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), coreRaw],
      [keyLiveAccount(entityId, counterpartyId), accountRaw],
      [keyLiveDocHash({ family: 'entity', entityId }), docHashBytes(coreRaw)],
      [keyLiveDocHash({ family: 'account', entityId, counterpartyId }), Buffer.alloc(32)],
    ]);

    await expect(loadEntityStateFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
    })).rejects.toThrow('STORAGE_DOC_HASH_MISMATCH');
  } finally {
    if (previous === undefined) delete process.env['XLN_STORAGE_VERIFY_DOC_HASHES'];
    else process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] = previous;
  }
});

test('storage live recovery can deep verify merkle side records', async () => {
  const previous = process.env['XLN_STORAGE_VERIFY_MERKLE'];
  process.env['XLN_STORAGE_VERIFY_MERKLE'] = 'deep';
  try {
    const env = makeEnv();
    const replica = Array.from(env.eReplicas.values())[0]!;
    const account = replica.state.accounts.get(counterpartyId)!;
    const coreDoc = projectEntityCoreDoc(replica.state, replica);
    const accountDoc = projectAccountDoc(account);
    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb([]),
      puts: [
        { family: 'entity', entityId, value: coreDoc },
        { family: 'account', entityId, counterpartyId, value: accountDoc },
      ],
      dels: [],
    });
    const head: StorageHead = {
      schemaVersion: 1,
      latestHeight: env.height,
      latestMaterializedHeight: env.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 0,
    };
    const entries: Array<[Buffer, Buffer]> = [
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
      [keyLiveAccount(entityId, counterpartyId), prepared.docValueBuffers.get(`a:${entityId}:${counterpartyId}`)!],
      ...prepared.docHashPuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
      ...prepared.entityHashPuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
      ...prepared.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ];
    const db = makeMemoryDb(entries);

    const state = await loadEntityStateFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
    });
    expect(state?.accounts.has(counterpartyId)).toBe(true);

    const leafEntry = entries.find(([key]) =>
      Buffer.compare(key.subarray(0, keyMerkleLeafPrefix(entityId, 'runtime-roots').length), keyMerkleLeafPrefix(entityId, 'runtime-roots')) === 0);
    const leaf = decodeBuffer<StorageMerkleLeafDoc>(leafEntry![1]);
    const corrupted = { ...leaf, hash: `0x${'ff'.repeat(32)}` };
    const corruptedDb = makeMemoryDb(entries.map(([key, value]) =>
      key === leafEntry![0] ? [key, encodeBuffer(corrupted)] as [Buffer, Buffer] : [key, value] as [Buffer, Buffer]));

    await expect(loadEntityStateFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => corruptedDb,
      entityId,
    })).rejects.toThrow('STORAGE_MERKLE_LEAF_HASH_MISMATCH');
  } finally {
    if (previous === undefined) delete process.env['XLN_STORAGE_VERIFY_MERKLE'];
    else process.env['XLN_STORAGE_VERIFY_MERKLE'] = previous;
  }
});

test('runtime adapter account pagination avoids full sort materialization', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const base = replica.state.accounts.get(counterpartyId)!;
  replica.state.accounts.clear();
  for (let i = 999; i >= 0; i -= 1) {
    const id = `0x${(i + 1).toString(16).padStart(64, '0')}`;
    replica.state.accounts.set(id, {
      ...base,
      rightEntity: id,
      proofHeader: { ...base.proofHeader, toEntity: id },
    });
  }

  const first = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    nextCursor: string | null;
  }>({ env }, `entity/${entityId}/accounts`, { limit: 3 });
  expect(first.items.map((item) => item.rightEntity)).toEqual([
    `0x${'01'.padStart(64, '0')}`,
    `0x${'02'.padStart(64, '0')}`,
    `0x${'03'.padStart(64, '0')}`,
  ]);
  expect(first.nextCursor).toBe(`0x${'03'.padStart(64, '0')}`);
});

test('runtime adapter books path is bounded and paged', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.orderbookExt = makeOrderbookExt(new Map(
    Array.from({ length: 12 }, (_, index) => [`1/${index + 1}`, makeBook(BigInt(100 + index))]),
  ));

  const books = await resolveRuntimeAdapterRead<{
    items: Array<{ pairId: string }>;
    nextCursor: string | null;
  }>({ env }, `entity/${entityId}/books`);
  expect(books.items).toHaveLength(10);
  expect(books.nextCursor).toBeTruthy();
});

test('runtime adapter binary codec preserves structured payloads', () => {
  const encoded = encodeRuntimeAdapterMessage({
    v: 1,
    id: 'send-1',
    op: 'send',
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: 'signer',
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: counterpartyId,
            tokenId: 1,
            amount: 1234567890123456789n,
            route: [entityId, counterpartyId],
            metadata: new Map([['purpose', 'radapter-binary-test']]),
            tags: new Set(['binary', 'codec']),
            bytes: new Uint8Array([1, 2, 3]),
          },
        }],
      }],
    },
  });
  const decoded = decodeRuntimeAdapterMessage<{
    input: { entityInputs: Array<{ entityTxs: Array<{ data: { amount: bigint; metadata: Map<string, string>; tags: Set<string>; bytes: Uint8Array } }> }> };
  }>(encoded);

  const data = decoded.input.entityInputs[0]?.entityTxs[0]?.data;
  expect(data?.amount).toBe(1234567890123456789n);
  expect(data?.metadata.get('purpose')).toBe('radapter-binary-test');
  expect(data?.tags.has('codec')).toBe(true);
  expect(Array.from(data?.bytes ?? [])).toEqual([1, 2, 3]);
});

test('runtime adapter rejects oversized wire messages before decoding', () => {
  const previous = process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
  process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = '4';
  try {
    expect(() => decodeRuntimeAdapterMessage(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/RADAPTER_MESSAGE_TOO_LARGE/);
  } finally {
    if (previous === undefined) {
      delete process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
    } else {
      process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = previous;
    }
  }
});

test('runtime adapter websocket handler gates reads behind inspect auth', async () => {
  const messages: unknown[] = [];
  const socket = { send: (message: unknown) => { messages.push(message); } };
  const env = makeEnv();

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-1', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const denied = decodeRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-1', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
    enqueueRuntimeInput: () => {},
  });
  const authed = decodeRuntimeAdapterMessage<{ ok: true; payload: { authLevel: string } }>(messages.pop());
  expect(authed.ok).toBe(true);
  expect(authed.payload.authLevel).toBe('inspect');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-2', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const read = decodeRuntimeAdapterMessage<{ ok: true; payload: { latestHeight: number } }>(messages.pop());
  expect(read.ok).toBe(true);
  expect(read.payload.latestHeight).toBe(7);
});

test('runtime adapter read rate limit is configurable', async () => {
  const previousBurst = process.env['XLN_RADAPTER_READ_BURST'];
  const previousRefill = process.env['XLN_RADAPTER_READ_PER_SEC'];
  process.env['XLN_RADAPTER_READ_BURST'] = '1';
  process.env['XLN_RADAPTER_READ_PER_SEC'] = '0.001';
  const messages: unknown[] = [];
  const socket = { send: (message: unknown) => { messages.push(message); } };
  const env = makeEnv();
  try {
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
      enqueueRuntimeInput: () => {},
    });
    messages.length = 0;

    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-1', op: 'read', path: 'head' }, env, {
      enqueueRuntimeInput: () => {},
    });
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-2', op: 'read', path: 'head' }, env, {
      enqueueRuntimeInput: () => {},
    });

    const first = decodeRuntimeAdapterMessage<{ ok: boolean }>(messages[0]);
    const second = decodeRuntimeAdapterMessage<{ ok: false; error: { code: string; retryAfterMs?: number } }>(messages[1]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error.code).toBe('E_RATE_LIMITED');
    expect(second.error.retryAfterMs).toBeGreaterThan(0);
  } finally {
    if (previousBurst === undefined) {
      delete process.env['XLN_RADAPTER_READ_BURST'];
    } else {
      process.env['XLN_RADAPTER_READ_BURST'] = previousBurst;
    }
    if (previousRefill === undefined) {
      delete process.env['XLN_RADAPTER_READ_PER_SEC'];
    } else {
      process.env['XLN_RADAPTER_READ_PER_SEC'] = previousRefill;
    }
  }
});

test('runtime adapter ticks only go to authenticated clients', async () => {
  const env = makeEnv();
  const unauthMessages: unknown[] = [];
  const inspectMessages: unknown[] = [];
  const unauthSocket = { send: (message: unknown) => { unauthMessages.push(message); } };
  const inspectSocket = { send: (message: unknown) => { inspectMessages.push(message); } };

  await handleRuntimeAdapterMessage(unauthSocket, { v: 1, id: 'read-unauth', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  unauthMessages.length = 0;

  await handleRuntimeAdapterMessage(inspectSocket, { v: 1, id: 'auth-inspect', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
    enqueueRuntimeInput: () => {},
  });
  inspectMessages.length = 0;

  broadcastRuntimeAdapterTick(env);

  expect(unauthMessages).toHaveLength(0);
  expect(inspectMessages).toHaveLength(1);
  const tick = decodeRuntimeAdapterMessage<{ op: string; height: number }>(inspectMessages[0]);
  expect(tick.op).toBe('tick');
  expect(tick.height).toBe(7);
});

test('runtime adapter drops expired clients before broadcasting ticks', async () => {
  const env = makeEnv();
  const messages: unknown[] = [];
  const socket = { send: (message: unknown) => { messages.push(message); } };
  const expiredToken = capabilityTokenUnchecked('seed', 'read', Date.now() - 1);

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-expired', op: 'auth', key: expiredToken }, env, {
    enqueueRuntimeInput: () => {},
  });
  const denied = decodeRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.error.code).toBe('E_UNAUTHORIZED');

  const liveToken = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 5);
  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-live', op: 'auth', key: liveToken }, env, {
    enqueueRuntimeInput: () => {},
  });
  messages.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 10));
  broadcastRuntimeAdapterTick(env);
  expect(messages).toHaveLength(0);
});

test('runtime adapter caps outgoing responses and closes oversized sockets', async () => {
  const previous = process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
  process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = '512';
  const messages: unknown[] = [];
  let closeCode: number | undefined;
  const socket = {
    send: (message: unknown) => { messages.push(message); },
    close: (code?: number) => { closeCode = code; },
  };
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.profile = { ...replica.state.profile, bio: 'x'.repeat(4_000) };
  try {
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth', op: 'auth', key: deriveRuntimeAdapterAuthKey('seed', 'inspect') }, env, {
      enqueueRuntimeInput: () => {},
    });
    messages.length = 0;
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'big-read', op: 'read', path: `entity/${entityId}` }, env, {
      enqueueRuntimeInput: () => {},
    });
    const response = decodeRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages[0]);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('E_INTERNAL');
    expect(closeCode).toBe(1009);
  } finally {
    if (previous === undefined) {
      delete process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
    } else {
      process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = previous;
    }
  }
});

test('storage entity hash docs avoid serializing huge cell arrays', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const base = replica.state.accounts.get(counterpartyId)!;
  const accountCount = 4_100;
  const puts = Array.from({ length: accountCount }, (_, index) => {
    const id = `0x${(index + 1).toString(16).padStart(64, '0')}`;
    return {
      family: 'account' as const,
      entityId,
      counterpartyId: id,
      value: projectAccountDoc({
        ...base,
        rightEntity: id,
        proofHeader: { ...base.proofHeader, toEntity: id },
      }),
    };
  });

  const first = await prepareStorageStateHashes({
    db: makeMemoryDb([]),
    puts,
    dels: [],
  });
  const firstDoc = first.entityHashDocs.get(entityId)!;
  const stored = decodeBuffer<StorageEntityHashDoc>(first.entityHashPuts[0]!.value);

  expect(firstDoc.cellCount).toBe(accountCount);
  expect(firstDoc.cells).toHaveLength(0);
  expect(stored.cellCount).toBe(accountCount);
  expect(stored.cells).toHaveLength(0);
  expect(first.entityHashes[0]?.cellCount).toBe(accountCount);
  const firstRootPut = first.merklePuts.find((item) => Buffer.compare(item.key, keyMerkleRoot(entityId, 'runtime-roots')) === 0);
  const firstRoot = decodeBuffer<StorageMerkleRootDoc>(firstRootPut!.value);
  expect(firstRoot.rootHash).toBe(firstDoc.hash);
  expect(firstRoot.leafCount).toBe(accountCount);

  const oldRoot = firstDoc.hash;
  const changedId = `0x${(2_001).toString(16).padStart(64, '0')}`;
  const second = await prepareStorageStateHashes({
    db: makeMemoryDb([]),
    puts: [{
      family: 'account',
      entityId,
      counterpartyId: changedId,
      value: projectAccountDoc({
        ...base,
        rightEntity: changedId,
        currentHeight: 999,
        proofHeader: { ...base.proofHeader, toEntity: changedId },
      }),
    }],
    dels: [],
    entityHashDocs: first.entityHashDocs,
  });
  const secondDoc = second.entityHashDocs.get(entityId)!;

  expect(secondDoc.cellCount).toBe(accountCount);
  expect(secondDoc.cells).toHaveLength(0);
  expect(secondDoc.hash).not.toBe(oldRoot);
  expect(second.merklePuts.length).toBeLessThan(50);
  expect(second.merkleDels).toHaveLength(0);
});

test('remote runtime adapter does not reconnect after unauthorized auth', async () => {
  const previousWebSocket = globalThis.WebSocket;
  let constructed = 0;

  class RejectingAuthWebSocket {
    static readonly OPEN = 1;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      constructed += 1;
      setTimeout(() => {
        this.readyState = RejectingAuthWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(raw: unknown): void {
      const request = decodeRuntimeAdapterMessage<{ id: string; op: string }>(raw);
      if (request.op !== 'auth') return;
      setTimeout(() => {
        this.onmessage?.({
          data: encodeRuntimeAdapterMessage({
            v: 1,
            inReplyTo: request.id,
            ok: false,
            error: {
              code: 'E_UNAUTHORIZED',
              message: 'bad auth',
              retryable: false,
            },
          }),
        });
      }, 0);
    }

    close(): void {
      this.readyState = 3;
      setTimeout(() => this.onclose?.(), 0);
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = RejectingAuthWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    await adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://runtime-adapter.invalid/rpc',
      authKey: 'wrong',
      reconnectMaxMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(adapter.status).toBe('error');
    expect(adapter.authLevel).toBe(null);
    expect(constructed).toBe(1);
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
  }
});
