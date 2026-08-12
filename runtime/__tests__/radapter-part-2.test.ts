import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

import { createHmac } from 'crypto';
import { computeAddress, hexlify, keccak256, recoverAddress, SigningKey, toUtf8Bytes } from 'ethers';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claims/j-claim-accumulator';

import {
  deriveRuntimeAdapterCapabilityToken,
  resolveRuntimeAdapterAuthSeed,
  verifyRuntimeAdapterAuthCredential,
  verifyRuntimeAdapterAuthKey,
} from '../api/runtime-adapter/auth';

import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
  runtimeAdapterMaxMessageBytes,
} from '../api/runtime-adapter/codec';

import { EmbeddedRuntimeAdapter } from '../api/runtime-adapter/embedded';
import { registerRuntimePublishedCallback } from '../runtime/loop/loop-environment.ts';
import { notifyRuntimeStateChanged } from '../runtime/frame/notifications';
import { acquireRuntimeFrameWriter } from '../runtime/frame/writer-lock';

import { RemoteRuntimeAdapter } from '../api/runtime-adapter/remote';

import { verifyRuntimeAdapterServerIdentity } from '../api/runtime-adapter/server-identity';

import { buildRuntimeAdapterOwnerBindingDigest } from '../api/runtime-adapter/owner-binding';

import { signRuntimeAdapterServerIdentity } from '../api/runtime-adapter/server-identity-signer';

import {
  assertRuntimeAdapterGraphFrameWireBudget,
  resolveRuntimeAdapterRead,
  type RuntimeAdapterGraphFrame,
} from '../api/runtime-adapter/resolve';

import { decryptRuntimeRecoveryBundle, deriveRuntimeRecoveryLookupKey } from '../storage/recovery/crypto';

import { broadcastRuntimeAdapterTick, handleRuntimeAdapterMessage } from '../api/runtime-adapter/server';

import {
  applyRuntimeAdapterCommandMarker,
  MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES,
} from '../runtime/command-frontier';

import { decodeBuffer, encodeBuffer } from '../storage/codec';

import { prepareAccountStorageLayout } from '../storage/account-layout';

import { MAX_PERSISTED_MERKLE_NODE_BYTES, prepareStorageStateHashes } from '../storage/hashes';

import { verifyLiveStorageIntegrity } from '../storage/live-integrity';

import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  hexBytes,
  keyLiveAccount,
  keyLiveEntity,
  keyMerkleBranchPrefix,
  keyMerkleLeafPrefix,
  keyMerkleRoot,
  keySnapshotAccountPrefix,
  keySnapshotBookPrefix,
  keySnapshotEntity,
  keySnapshotManifest,
  normalizeEntityId,
  textBytes,
} from '../storage/keys';

import { projectAccountDoc, projectEntityCoreDoc, projectEntityReplicaCoreView } from '../storage/projections';

import { withRebranchedValues } from '../storage/rebranched-db';

import {
  loadEntityAccountDocFromStorage,
  loadEntityStateFromStorage,
  loadEntityViewPageFromStorage,
} from '../storage/read';

import type {
  RuntimeDbLike,
  StorageEntityHashDoc,
  RuntimeFrame,
  StorageHead,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
  StorageSnapshotManifest,
} from '../storage/types';

import type { AccountTx, Delta } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityReplica } from '../entity/types';
import type { RuntimeReplica, RuntimeInput } from '../runtime/types';

import type { BookState } from '../orderbook';

import { DEFAULT_SPREAD_DISTRIBUTION, type OrderbookExtState } from '../orderbook/types';

import { createGossipLayer } from '../network/p2p/gossip';
import type { Profile } from '../entity/profile';
import { registerStructuredLogSink } from '../infra/logger';

import { deriveSignerAddressSync, deriveSignerKeySync } from '../account/crypto';

import { buildCryptographicProfileFixture } from './helpers/cryptographic-profile';

const entityId = `0x${'aa'.repeat(32)}`;

const counterpartyId = `0x${'bb'.repeat(32)}`;

const adapterAuthChallenge = `0x${'41'.repeat(32)}`;

process.env['XLN_RADAPTER_AUTH_SEED'] = process.env['XLN_RADAPTER_AUTH_SEED'] || 'seed';

const decodeTestRuntimeAdapterMessage = <T>(raw: unknown): T =>
  (typeof raw === 'string'
    ? decodeRuntimeAdapterBrowserMessage(raw)
    : decodeRuntimeAdapterMessage(raw)) as unknown as T;

const makeHubProfile = (id: string, name: string, lastUpdated = 7): Profile =>
  buildCryptographicProfileFixture({
    entityId: id,
    signingSeed: `radapter-live-profile:${id}:${name}`,
    name,
    lastUpdated,
    runtimeId: `runtime:${name.toLowerCase()}`,
    runtimeEncPubKey: `0x${'11'.repeat(32)}`,
    isHub: true,
    jurisdiction: {
      name: 'Testnet',
      chainId: 31337,
      entityProviderAddress: '0x0000000000000000000000000000000000000001',
      depositoryAddress: '0x0000000000000000000000000000000000000002',
    },
  });

const makeEnv = (): RuntimeReplica =>
  ({
    state: {
      height: 7,
      timestamp: 700,
      jReplicas: new Map(),
      eReplicas: new Map<string, EntityReplica>([
        [
          `${entityId}:signer`,
          {
            entityId,
            signerId: 'signer',
            entityEncPubKey: 'pub',
            mempool: [],
            isProposer: true,
            state: {
              entityId,
              height: 7,
              timestamp: 700,
              nonces: new Map(),
              proposals: new Map(),
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: ['signer'],
                shares: { signer: 1n },
                jurisdiction: {
                  address: '0x0000000000000000000000000000000000000002',
                  name: 'Testnet',
                  chainId: 31337,
                  entityProviderAddress: '0x0000000000000000000000000000000000000001',
                  depositoryAddress: '0x0000000000000000000000000000000000000002',
                },
              },
              reserves: new Map([[1, 100n]]),
              accounts: new Map([
                [
                  counterpartyId,
                  {
                    state: {
                      leftEntity: entityId,
                      rightEntity: counterpartyId,
                      domain: {
                        chainId: 31337,
                        depositoryAddress: '0x0000000000000000000000000000000000000002',
                      },
                      watchSeed: `0x${'34'.repeat(32)}`,
                      deltas: new Map(),
                      locks: new Map(),
                      swapOffers: new Map(),
                      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
                      requestedRebalance: new Map(),
                      requestedRebalanceFeeState: new Map(),
                      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
                      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
                      lastFinalizedJHeight: 0,
                      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
                      jNonce: 0,
                    },
                    status: 'active',
                    mempool: [],
                    currentFrame: {
                      height: 1,
                      timestamp: 700,
                      jHeight: 0,
                      accountTxs: [],
                      prevFrameHash: 'genesis',
                      stateHash: '0x3ac8cd1532f1e010bb75ac9d5618680f0676e843b0fba7f9a81e3d13b61f670d',
                      accountStateRoot: `0x${'01'.repeat(32)}`,
                      deltas: [],
                      byLeft: true,
                    },
                    currentHeight: 1,
                    pendingSignatures: [],
                    rollbackCount: 0,
                    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
                    proofBody: { tokenIds: [], deltas: [] },
                    pendingWithdrawals: new Map(),
                    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
                  },
                ],
              ]),
              deferredAccountProposals: new Map(),
              lastFinalizedJHeight: 0,
              jBlockChain: [],
              profile: { name: 'Adapter Test', isHub: false, avatar: '', bio: '', website: '' },
              htlcRoutes: new Map(),
              htlcFeesEarned: 0n,
              lockBook: new Map(),
              swapTradingPairs: [],
            },
          } as EntityReplica,
        ],
      ]),
    },
    runtimeSeed: 'seed',
    infrastructure: {
      lifecyclePhase: 'running',
      loopActive: true,
    },
  }) as RuntimeReplica;

const makeBook = (_price: bigint): BookState => ({
  params: { bucketWidthTicks: 1n, maxOrders: 100, stpPolicy: 0 },
  orders: new Map(),
  bidBuckets: new Map(),
  askBuckets: new Map(),
  bidBucketIdsDesc: [],
  askBucketIdsAsc: [],
  nextSeq: 1,
  tradeCount: 0,
  tradeQtySum: 0n,
  lastTradePriceTicks: 0n,
  lastAcceptedUsdAskPriceTicks: 0n,
  eventHash: 0n,
});

const makeCrowdedBidLevelBook = (price: bigint, orderCount: number): BookState => {
  const orderIds = Array.from({ length: orderCount }, (_, index) => `order-${index.toString().padStart(2, '0')}`);
  const orders = new Map(
    orderIds.map((orderId, index) => [
      orderId,
      {
        orderId,
        ownerId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
        side: 0 as const,
        priceTicks: price,
        qtyLots: 1n,
        seq: index + 1,
        bucketId: price,
      },
    ]),
  );
  return {
    ...makeBook(price),
    orders,
    bidBuckets: new Map([
      [
        price.toString(),
        {
          bucketId: price,
          pricesAsc: [price],
          levels: new Map([
            [
              price.toString(),
              {
                priceTicks: price,
                orderIds,
                totalQtyLots: BigInt(orderCount),
              },
            ],
          ]),
        },
      ],
    ]),
    bidBucketIdsDesc: [price],
    nextSeq: orderCount + 1,
  };
};

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

const makeTestDelta = (tokenId: number, value: bigint): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: value,
  offdelta: 0n,
  leftCreditLimit: 1_000_000n,
  rightCreditLimit: 1_000_000n,
  leftAllowance: 0n,
  rightAllowance: 0n,
});

const compareAscii = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const readTestPageLimit = (raw: unknown, fallback = 10): number => {
  const numeric = Number(raw ?? fallback);
  return Math.max(1, Math.min(500, Number.isFinite(numeric) ? Math.floor(numeric) : fallback));
};

const makeTestViewPageLoader =
  (env: RuntimeReplica) =>
  async (
    requestedEntityId: string,
    height: number,
    query?: {
      limit?: number;
      cursor?: string;
      accountsLimit?: number;
      accountsCursor?: string;
      booksLimit?: number;
      booksCursor?: string;
      sortDir?: 'asc' | 'desc';
    },
  ) => {
    const normalizedEntityId = String(requestedEntityId).toLowerCase();
    const replica = Array.from(env.state.eReplicas.values()).find(
      item => String(item.entityId).toLowerCase() === normalizedEntityId,
    );
    if (!replica || height !== env.state.height) return null;
    const accountLimit = readTestPageLimit(query?.accountsLimit ?? query?.limit, 10);
    const accountCursor = String(query?.accountsCursor ?? query?.cursor ?? '').toLowerCase();
    const accountDirection = query?.sortDir === 'desc' ? 'desc' : 'asc';
    const accountIds = Array.from(replica.state.accounts.keys())
      .map(id => String(id).toLowerCase())
      .sort((left, right) => (accountDirection === 'desc' ? compareAscii(right, left) : compareAscii(left, right)))
      .filter(id => !accountCursor || (accountDirection === 'desc' ? id < accountCursor : id > accountCursor));
    const visibleAccountIds = accountIds.slice(0, accountLimit);
    const bookLimit = readTestPageLimit(query?.booksLimit ?? query?.limit, 10);
    const bookCursor = String(query?.booksCursor ?? '').trim();
    const bookPairs = Array.from(replica.state.orderbookExt?.books?.entries?.() ?? [])
      .map(([pairId, book]) => [String(pairId), book] as [string, BookState])
      .sort((left, right) => compareAscii(left[0], right[0]));
    const bookOffset = bookCursor ? Math.max(0, bookPairs.findIndex(([pairId]) => pairId === bookCursor) + 1) : 0;
    const visibleBooks = bookPairs.slice(bookOffset, bookOffset + bookLimit);
    return {
      core: projectEntityReplicaCoreView(replica.state, replica),
      accounts: {
        items: visibleAccountIds.map(id => {
          const account = replica.state.accounts.get(id);
          if (!account) throw new Error(`TEST_ACCOUNT_MISSING: ${id}`);
          return projectAccountDoc(account);
        }),
        nextCursor: accountIds.length > accountLimit ? (visibleAccountIds[visibleAccountIds.length - 1] ?? null) : null,
      },
      books: {
        items: visibleBooks.map(([pairId, book]) => ({ pairId, book })),
        nextCursor:
          bookOffset + bookLimit < bookPairs.length ? (visibleBooks[visibleBooks.length - 1]?.[0] ?? null) : null,
      },
    };
  };

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
    keys: async function* (options?: { gte?: Buffer; lt?: Buffer; reverse?: boolean }) {
      const ordered = Array.from(store.values())
        .map(item => item.key)
        .sort(Buffer.compare);
      if (options?.reverse) ordered.reverse();
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

const capabilityTokenUnchecked = (seed: string, role: 'read' | 'full', expiresAtMs: number): string => {
  const level = role === 'read' ? 'inspect' : 'admin';
  const audience = 'xln-runtime';
  const keyId = 'test';
  const tokenId = 'unchecked';
  const encodedAudience = Buffer.from(audience, 'utf8').toString('base64url');
  const encodedKeyId = Buffer.from(keyId, 'utf8').toString('base64url');
  const encodedTokenId = Buffer.from(tokenId, 'utf8').toString('base64url');
  const signature = createHmac('sha256', seed)
    .update(`xln-radapter-v1:cap:${level}:${expiresAtMs}:${audience}:${keyId}:${tokenId}`)
    .digest('hex');
  return `xlnra1.${role}.${expiresAtMs}.${encodedAudience}.${encodedKeyId}.${encodedTokenId}.${signature}`;
};

const oldStaticAuthKey = (seed: string, level: 'inspect' | 'admin'): string =>
  createHmac('sha256', seed).update(`xln-radapter-v1:${level}`).digest('hex');

const inspectToken = (): string => deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000);

const ownerBindingSignature = (runtimeId: string, challenge: string, capability: string): string =>
  new SigningKey(hexlify(deriveSignerKeySync('seed', '1')))
    .sign(buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability))
    .serialized.toLowerCase();

test('runtime adapter view-frame excludes unbounded account internals from remote snapshots', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)! as any;
  account.state.watchSeed = `0x${'11'.repeat(32)}`;
  account.boardResealMigration = {
    activationJHeight: 9,
    activationLogIndex: 2,
    reason: 'bilateral-frame-uncertified',
  };
  account.currentFrame = {
    ...account.currentFrame,
    accountTxs: Array.from({ length: 30_000 }, (_, index) => ({
      type: 'memo',
      data: { index, note: 'x'.repeat(160) },
    })),
    deltas: Array.from({ length: 5_000 }, (_, index) => ({
      tokenId: index,
      ondelta: BigInt(index),
      offdelta: -BigInt(index),
      collateral: 0n,
    })),
  };
  account.pendingFrame = {
    ...account.currentFrame,
    height: account.currentFrame.height + 1,
    accountTxs: Array.from({ length: 30_000 }, (_, index) => ({
      type: 'pending_memo',
      data: { index, note: 'y'.repeat(160) },
    })),
  };
  account.mempool = Array.from({ length: 30_000 }, (_, index) => ({
    type: 'queued_memo',
    data: { index, note: 'z'.repeat(160) },
  }));
  account.pendingSignatures = Array.from({ length: 30_000 }, (_, index) => `sig-${index}-${'a'.repeat(80)}`);
  account.abiProofBody = {
    encodedProofBody: `0x${'ab'.repeat(500_000)}`,
    proofBodyHash: `0x${'cd'.repeat(32)}`,
    lastUpdatedHeight: 1,
  };
  account.disputeProofBodiesByHash = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [
      `0x${index.toString(16).padStart(64, '0')}`,
      { proof: 'p'.repeat(800) },
    ]),
  );
  account.disputeArgumentSnapshotsByHash = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [
      `0x${(index + 1).toString(16).padStart(64, '0')}`,
      { args: 'a'.repeat(800) },
    ]),
  );
  account.state.settlementWorkspace = { notes: 's'.repeat(500_000) };
  account.swapOrderHistory = new Map(
    Array.from({ length: 20_000 }, (_, index) => [
      `history-${index}`,
      { offerId: `history-${index}`, status: 'closed', note: 'h'.repeat(120), resolves: [] },
    ]),
  );
  account.swapClosedOrders = new Map(
    Array.from({ length: 20_000 }, (_, index) => [
      `closed-${index}`,
      { offerId: `closed-${index}`, status: 'closed', note: 'c'.repeat(120), resolves: [] },
    ]),
  );

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      accounts: {
        items: Array<{
          watchSeed: string;
          mempool: unknown[];
          pendingSignatures: string[];
          currentFrame: { accountTxs: unknown[]; deltas: unknown[] };
          pendingFrame?: { accountTxs: unknown[]; deltas: unknown[] };
          abiProofBody?: unknown;
          disputeProofBodiesByHash?: unknown;
          disputeArgumentSnapshotsByHash?: unknown;
          settlementWorkspace?: unknown;
          swapOrderHistory?: Map<string, unknown>;
          swapClosedOrders?: Map<string, unknown>;
          leftPendingJClaims: { root: string; count: bigint };
          rightPendingJClaims: { root: string; count: bigint };
          boardResealMigration?: {
            activationJHeight: number;
            activationLogIndex: number;
            reason: string;
          };
        }>;
      };
    } | null;
  }>({ env }, 'view-frame', { entityId, accountsLimit: 1, booksLimit: 1 });
  const accountPoint = await resolveRuntimeAdapterRead<{
    swapOrderHistory?: Map<string, unknown>;
    swapClosedOrders?: Map<string, unknown>;
  }>({ env }, `entity/${entityId}/account/${counterpartyId}`);
  const encoded = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'account-budget', ok: true, payload: frame });
  const compact = frame.activeEntity?.accounts.items[0];

  expect(encoded.byteLength).toBeLessThan(1_048_576);
  expect(compact?.state.watchSeed).toBe('');
  expect(compact?.mempool).toHaveLength(0);
  expect(compact?.pendingSignatures).toHaveLength(0);
  expect(compact?.currentFrame.accountTxs.length ?? 0).toBeLessThanOrEqual(20);
  expect(compact?.currentFrame.deltas.length ?? 0).toBeLessThanOrEqual(100);
  expect(compact?.pendingFrame?.accountTxs.length ?? 0).toBeLessThanOrEqual(20);
  expect(compact?.pendingFrame?.deltas.length ?? 0).toBeLessThanOrEqual(100);
  expect(compact?.abiProofBody).toBeUndefined();
  expect(compact?.disputeProofBodiesByHash).toBeUndefined();
  expect(compact?.disputeArgumentSnapshotsByHash).toBeUndefined();
  expect(compact?.state.settlementWorkspace).toBeUndefined();
  expect(compact?.swapOrderHistory).toBeUndefined();
  expect(compact?.swapClosedOrders).toBeUndefined();
  expect(accountPoint.swapOrderHistory?.size).toBe(20);
  expect(accountPoint.swapOrderHistory?.has('history-0')).toBe(false);
  expect(accountPoint.swapOrderHistory?.has('history-19999')).toBe(true);
  expect(accountPoint.swapClosedOrders?.size).toBe(20);
  expect(accountPoint.swapClosedOrders?.has('closed-0')).toBe(false);
  expect(accountPoint.swapClosedOrders?.has('closed-19999')).toBe(true);
  expect(compact?.state.leftPendingJClaims).toEqual(createEmptyAccountJClaimAccumulator());
  expect(compact?.state.rightPendingJClaims).toEqual(createEmptyAccountJClaimAccumulator());
  expect(compact?.boardResealMigration).toEqual(account.boardResealMigration);
});

test('runtime adapter returns an owned projection after releasing the committed-read lease', async () => {
  const env = makeEnv();
  const persistedHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: env.state.height,
    latestMaterializedHeight: env.state.height,
    latestSnapshotHeight: 1,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  };
  const projectedHead = await resolveRuntimeAdapterRead<StorageHead>(
    { env, readHead: async () => persistedHead },
    'head',
    { atHeight: 1 },
  );

  persistedHead.latestHeight += 1;

  expect(projectedHead.latestHeight).toBe(env.state.height);
});

test('storage-backed historical view pages support desc account and book cursors', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const baseAccount = replica.state.accounts.get(counterpartyId)!;
  const snapshotHeight = 4;
  const latestHeight = 5;
  const accountIds = [1, 2, 3, 4].map(value => `0x${(0xc0 + value).toString(16).padEnd(64, '0')}`);
  const head: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight,
    latestMaterializedHeight: latestHeight,
    latestSnapshotHeight: snapshotHeight,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  };
  const manifest: StorageSnapshotManifest = { height: snapshotHeight, createdAt: 400, docCount: 7 };
  const core = projectEntityCoreDoc(replica.state);
  const db = makeMemoryDb([
    [KEY_HEAD, encodeBuffer(head)],
    [keySnapshotManifest(snapshotHeight), encodeBuffer(manifest)],
    [keySnapshotEntity(snapshotHeight, entityId), encodeBuffer(core)],
    ...accountIds.map(
      id =>
        [
          snapshotAccountKey(snapshotHeight, entityId, id),
          encodeBuffer(
            projectAccountDoc({
              ...baseAccount,
              state: { ...baseAccount.state, rightEntity: id },
              proofHeader: { ...baseAccount.proofHeader, toEntity: id },
            }),
          ),
        ] as [Buffer, Buffer],
    ),
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
  expect(first?.accounts.items.map(item => item.state.rightEntity)).toEqual([accountIds[3], accountIds[2]]);
  expect(first?.accounts.nextCursor).toBe(accountIds[2]);
  expect(first?.books.items.map(item => item.pairId)).toEqual(['1/1']);
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
  expect(second?.accounts.items.map(item => item.state.rightEntity)).toEqual([accountIds[1], accountIds[0]]);
  expect(second?.accounts.nextCursor).toBe(null);
  expect(second?.books.items.map(item => item.pairId)).toEqual(['1/2']);
  expect(second?.books.nextCursor).toBe(null);
});

test('storage readers reject requested heights beyond the persisted head', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  const head: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: env.state.height,
    latestMaterializedHeight: env.state.height,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  };
  const db = makeMemoryDb([
    [KEY_HEAD, encodeBuffer(head)],
    [keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica.state))],
    [keyLiveAccount(entityId, counterpartyId), encodeBuffer(projectAccountDoc(account))],
  ]);
  const futureHeight = env.state.height + 1;

  await expect(
    loadEntityStateFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
      height: futureHeight,
    }),
  ).rejects.toThrow('STORAGE_HEIGHT_UNAVAILABLE');

  await expect(
    loadEntityAccountDocFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
      counterpartyId,
      height: futureHeight,
    }),
  ).rejects.toThrow('STORAGE_HEIGHT_UNAVAILABLE');

  await expect(
    loadEntityViewPageFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
      height: futureHeight,
    }),
  ).rejects.toThrow('STORAGE_HEIGHT_UNAVAILABLE');
});

test('storage live recovery verifies doc values through merkle leaves', async () => {
  const previous = process.env['XLN_STORAGE_VERIFY_DOC_HASHES'];
  process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] = '1';
  try {
    const env = makeEnv();
    const replica = Array.from(env.state.eReplicas.values())[0]!;
    const account = replica.state.accounts.get(counterpartyId)!;
    const head: StorageHead = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: env.state.height,
      latestMaterializedHeight: env.state.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedHistoryBytes: 0,
    };
    const coreDoc = projectEntityCoreDoc(replica.state);
    const accountDoc = projectAccountDoc(account);
    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb([]),
      puts: [
        { family: 'entity', entityId, value: coreDoc },
        { family: 'account', entityId, counterpartyId, value: accountDoc },
      ],
      dels: [],
    });
    const db = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
      [keyLiveAccount(entityId, counterpartyId), prepared.docValueBuffers.get(`a:${entityId}:${counterpartyId}`)!],
      ...prepared.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer]),
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

test('storage live recovery hydrates a typed split Account through its logical layout', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  account.pendingSignatures = Array.from(
    { length: 160 },
    (_, index) => `signature-${index.toString().padStart(3, '0')}-${'ab'.repeat(48)}`,
  );
  const head: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: env.state.height,
    latestMaterializedHeight: env.state.height,
    latestSnapshotHeight: 0,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  };
  const rawDb = makeMemoryDb([
    [KEY_HEAD, encodeBuffer(head)],
    [keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica.state))],
  ]);
  const db = withRebranchedValues(rawDb);
  const layout = await prepareAccountStorageLayout(
    db,
    entityId,
    counterpartyId,
    keyLiveAccount(entityId, counterpartyId),
    projectAccountDoc(account),
  );
  expect(layout.representation).toBe('fields');
  const batch = db.batch();
  for (const key of layout.dels) batch.del?.(key);
  for (const put of layout.puts) batch.put(put.key, put.value);
  await batch.write();

  const restored = await loadEntityStateFromStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    entityId,
  });
  expect(restored?.accounts.get(counterpartyId)?.pendingSignatures).toEqual(account.pendingSignatures);
});

test('storage live recovery rejects live docs that do not match merkle leaf value hashes', async () => {
  const previous = process.env['XLN_STORAGE_VERIFY_DOC_HASHES'];
  process.env['XLN_STORAGE_VERIFY_DOC_HASHES'] = '1';
  try {
    const env = makeEnv();
    const replica = Array.from(env.state.eReplicas.values())[0]!;
    const account = replica.state.accounts.get(counterpartyId)!;
    const head: StorageHead = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: env.state.height,
      latestMaterializedHeight: env.state.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedHistoryBytes: 0,
    };
    const coreDoc = projectEntityCoreDoc(replica.state);
    const accountDoc = projectAccountDoc(account);
    const prepared = await prepareStorageStateHashes({
      db: makeMemoryDb([]),
      puts: [
        { family: 'entity', entityId, value: coreDoc },
        { family: 'account', entityId, counterpartyId, value: accountDoc },
      ],
      dels: [],
    });
    const corruptedAccountRaw = encodeBuffer({ ...accountDoc, currentHeight: accountDoc.currentHeight + 1 });
    const db = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
      [keyLiveAccount(entityId, counterpartyId), corruptedAccountRaw],
      ...prepared.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer]),
    ]);

    await expect(
      loadEntityStateFromStorage({
        env,
        tryOpenDb: async () => true,
        getRuntimeDb: () => db,
        entityId,
      }),
    ).rejects.toThrow('STORAGE_DOC_HASH_MISMATCH');
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
    const replica = Array.from(env.state.eReplicas.values())[0]!;
    const account = replica.state.accounts.get(counterpartyId)!;
    const coreDoc = projectEntityCoreDoc(replica.state);
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
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: env.state.height,
      latestMaterializedHeight: env.state.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedHistoryBytes: 0,
    };
    const entries: Array<[Buffer, Buffer]> = [
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
      [keyLiveAccount(entityId, counterpartyId), prepared.docValueBuffers.get(`a:${entityId}:${counterpartyId}`)!],
      ...prepared.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer]),
    ];
    const db = makeMemoryDb(entries);

    const state = await loadEntityStateFromStorage({
      env,
      tryOpenDb: async () => true,
      getRuntimeDb: () => db,
      entityId,
    });
    expect(state?.accounts.has(counterpartyId)).toBe(true);

    const leafEntry = entries.find(
      ([key]) =>
        Buffer.compare(
          key.subarray(0, keyMerkleLeafPrefix(entityId, 'runtime-roots').length),
          keyMerkleLeafPrefix(entityId, 'runtime-roots'),
        ) === 0,
    );
    const leaf = decodeBuffer<StorageMerkleLeafDoc>(leafEntry![1]);
    const corrupted = { ...leaf, hash: `0x${'ff'.repeat(32)}` };
    const corruptedDb = makeMemoryDb(
      entries.map(([key, value]) =>
        key === leafEntry![0]
          ? ([key, encodeBuffer(corrupted)] as [Buffer, Buffer])
          : ([key, value] as [Buffer, Buffer]),
      ),
    );

    await expect(
      loadEntityStateFromStorage({
        env,
        tryOpenDb: async () => true,
        getRuntimeDb: () => corruptedDb,
        entityId,
      }),
    ).rejects.toThrow('STORAGE_MERKLE_LEAF_HASH_MISMATCH');
  } finally {
    if (previous === undefined) delete process.env['XLN_STORAGE_VERIFY_MERKLE'];
    else process.env['XLN_STORAGE_VERIFY_MERKLE'] = previous;
  }
});

test('storage startup verifies live key bindings and the complete materialized merkle tree', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  const coreDoc = projectEntityCoreDoc(replica.state);
  const accountDoc = projectAccountDoc(account);
  const prepared = await prepareStorageStateHashes({
    db: makeMemoryDb([]),
    puts: [
      { family: 'entity', entityId, value: coreDoc },
      { family: 'account', entityId, counterpartyId, value: accountDoc },
    ],
    dels: [],
  });
  const entries: Array<[Buffer, Buffer]> = [
    [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
    [keyLiveAccount(entityId, counterpartyId), prepared.docValueBuffers.get(`a:${entityId}:${counterpartyId}`)!],
    ...prepared.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer]),
  ];

  await expect(verifyLiveStorageIntegrity(makeMemoryDb(entries))).resolves.toBeUndefined();

  const accountKey = keyLiveAccount(entityId, counterpartyId);
  const movedAccount = entries.map(
    ([key, value]) =>
      (key.equals(accountKey) ? [Buffer.concat([key, Buffer.from([0])]), value] : [key, value]) as [Buffer, Buffer],
  );
  await expect(verifyLiveStorageIntegrity(makeMemoryDb(movedAccount))).rejects.toThrow(
    'STORAGE_LIVE_ACCOUNT_KEY_INVALID',
  );

  const leafPrefix = keyMerkleLeafPrefix(entityId, 'runtime-roots');
  const movedLeaf = entries.map(
    ([key, value]) =>
      (key.subarray(0, leafPrefix.length).equals(leafPrefix)
        ? [Buffer.concat([key, Buffer.from([0])]), value]
        : [key, value]) as [Buffer, Buffer],
  );
  await expect(verifyLiveStorageIntegrity(makeMemoryDb(movedLeaf))).rejects.toThrow('STORAGE_MERKLE_LEAF_KEY_MISMATCH');

  const branchPrefix = keyMerkleBranchPrefix(entityId, 'runtime-roots');
  const corruptBranch = entries.map(([key, value]) => {
    if (!key.subarray(0, branchPrefix.length).equals(branchPrefix)) return [key, value] as [Buffer, Buffer];
    const branch = decodeBuffer<Record<string, unknown>>(value);
    return [key, encodeBuffer({ ...branch, hash: `0x${'ff'.repeat(32)}` })] as [Buffer, Buffer];
  });
  await expect(verifyLiveStorageIntegrity(makeMemoryDb(corruptBranch))).rejects.toThrow(
    'STORAGE_MERKLE_BRANCH_MISMATCH',
  );
});

test('runtime adapter account pagination avoids full sort materialization', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const base = replica.state.accounts.get(counterpartyId)!;
  replica.state.accounts.clear();
  for (let i = 999; i >= 0; i -= 1) {
    const id = `0x${(i + 1).toString(16).padStart(64, '0')}`;
    replica.state.accounts.set(id, {
      ...base,
      state: { ...base.state, rightEntity: id },
      proofHeader: { ...base.proofHeader, toEntity: id },
    });
  }

  const first = await resolveRuntimeAdapterRead<{
    items: Array<{ state: { rightEntity: string } }>;
    nextCursor: string | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, `entity/${entityId}/accounts`, { limit: 3 });
  expect(first.items.map(item => item.state.rightEntity)).toEqual([
    `0x${'01'.padStart(64, '0')}`,
    `0x${'02'.padStart(64, '0')}`,
    `0x${'03'.padStart(64, '0')}`,
  ]);
  expect(first.nextCursor).toBe(`0x${'03'.padStart(64, '0')}`);
});

test('runtime adapter books path is bounded and paged', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.orderbookExt = makeOrderbookExt(
    new Map(Array.from({ length: 12 }, (_, index) => [`1/${index + 1}`, makeBook(BigInt(100 + index))])),
  );

  const books = await resolveRuntimeAdapterRead<{
    items: Array<{ pairId: string }>;
    nextCursor: string | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, `entity/${entityId}/books`);
  expect(books.items).toHaveLength(10);
  expect(books.nextCursor).toBeTruthy();
});

test('runtime adapter compact book view preserves full level depth while trimming visible orders', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.orderbookExt = makeOrderbookExt(new Map([['1/2', makeCrowdedBidLevelBook(100n, 25)]]));

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      books: {
        items: Array<{ pairId: string; book: BookState }>;
      };
    } | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', {
    entityId,
    booksLimit: 1,
  });
  const book = frame.activeEntity?.books.items[0]?.book;
  const level = book?.bidBuckets.get('100')?.levels.get('100');

  expect(book?.orders.size).toBe(20);
  expect(level?.orderIds).toHaveLength(20);
  expect(level?.totalQtyLots).toBe(25n);
});

test('runtime adapter binary codec preserves structured payloads', () => {
  const encoded = encodeRuntimeAdapterMessage({
    v: 1,
    id: 'send-1',
    op: 'send',
    commandId: 'binary-command-0001',
    commandSequence: 1,
    input: {
      runtimeTxs: [],
      entityInputs: [
        {
          entityId,
          signerId: 'signer',
          entityTxs: [
            {
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
            },
          ],
        },
      ],
    },
  });
  const decoded = decodeTestRuntimeAdapterMessage<{
    input: {
      entityInputs: Array<{
        entityTxs: Array<{
          data: { amount: bigint; metadata: Map<string, string>; tags: Set<string>; bytes: Uint8Array };
        }>;
      }>;
    };
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
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-1', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const denied = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');

  await handleRuntimeAdapterMessage(
    socket,
    { v: 1, id: 'auth-1', op: 'auth', key: inspectToken(), challenge: adapterAuthChallenge },
    env,
    {
      enqueueRuntimeInput: () => {},
    },
  );
  const authed = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { authLevel: string } }>(messages.pop());
  expect(authed.ok).toBe(true);
  expect(authed.payload.authLevel).toBe('inspect');

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-2', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  const read = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { latestHeight: number } }>(messages.pop());
  expect(read.ok).toBe(true);
  expect(read.payload.latestHeight).toBe(7);
});

test('runtime adapter websocket handler rejects send under inspect auth', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  let enqueued = 0;

  await handleRuntimeAdapterMessage(
    socket,
    { v: 1, id: 'auth-1', op: 'auth', key: inspectToken(), challenge: adapterAuthChallenge },
    env,
    {
      enqueueRuntimeInput: () => {
        enqueued += 1;
      },
    },
  );
  const authed = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { authLevel: string } }>(messages.pop());
  expect(authed.ok).toBe(true);
  expect(authed.payload.authLevel).toBe('inspect');

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-1',
      op: 'send',
      commandId: 'inspect-command-0001',
      commandSequence: 1,
      input: {
        runtimeTxs: [],
        entityInputs: [],
      },
    },
    env,
    {
      enqueueRuntimeInput: () => {
        enqueued += 1;
      },
    },
  );

  const denied = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string; message: string } }>(
    messages.pop(),
  );
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');
  expect(denied.error.message).toContain('admin auth required');
  expect(enqueued).toBe(0);
});

test('runtime adapter cross-j intent requires admin and bypasses the durable command lane', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  const route = {
    orderId: 'radapter-cross-j-intent',
    status: 'intent',
  } as unknown as CrossJurisdictionSwapRoute;
  let enqueued = 0;
  const submitted: CrossJurisdictionSwapRoute[] = [];
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
    submitCrossJurisdictionIntent: async (_env: RuntimeReplica, submittedRoute: CrossJurisdictionSwapRoute) => {
      submitted.push(submittedRoute);
    },
  };

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-inspect',
      op: 'auth',
      key: inspectToken(),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'cross-j-denied',
      op: 'cross-j-intent',
      route,
    },
    env,
    deps,
  );
  const denied = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');
  expect(submitted).toHaveLength(0);

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-admin',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'cross-j-delivered',
      op: 'cross-j-intent',
      route,
    },
    env,
    deps,
  );
  const delivered = decodeTestRuntimeAdapterMessage<{
    ok: true;
    payload: { delivered: boolean };
  }>(messages.pop());
  expect(delivered.ok).toBe(true);
  expect(delivered.payload).toEqual({ delivered: true });
  expect(submitted).toEqual([route]);
  expect(enqueued).toBe(0);
});

test('runtime adapter rejects send and cross-j before either reaches a halted runtime', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  let enqueued = 0;
  let submitted = 0;
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
    submitCrossJurisdictionIntent: async () => {
      submitted += 1;
    },
  };

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-admin-halted',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;
  env.infrastructure = { lifecyclePhase: 'halted', halted: true };

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-halted',
      op: 'send',
      commandId: 'halted-command-0001',
      commandSequence: 1,
      input: { runtimeTxs: [], entityInputs: [] },
    },
    env,
    deps,
  );
  const sendResponse = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string; message: string; retryable: boolean };
  }>(messages.pop());
  expect(sendResponse.ok).toBe(false);
  expect(sendResponse.error).toMatchObject({
    code: 'E_COMMAND_PENDING',
    message: 'RUNTIME_COMMAND_NOT_READY:phase=halted',
    retryable: true,
  });

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'cross-j-halted',
      op: 'cross-j-intent',
      route: { orderId: 'halted-cross-j' } as CrossJurisdictionSwapRoute,
    },
    env,
    deps,
  );
  const crossJResponse = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string; message: string; retryable: boolean };
  }>(messages.pop());
  expect(crossJResponse.ok).toBe(false);
  expect(crossJResponse.error).toMatchObject({
    code: 'E_COMMAND_PENDING',
    message: 'RUNTIME_COMMAND_NOT_READY:phase=halted',
    retryable: true,
  });
  expect(enqueued).toBe(0);
  expect(submitted).toBe(0);
});

test('runtime adapter keeps one command retryable until startup J catch-up completes', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  let ready = false;
  let enqueued = 0;
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
    isMutatingIngressReady: () => ready,
  };
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-admin',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;
  const command = {
    v: 1 as const,
    op: 'send' as const,
    commandId: 'startup-catchup-command-0001',
    commandSequence: 1,
    input: { runtimeTxs: [], entityInputs: [] },
  };

  await handleRuntimeAdapterMessage(socket, { ...command, id: 'send-before-catchup' }, env, deps);
  const pending = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string; message: string; retryable: boolean };
  }>(messages.pop());
  expect(pending).toEqual(
    expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'E_COMMAND_PENDING',
        message: 'RUNTIME_STARTUP_J_CATCHUP_PENDING',
        retryable: true,
      }),
    }),
  );
  expect(enqueued).toBe(0);

  ready = true;
  await handleRuntimeAdapterMessage(socket, { ...command, id: 'send-after-catchup' }, env, deps);
  const accepted = decodeTestRuntimeAdapterMessage<{ ok: boolean }>(messages.pop());
  expect(accepted.ok).toBe(true);
  expect(enqueued).toBe(1);
});

test('runtime adapter send commandId deduplicates retries and rejects payload changes', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  let enqueued = 0;
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
  };
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-admin',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;
  const command = {
    v: 1 as const,
    op: 'send' as const,
    commandId: 'retry-command-0001',
    commandSequence: 1,
    input: { runtimeTxs: [], entityInputs: [] },
  };

  await handleRuntimeAdapterMessage(socket, { ...command, id: 'send-first' }, env, deps);
  const first = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { height: number } }>(messages.pop());
  await handleRuntimeAdapterMessage(socket, { ...command, id: 'send-retry' }, env, deps);
  const retried = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { height: number } }>(messages.pop());
  await handleRuntimeAdapterMessage(
    socket,
    {
      ...command,
      id: 'send-conflict',
      input: { runtimeTxs: [{ type: 'importReplica', entityId: 'different' } as never], entityInputs: [] },
    },
    env,
    deps,
  );
  const conflict = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());

  expect(first.ok).toBe(true);
  expect(retried.payload).toEqual(first.payload);
  expect(conflict.ok).toBe(false);
  expect(conflict.error.code).toBe('E_COMMAND_PENDING');
  expect(enqueued).toBe(1);
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers).toBeUndefined();
});

test('vault-owner command retry survives capability token rotation without a second enqueue', async () => {
  const env = makeEnv();
  const runtimeId = deriveSignerAddressSync(String(env.runtimeSeed), '1').toLowerCase();
  env.runtimeId = runtimeId;
  const challenge = `0x${'51'.repeat(32)}`;
  const input: RuntimeInput = { runtimeTxs: [], entityInputs: [], jInputs: [] };
  let enqueued = 0;
  const deps = {
    enqueueRuntimeInput: (_env: RuntimeReplica, marked: RuntimeInput) => {
      const marker = marked.runtimeTxs.find(tx => tx.type === 'recordRuntimeAdapterCommand');
      if (!marker || marker.type !== 'recordRuntimeAdapterCommand') {
        throw new Error('TEST_RUNTIME_ADAPTER_COMMAND_MARKER_MISSING');
      }
      applyRuntimeAdapterCommandMarker(env, marker.data);
      enqueued += 1;
    },
  };
  const authenticateAndSend = async (tokenId: string, suffix: string) => {
    const messages: unknown[] = [];
    const socket = {
      send: (message: unknown) => {
        messages.push(message);
      },
    };
    const key = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000, {
      audience: runtimeId,
      keyId: 'rotating-owner-capability',
      tokenId,
    });
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: `auth-owner-${suffix}`,
        op: 'auth',
        key,
        challenge,
        ownerSignature: ownerBindingSignature(runtimeId, challenge, key),
      },
      env,
      deps,
    );
    const auth = decodeTestRuntimeAdapterMessage<{
      ok: true;
      payload: { commandLaneKind: string; nextCommandSequence: number };
    }>(messages.pop());
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: `send-owner-${suffix}`,
        op: 'send',
        commandId: 'owner-rotation-command-0001',
        commandSequence: 1,
        input,
      },
      env,
      deps,
    );
    return {
      auth,
      send: decodeTestRuntimeAdapterMessage<{
        ok: true;
        payload: { status: string; commandSequence: number };
      }>(messages.pop()),
    };
  };

  const first = await authenticateAndSend('owner-token-a', 'a');
  const retried = await authenticateAndSend('owner-token-b', 'b');

  expect(first.auth.payload.commandLaneKind).toBe('owner');
  expect(retried.auth.payload.commandLaneKind).toBe('owner');
  expect(retried.auth.payload.nextCommandSequence).toBe(2);
  expect(retried.send.payload.status).toBe('observed');
  expect(enqueued).toBe(1);
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.size).toBe(1);
});

test('vault-owner command frontier survives capability expiry and durable restore', async () => {
  const now = Date.now();
  let env = makeEnv();
  const runtimeId = deriveSignerAddressSync(String(env.runtimeSeed), '1').toLowerCase();
  env.runtimeId = runtimeId;
  env.state.timestamp = now;
  const challenge = `0x${'52'.repeat(32)}`;
  const input: RuntimeInput = { runtimeTxs: [], entityInputs: [], jInputs: [] };
  let enqueued = 0;
  const send = async (expiresAtMs: number, suffix: string) => {
    const messages: unknown[] = [];
    const socket = {
      send: (message: unknown) => {
        messages.push(message);
      },
    };
    const key = deriveRuntimeAdapterCapabilityToken('seed', 'full', expiresAtMs, {
      audience: runtimeId,
      keyId: 'renewed-owner-capability',
      tokenId: 'same-renewed-owner-token',
    });
    const deps = {
      enqueueRuntimeInput: (_env: RuntimeReplica, marked: RuntimeInput) => {
        const marker = marked.runtimeTxs.find(tx => tx.type === 'recordRuntimeAdapterCommand');
        if (!marker || marker.type !== 'recordRuntimeAdapterCommand') {
          throw new Error('TEST_RUNTIME_ADAPTER_COMMAND_MARKER_MISSING');
        }
        applyRuntimeAdapterCommandMarker(env, marker.data);
        enqueued += 1;
      },
    };
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: `auth-owner-expiry-${suffix}`,
        op: 'auth',
        key,
        challenge,
        ownerSignature: ownerBindingSignature(runtimeId, challenge, key),
      },
      env,
      deps,
    );
    messages.pop();
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: `send-owner-expiry-${suffix}`,
        op: 'send',
        commandId: 'owner-expiry-command-0001',
        commandSequence: 1,
        input,
      },
      env,
      deps,
    );
    return decodeTestRuntimeAdapterMessage<{ ok: true; payload: { status: string } }>(messages.pop());
  };

  await send(now + 60_000, 'before');
  const durableRuntimeState = structuredClone(env.infrastructure);
  env = makeEnv();
  env.runtimeId = runtimeId;
  env.state.timestamp = now + 61_000;
  env.infrastructure = durableRuntimeState;
  const retried = await send(now + 120_000, 'after');

  expect(retried.payload.status).toBe('observed');
  expect(enqueued).toBe(1);
  expect(env.infrastructure?.runtimeAdapterCommandFrontiers?.size).toBe(1);
});

test('invalid vault-owner proof rejects auth instead of falling back to a capability lane', async () => {
  const env = makeEnv();
  const runtimeId = deriveSignerAddressSync(String(env.runtimeSeed), '1').toLowerCase();
  env.runtimeId = runtimeId;
  const challenge = `0x${'53'.repeat(32)}`;
  const key = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000, {
    audience: runtimeId,
    tokenId: 'invalid-owner-proof-token',
  });
  const attacker = new SigningKey(`0x${'77'.repeat(32)}`);
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  let enqueued = 0;
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
  };

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-invalid-owner-proof',
      op: 'auth',
      key,
      challenge,
      ownerSignature: attacker.sign(buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, key)).serialized,
    },
    env,
    deps,
  );
  const auth = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string };
  }>(messages.pop());
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-after-invalid-owner-proof',
      op: 'send',
      commandId: 'invalid-owner-proof-command-0001',
      commandSequence: 1,
      input: { runtimeTxs: [], entityInputs: [] },
    },
    env,
    deps,
  );
  const send = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string };
  }>(messages.pop());

  expect(auth.error.code).toBe('E_UNAUTHORIZED');
  expect(send.error.code).toBe('E_UNAUTHORIZED');
  expect(enqueued).toBe(0);
});

test('runtime adapter command replay stays rejected after the bounded result cache horizon', async () => {
  const previousBurst = process.env['XLN_RADAPTER_SEND_BURST'];
  const previousRate = process.env['XLN_RADAPTER_SEND_PER_SEC'];
  const previousControlBurst = process.env['XLN_RADAPTER_CONTROL_BURST'];
  const previousControlRate = process.env['XLN_RADAPTER_CONTROL_PER_SEC'];
  process.env['XLN_RADAPTER_SEND_BURST'] = '2048';
  process.env['XLN_RADAPTER_SEND_PER_SEC'] = '2048';
  process.env['XLN_RADAPTER_CONTROL_BURST'] = '2048';
  process.env['XLN_RADAPTER_CONTROL_PER_SEC'] = '2048';
  try {
    const messages: unknown[] = [];
    const socket = {
      send: (message: unknown) => {
        messages.push(message);
      },
    };
    const env = makeEnv();
    let enqueued = 0;
    const deps = {
      enqueueRuntimeInput: (_env: RuntimeReplica, input: RuntimeInput) => {
        const marker = input.runtimeTxs.find(tx => tx.type === 'recordRuntimeAdapterCommand');
        if (!marker || marker.type !== 'recordRuntimeAdapterCommand') {
          throw new Error('TEST_RUNTIME_ADAPTER_COMMAND_MARKER_MISSING');
        }
        applyRuntimeAdapterCommandMarker(env, marker.data);
        enqueued += 1;
      },
    };
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: 'auth-frontier-horizon',
        op: 'auth',
        key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000, {
          tokenId: 'frontier-horizon-token',
        }),
        challenge: adapterAuthChallenge,
      },
      env,
      deps,
    );
    messages.length = 0;

    for (let sequence = 1; sequence <= 1_025; sequence += 1) {
      await handleRuntimeAdapterMessage(
        socket,
        {
          v: 1,
          id: `send-frontier-${sequence}`,
          op: 'send',
          commandId: `frontier-command-${String(sequence).padStart(6, '0')}`,
          commandSequence: sequence,
          input: { runtimeTxs: [], entityInputs: [] },
        },
        env,
        deps,
      );
      messages.pop();
    }
    await handleRuntimeAdapterMessage(
      socket,
      {
        v: 1,
        id: 'send-frontier-replay',
        op: 'send',
        commandId: 'frontier-command-000001',
        commandSequence: 1,
        input: { runtimeTxs: [], entityInputs: [] },
      },
      env,
      deps,
    );
    const replay = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { status: string } }>(messages.pop());

    expect(replay.ok).toBe(true);
    expect(replay.payload.status).toBe('observed');
    expect(enqueued).toBe(1_025);
  } finally {
    if (previousBurst === undefined) delete process.env['XLN_RADAPTER_SEND_BURST'];
    else process.env['XLN_RADAPTER_SEND_BURST'] = previousBurst;
    if (previousRate === undefined) delete process.env['XLN_RADAPTER_SEND_PER_SEC'];
    else process.env['XLN_RADAPTER_SEND_PER_SEC'] = previousRate;
    if (previousControlBurst === undefined) delete process.env['XLN_RADAPTER_CONTROL_BURST'];
    else process.env['XLN_RADAPTER_CONTROL_BURST'] = previousControlBurst;
    if (previousControlRate === undefined) delete process.env['XLN_RADAPTER_CONTROL_PER_SEC'];
    else process.env['XLN_RADAPTER_CONTROL_PER_SEC'] = previousControlRate;
  }
});

test('runtime adapter command sequence rejects equivocation and gaps before enqueue', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  let enqueued = 0;
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
  };
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-frontier-order',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000, {
        tokenId: 'frontier-order-token',
      }),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-sequence-one',
      op: 'send',
      commandId: 'frontier-order-command-0001',
      commandSequence: 1,
      input: { runtimeTxs: [], entityInputs: [] },
    },
    env,
    deps,
  );
  messages.pop();
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-sequence-equivocation',
      op: 'send',
      commandId: 'frontier-order-command-0001',
      commandSequence: 1,
      input: { runtimeTxs: [{ type: 'importReplica', entityId: 'different' } as never], entityInputs: [] },
    },
    env,
    deps,
  );
  const equivocation = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string; retryable: boolean };
  }>(messages.pop());
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-sequence-gap',
      op: 'send',
      commandId: 'frontier-order-command-0003',
      commandSequence: 3,
      input: { runtimeTxs: [], entityInputs: [] },
    },
    env,
    deps,
  );
  const gap = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string; retryable: boolean };
  }>(messages.pop());

  expect(equivocation.ok).toBe(false);
  expect(equivocation.error).toMatchObject({ code: 'E_COMMAND_PENDING', retryable: true });
  expect(gap.ok).toBe(false);
  expect(gap.error).toMatchObject({ code: 'E_COMMAND_PENDING', retryable: true });
  expect(enqueued).toBe(1);
});

test('runtime adapter rejects a new command lane before enqueue when active capacity is full', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  const expiresAtMs = Date.now() + 60_000;
  env.infrastructure ??= {};
  env.infrastructure.runtimeAdapterCommandFrontiers = new Map(
    Array.from({ length: MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES }, (_, index) => [
      `0x${(index + 1).toString(16).padStart(64, '0')}`,
      {
        lastContiguousSequence: 1,
        lastInputHash: `0x${'11'.repeat(32)}`,
        lastCommandId: `capacity-command-${String(index).padStart(6, '0')}`,
        observedHeight: env.state.height,
        expiresAtMs,
      },
    ]),
  );
  let enqueued = 0;
  const deps = {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
  };
  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-frontier-capacity',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', expiresAtMs, {
        tokenId: 'frontier-capacity-token',
      }),
      challenge: adapterAuthChallenge,
    },
    env,
    deps,
  );
  messages.length = 0;

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'send-frontier-capacity',
      op: 'send',
      commandId: 'frontier-capacity-command-0001',
      commandSequence: 1,
      input: { runtimeTxs: [], entityInputs: [] },
    },
    env,
    deps,
  );
  const rejected = decodeTestRuntimeAdapterMessage<{
    ok: false;
    error: { code: string; retryable: boolean };
  }>(messages.pop());

  expect(rejected.ok).toBe(false);
  expect(rejected.error.code).toBe('E_RATE_LIMITED');
  expect(rejected.error.retryable).toBe(true);
  expect(enqueued).toBe(0);
});

test('runtime adapter auth proves the runtime identity against a client challenge', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  const runtimeId = deriveSignerAddressSync(String(env.runtimeSeed), '1').toLowerCase();
  env.runtimeId = runtimeId;
  const challenge = `0x${'42'.repeat(32)}`;

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-identity',
      op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000, { audience: runtimeId }),
      challenge,
    },
    env,
    { enqueueRuntimeInput: () => {} },
  );

  const response = decodeTestRuntimeAdapterMessage<{
    ok: true;
    payload: {
      runtimeId: string;
      identityPublicKey: string;
      identitySignature: string;
      identityFingerprint: string;
    };
  }>(messages.pop());
  expect(response.ok).toBe(true);
  expect(response.payload.runtimeId).toBe(runtimeId);
  expect(computeAddress(response.payload.identityPublicKey).toLowerCase()).toBe(runtimeId);
  expect(response.payload.identityFingerprint).toBe(keccak256(response.payload.identityPublicKey).toLowerCase());
  const digest = keccak256(
    toUtf8Bytes(
      ['xln-radapter-server-identity-v1', runtimeId, response.payload.identityPublicKey.toLowerCase(), challenge].join(
        ':',
      ),
    ),
  );
  expect(recoverAddress(digest, response.payload.identitySignature).toLowerCase()).toBe(runtimeId);
  expect(() => verifyRuntimeAdapterServerIdentity(response.payload, `0x${'43'.repeat(32)}`, runtimeId)).toThrow(
    'RADAPTER_SERVER_IDENTITY_SIGNATURE_MISMATCH',
  );
  expect(() => verifyRuntimeAdapterServerIdentity(response.payload, challenge, `0x${'11'.repeat(20)}`)).toThrow(
    'RADAPTER_SERVER_IDENTITY_EXPECTED_RUNTIME_MISMATCH',
  );
});

test('runtime adapter rejects auth without a client challenge before granting access', async () => {
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'auth-without-challenge',
      op: 'auth',
      key: inspectToken(),
    },
    env,
    { enqueueRuntimeInput: () => {} },
  );
  const rejected = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(rejected.ok).toBe(false);
  expect(rejected.error.code).toBe('E_BAD_QUERY');

  await handleRuntimeAdapterMessage(
    socket,
    {
      v: 1,
      id: 'read-after-rejected-auth',
      op: 'read',
      path: 'head',
    },
    env,
    { enqueueRuntimeInput: () => {} },
  );
  const denied = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.error.code).toBe('E_UNAUTHORIZED');
});

test('runtime adapter read rate limit is configurable', async () => {
  const previousBurst = process.env['XLN_RADAPTER_READ_BURST'];
  const previousRefill = process.env['XLN_RADAPTER_READ_PER_SEC'];
  process.env['XLN_RADAPTER_READ_BURST'] = '1';
  process.env['XLN_RADAPTER_READ_PER_SEC'] = '0.001';
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const env = makeEnv();
  try {
    await handleRuntimeAdapterMessage(
      socket,
      { v: 1, id: 'auth', op: 'auth', key: inspectToken(), challenge: adapterAuthChallenge },
      env,
      {
        enqueueRuntimeInput: () => {},
      },
    );
    messages.length = 0;

    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-1', op: 'read', path: 'head' }, env, {
      enqueueRuntimeInput: () => {},
    });
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'read-2', op: 'read', path: 'head' }, env, {
      enqueueRuntimeInput: () => {},
    });

    const first = decodeTestRuntimeAdapterMessage<{ ok: boolean }>(messages[0]);
    const second = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string; retryAfterMs?: number } }>(
      messages[1],
    );
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

test('BrainVault mnemonic export emits one redacted security audit event', async () => {
  const messages: unknown[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const mnemonic24 = Array.from({ length: 24 }, (_, index) => `secret-${index}`).join(' ');
  const socket = { send: (message: unknown) => messages.push(message) };
  const env = makeEnv();
  const unregister = registerStructuredLogSink(event => auditEvents.push(event));
  try {
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-admin-brainvault', op: 'auth',
      key: deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000),
      challenge: adapterAuthChallenge,
    }, env, { enqueueRuntimeInput: () => {} });
    messages.length = 0;
    auditEvents.length = 0;
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'brainvault-reveal-audit', op: 'brainvault-reveal' }, env, {
      enqueueRuntimeInput: () => {},
      revealBrainVaultMnemonic: async () => ({ mnemonic24 }),
    });
    const response = decodeTestRuntimeAdapterMessage<{ ok: true; payload: { mnemonic24: string } }>(messages.pop());
    expect(response.payload.mnemonic24).toBe(mnemonic24);
    const mnemonicExports = auditEvents.filter(event => event['scope'] === 'runtime.radapter'
      && event['message'] === 'brainvault.mnemonic_exported');
    expect(mnemonicExports).toHaveLength(1);
    expect(mnemonicExports[0]).toEqual(expect.objectContaining({
      level: 'warn', scope: 'runtime.radapter', message: 'brainvault.mnemonic_exported', authLevel: 'admin',
    }));
    expect(JSON.stringify(auditEvents)).not.toContain(mnemonic24);
  } finally {
    unregister();
  }
});

test('runtime adapter ticks only go to authenticated clients', async () => {
  const env = makeEnv();
  const unauthMessages: unknown[] = [];
  const inspectMessages: unknown[] = [];
  const unauthSocket = {
    send: (message: unknown) => {
      unauthMessages.push(message);
    },
  };
  const inspectSocket = {
    send: (message: unknown) => {
      inspectMessages.push(message);
    },
  };

  await handleRuntimeAdapterMessage(unauthSocket, { v: 1, id: 'read-unauth', op: 'read', path: 'head' }, env, {
    enqueueRuntimeInput: () => {},
  });
  unauthMessages.length = 0;

  await handleRuntimeAdapterMessage(
    inspectSocket,
    { v: 1, id: 'auth-inspect', op: 'auth', key: inspectToken(), challenge: adapterAuthChallenge },
    env,
    {
      enqueueRuntimeInput: () => {},
    },
  );
  inspectMessages.length = 0;

  broadcastRuntimeAdapterTick(env);

  expect(unauthMessages).toHaveLength(0);
  expect(inspectMessages).toHaveLength(1);
  const tick = decodeTestRuntimeAdapterMessage<{ op: string; height: number }>(inspectMessages[0]);
  expect(tick.op).toBe('tick');
  expect(tick.height).toBe(7);
});

test('runtime adapter drops expired clients before broadcasting ticks', async () => {
  const env = makeEnv();
  const messages: unknown[] = [];
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
  };
  const expiredToken = capabilityTokenUnchecked('seed', 'read', Date.now() - 1);

  await handleRuntimeAdapterMessage(
    socket,
    { v: 1, id: 'auth-expired', op: 'auth', key: expiredToken, challenge: adapterAuthChallenge },
    env,
    {
      enqueueRuntimeInput: () => {},
    },
  );
  const denied = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages.pop());
  expect(denied.error.code).toBe('E_UNAUTHORIZED');

  const liveToken = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 5);
  await handleRuntimeAdapterMessage(
    socket,
    { v: 1, id: 'auth-live', op: 'auth', key: liveToken, challenge: adapterAuthChallenge },
    env,
    {
      enqueueRuntimeInput: () => {},
    },
  );
  messages.length = 0;
  await new Promise(resolve => setTimeout(resolve, 10));
  broadcastRuntimeAdapterTick(env);
  expect(messages).toHaveLength(0);
});

test('runtime adapter caps outgoing responses and closes oversized sockets', async () => {
  const previous = process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
  const previousLogLevel = process.env['XLN_LOG_LEVEL'];
  process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = '512';
  process.env['XLN_LOG_LEVEL'] = 'error';
  const messages: unknown[] = [];
  let closeCode: number | undefined;
  const socket = {
    send: (message: unknown) => {
      messages.push(message);
    },
    close: (code?: number) => {
      closeCode = code;
    },
  };
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.profile = { ...replica.state.profile, bio: 'x'.repeat(4_000) };
  try {
    await handleRuntimeAdapterMessage(
      socket,
      { v: 1, id: 'auth', op: 'auth', key: inspectToken(), challenge: adapterAuthChallenge },
      env,
      {
        enqueueRuntimeInput: () => {},
      },
    );
    messages.length = 0;
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'big-read', op: 'read', path: `entity/${entityId}` }, env, {
      enqueueRuntimeInput: () => {},
    });
    const response = decodeTestRuntimeAdapterMessage<{ ok: false; error: { code: string } }>(messages[0]);
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('E_INTERNAL');
    expect(closeCode).toBe(1009);
  } finally {
    if (previous === undefined) {
      delete process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
    } else {
      process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = previous;
    }
    if (previousLogLevel === undefined) {
      delete process.env['XLN_LOG_LEVEL'];
    } else {
      process.env['XLN_LOG_LEVEL'] = previousLogLevel;
    }
  }
});

test('embedded adapter sends to the latest active env after runtime switch', async () => {
  const staleEnv = makeEnv();
  staleEnv.state.height = 1;
  staleEnv.state.eReplicas = new Map();

  const activeEnv = makeEnv();
  activeEnv.state.height = 5;

  let currentEnv: RuntimeReplica | null = staleEnv;
  let publishCommittedHeight: ((height: number) => void) | null = null;
  const writtenEnv: RuntimeReplica[] = [];
  const adapter = new EmbeddedRuntimeAdapter({
    getEnv: () => currentEnv,
    validateRuntimeInputAdmission: () => {},
    enqueueRuntimeInput: (env, input) => {
      writtenEnv.push(env);
      expect(input.entityInputs?.[0]?.entityId).toBe(entityId);
      env.state.height = Math.max(0, Math.floor(Number(env.state.height ?? 0))) + 1;
    },
    submitCrossJurisdictionIntent: async () => ({ delivered: true }),
    registerRuntimePublishedCallback: (_env, callback) => {
      publishCommittedHeight = height =>
        callback({
          runtimeId: String(activeEnv.runtimeId || ''),
          height,
          timestamp: activeEnv.state.timestamp,
          lifecyclePhase: 'running',
          commandReady: true,
          commandReadyReason: null,
        });
      return () => {};
    },
  });

  await adapter.connect({ mode: 'embedded' });
  currentEnv = activeEnv;

  await adapter.send({
    runtimeTxs: [],
    entityInputs: [
      {
        entityId,
        signerId: 'signer',
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: counterpartyId, tokenId: 1, creditAmount: 1n } }],
      },
    ],
  });

  expect(writtenEnv).toEqual([activeEnv]);
  expect(staleEnv.state.height).toBe(1);
  expect(activeEnv.state.height).toBe(6);
  expect(adapter.currentHeight).toBe(1);
  publishCommittedHeight?.(activeEnv.state.height);
  expect(adapter.currentHeight).toBe(6);
});

test('runtime publication callbacks expose only an immutable scalar notice', () => {
  const env = makeEnv();
  let published: unknown = null;
  const unregister = registerRuntimePublishedCallback(env, notice => {
    published = notice;
  });

  notifyRuntimeStateChanged(env);
  unregister();

  expect(Object.isFrozen(published)).toBe(true);
  expect(Object.keys(published as object).sort()).toEqual([
    'commandReady',
    'commandReadyReason',
    'height',
    'lifecyclePhase',
    'runtimeId',
    'timestamp',
  ]);
  expect(JSON.stringify(published)).not.toContain('eReplicas');
  expect(JSON.stringify(published)).not.toContain('accounts');
});

test('runtime publication coalesces in-flight notices until the frame is durable', () => {
  const env = makeEnv();
  const publishedHeights: number[] = [];
  const unregister = registerRuntimePublishedCallback(env, notice => {
    publishedHeights.push(notice.height);
  });

  env.state.height = 5;
  env.infrastructure!.stateMutationInFlight = true;
  notifyRuntimeStateChanged(env);
  expect(publishedHeights).toEqual([]);

  env.infrastructure!.stateMutationInFlight = false;
  notifyRuntimeStateChanged(env);
  unregister();
  expect(publishedHeights).toEqual([5]);
});

test('embedded adapter connect waits for the active Runtime frame to commit', async () => {
  const env = makeEnv();
  env.state.height = 4;
  const releaseWriter = await acquireRuntimeFrameWriter(env.infrastructure!);
  env.infrastructure!.stateMutationInFlight = true;
  const adapter = new EmbeddedRuntimeAdapter({
    getEnv: () => env,
    validateRuntimeInputAdmission: () => {},
    enqueueRuntimeInput: () => {},
    submitCrossJurisdictionIntent: async () => ({ delivered: true }),
    registerRuntimePublishedCallback: () => () => {},
  });

  let connected = false;
  const connecting = adapter.connect({ mode: 'embedded' }).then(() => {
    connected = true;
  });
  await Promise.resolve();
  expect(connected).toBeFalse();

  env.state.height = 5;
  env.infrastructure!.stateMutationInFlight = false;
  releaseWriter();
  await connecting;
  expect(adapter.currentHeight).toBe(5);
});

test('embedded adapter never publishes an in-flight frame through synchronous status', async () => {
  const env = makeEnv();
  env.state.height = 4;
  let notify: ((height: number) => void) | null = null;
  const adapter = new EmbeddedRuntimeAdapter({
    getEnv: () => env,
    validateRuntimeInputAdmission: () => {},
    enqueueRuntimeInput: () => {},
    submitCrossJurisdictionIntent: async () => ({ delivered: true }),
    registerRuntimePublishedCallback: (_env, callback) => {
      notify = height =>
        callback({
          runtimeId: String(env.runtimeId || ''),
          height,
          timestamp: env.state.timestamp,
          lifecyclePhase: 'running',
          commandReady: true,
          commandReadyReason: null,
        });
      return () => {};
    },
  });

  await adapter.connect({ mode: 'embedded' });
  expect(adapter.currentHeight).toBe(4);

  env.state.height = 5;
  env.infrastructure!.stateMutationInFlight = true;
  expect(adapter.currentHeight).toBe(4);

  env.infrastructure!.stateMutationInFlight = false;
  notify?.(env.state.height);
  expect(adapter.currentHeight).toBe(5);
});

test('embedded adapter rejects money commands after the runtime stops accepting work', async () => {
  const env = makeEnv();
  let enqueued = 0;
  let submitted = 0;
  let publishHalted: (() => void) | null = null;
  const adapter = new EmbeddedRuntimeAdapter({
    getEnv: () => env,
    validateRuntimeInputAdmission: () => {},
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
    submitCrossJurisdictionIntent: async () => {
      submitted += 1;
      return { delivered: true };
    },
    registerRuntimePublishedCallback: (_env, callback) => {
      publishHalted = () =>
        callback({
          runtimeId: String(env.runtimeId || ''),
          height: env.state.height,
          timestamp: env.state.timestamp,
          lifecyclePhase: 'halted',
          commandReady: false,
          commandReadyReason: 'phase=halted',
        });
      return () => {};
    },
  });
  await adapter.connect({ mode: 'embedded' });
  expect(adapter.commandReady).toBe(true);
  expect(adapter.commandReadyReason).toBe(null);

  env.infrastructure = { lifecyclePhase: 'halted', halted: true };
  publishHalted?.();
  expect(adapter.commandReady).toBe(false);
  expect(adapter.commandReadyReason).toBe('phase=halted');
  await expect(adapter.send({ runtimeTxs: [], entityInputs: [] })).rejects.toThrow(
    'RUNTIME_COMMAND_NOT_READY:phase=halted',
  );
  await expect(adapter.submitCrossJurisdictionIntent({} as CrossJurisdictionSwapRoute)).rejects.toThrow(
    'RUNTIME_COMMAND_NOT_READY:phase=halted',
  );
  expect(enqueued).toBe(0);
  expect(submitted).toBe(0);
});

test('remote adapter can inspect and control a hub over the rpc wire', async () => {
  const previousWebSocket = globalThis.WebSocket;
  const env = makeEnv();
  const runtimeId = deriveSignerAddressSync(String(env.runtimeSeed), '1').toLowerCase();
  env.runtimeId = runtimeId;
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.profile = { ...replica.state.profile, name: 'H1 Hub', isHub: true };
  const token = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000, {
    audience: runtimeId,
  });
  const enqueued: RuntimeInput[] = [];
  const receipts: unknown[] = [];
  let constructed = 0;

  class HubRpcWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    private readonly serverSocket = {
      send: (message: unknown) => {
        setTimeout(() => this.onmessage?.({ data: message }), 0);
      },
      close: () => {
        this.readyState = HubRpcWebSocket.CLOSED;
        this.onclose?.();
      },
      getBufferedAmount: () => 0,
    };

    constructor(readonly url: string) {
      constructed += 1;
      setTimeout(() => {
        this.readyState = HubRpcWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(raw: unknown): void {
      const request = decodeTestRuntimeAdapterMessage<Record<string, unknown>>(raw);
      void handleRuntimeAdapterMessage(this.serverSocket, request, env, {
        validateRuntimeInputAdmission: (_targetEnv, input) => {
          if (!Array.isArray(input.entityInputs)) throw new Error('entityInputs required');
        },
        enqueueRuntimeInput: (targetEnv, input) => {
          enqueued.push(input);
          targetEnv.state.height = Math.max(0, Math.floor(Number(targetEnv.state.height ?? 0))) + 1;
        },
        controlRuntime: async (targetEnv, action) => ({
          ok: action === 'verify-chain',
          runtimeId: targetEnv.runtimeId,
          verifiedHeight: targetEnv.state.height,
        }),
        registerReceipt: receipt => {
          const registered = {
            ...receipt,
            id: `receipt-${receipts.length + 1}`,
            status: 'pending' as const,
            enqueuedAt: 1,
            expiresAt: 2,
          };
          receipts.push(registered);
          return registered;
        },
        buildRuntimeInputStatusUrl: id => `/api/control/runtime-input/${id}/status`,
        loadEntityViewPage: async () => ({
          core: projectEntityReplicaCoreView(replica.state, replica),
          accounts: {
            items: Array.from(replica.state.accounts.values())
              .slice(0, 10)
              .map(account => projectAccountDoc(account)),
            nextCursor: null,
          },
          books: { items: [], nextCursor: null },
        }),
      });
    }

    close(): void {
      this.readyState = HubRpcWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = HubRpcWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    const heights: number[] = [];
    adapter.onChange(height => heights.push(height));

    await adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://127.0.0.1:8092/rpc',
      runtimeId,
      authKey: token,
      ownerBindingSigner: ({ runtimeId: expectedRuntimeId, challenge, capability }) =>
        ownerBindingSignature(expectedRuntimeId, challenge, capability),
      requestTimeoutMs: 1_000,
      reconnectMaxMs: 1_000,
    });

    expect(constructed).toBe(1);
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    expect(adapter.commandLaneKind).toBe('owner');
    expect(adapter.currentHeight).toBe(7);
    const changesAfterAuth = heights.length;
    broadcastRuntimeAdapterTick(env);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(adapter.currentHeight).toBe(7);
    expect(heights).toHaveLength(changesAfterAuth);

    const view = await adapter.read<{
      height: number;
      entities: Array<{ entityId: string; label: string }>;
      activeEntity: {
        summary: { entityId: string; label: string };
        accounts: { items: unknown[]; nextCursor: string | null };
      };
    }>('view-frame', { entityId, accountsLimit: 10, booksLimit: 10 });
    expect(view.height).toBe(7);
    expect(view.entities.some(entry => entry.entityId === entityId && entry.label === 'H1 Hub')).toBe(true);
    expect(view.activeEntity.summary.entityId).toBe(entityId);
    expect(view.activeEntity.summary.label).toBe('H1 Hub');
    expect(view.activeEntity.accounts.items).toHaveLength(1);
    expect(view.activeEntity.accounts.nextCursor).toBe(null);

    const verification = await adapter.control<{
      ok: boolean;
      runtimeId: string;
      verifiedHeight: number;
    }>('verify-chain');
    expect(verification).toEqual({ ok: true, runtimeId, verifiedHeight: 7 });

    const graph = await adapter.read<{
      height: number;
      stateHash: string;
      entities: Array<{
        summary: { entityId: string };
        core: { entityId: string } | null;
        accounts: { items: unknown[] };
      }>;
    }>('graph-frame', { limit: 10, accountsLimit: 10 });
    expect(graph.height).toBe(7);
    expect(graph.stateHash).toBe('');
    expect(graph.entities.map(entry => entry.summary.entityId)).toEqual([entityId, counterpartyId]);
    expect(graph.entities.find(entry => entry.summary.entityId === entityId)?.accounts.items).toHaveLength(1);
    expect(graph.entities.find(entry => entry.summary.entityId === counterpartyId)?.core).toBeNull();

    const input: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId: 'signer', entityTxs: [] }],
    };
    const sent = await adapter.send(input, {
      commandId: 'remote-control-command-0001',
      commandSequence: 1,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.entityInputs).toEqual(input.entityInputs);
    expect(enqueued[0]?.runtimeTxs.map(tx => tx.type)).toEqual(['recordRuntimeAdapterCommand']);
    expect(sent.height).toBe(7);
    expect(sent.receipt?.id).toBe('receipt-1');
    expect(sent.receipt?.kind).toBe('radapter-runtime-input');
    expect(sent.receipt?.enqueuedHeight).toBe(7);
    expect(sent.statusUrl).toBe('/api/control/runtime-input/receipt-1/status');

    broadcastRuntimeAdapterTick(env);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(adapter.currentHeight).toBe(8);
    expect(heights).toContain(8);

    const head = await adapter.read<{ latestHeight: number }>('head');
    expect(head.latestHeight).toBe(8);
    env.state.height = 12;
    const newerHead = await adapter.read<{ latestHeight: number }>('head');
    expect(newerHead.latestHeight).toBe(12);
    expect(adapter.currentHeight).toBe(12);
    expect(heights).toContain(12);

    env.state.height = 11;
    const laggingHead = await adapter.read<{ latestHeight: number }>('head');
    expect(laggingHead.latestHeight).toBe(11);
    expect(adapter.currentHeight).toBe(12);
    expect(heights.at(-1)).toBe(12);
    adapter.disconnect();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test('remote adapter rejects send without a caller-owned commandId before transport', () => {
  const adapter = new RemoteRuntimeAdapter();
  expect(() => adapter.send({ runtimeTxs: [], entityInputs: [], jInputs: [] })).toThrow(
    'remote runtime send requires a caller-owned commandId',
  );
});

test('storage entity hash docs persist root metadata only', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
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
        state: { ...base.state, rightEntity: id },
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

  expect(firstDoc.cellCount).toBe(accountCount);
  expect('cells' in firstDoc).toBe(false);
  expect(first.entityHashes[0]?.cellCount).toBe(accountCount);
  const firstRootPut = first.merklePuts.find(
    item => Buffer.compare(item.key, keyMerkleRoot(entityId, 'runtime-roots')) === 0,
  );
  const firstRoot = decodeBuffer<StorageMerkleRootDoc>(firstRootPut!.value);
  expect(firstRoot.rootHash).toBe(firstDoc.hash);
  expect(firstRoot.leafCount).toBe(accountCount);
  expect(firstRoot.rootKind).toBe('branch');
  expect(Array.isArray(firstRoot.rootPath)).toBe(true);
  expect(first.merklePuts.every(({ value }) => value.byteLength < MAX_PERSISTED_MERKLE_NODE_BYTES)).toBe(true);

  const unchangedId = `0x${(1).toString(16).padStart(64, '0')}`;
  const unchanged = await prepareStorageStateHashes({
    db: makeMemoryDb(first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer])),
    puts: [
      {
        family: 'account',
        entityId,
        counterpartyId: unchangedId,
        value: projectAccountDoc({
          ...base,
          state: { ...base.state, rightEntity: unchangedId },
          proofHeader: { ...base.proofHeader, toEntity: unchangedId },
        }),
      },
    ],
    dels: [],
    entityHashDocs: first.entityHashDocs,
  });
  expect(unchanged.entityHashDocs.get(entityId)?.hash).toBe(firstDoc.hash);
  expect(unchanged.merklePuts).toHaveLength(0);
  expect(unchanged.merkleDels).toHaveLength(0);

  const oldRoot = firstDoc.hash;
  const changedId = `0x${(2_001).toString(16).padStart(64, '0')}`;
  const second = await prepareStorageStateHashes({
    db: makeMemoryDb([...first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer])]),
    puts: [
      {
        family: 'account',
        entityId,
        counterpartyId: changedId,
        value: projectAccountDoc({
          ...base,
          state: { ...base.state, rightEntity: changedId },
          currentHeight: 999,
          proofHeader: { ...base.proofHeader, toEntity: changedId },
        }),
      },
    ],
    dels: [],
    entityHashDocs: first.entityHashDocs,
  });
  const secondDoc = second.entityHashDocs.get(entityId)!;

  expect(secondDoc.cellCount).toBe(accountCount);
  expect('cells' in secondDoc).toBe(false);
  expect(secondDoc.hash).not.toBe(oldRoot);
  expect(second.merklePuts.length).toBeLessThan(50);
  expect(second.merkleDels).toHaveLength(0);

  const cold = await prepareStorageStateHashes({
    db: makeMemoryDb([...first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer])]),
    puts: [
      {
        family: 'account',
        entityId,
        counterpartyId: changedId,
        value: projectAccountDoc({
          ...base,
          state: { ...base.state, rightEntity: changedId },
          currentHeight: 999,
          proofHeader: { ...base.proofHeader, toEntity: changedId },
        }),
      },
    ],
    dels: [],
  });
  const coldDoc = cold.entityHashDocs.get(entityId)!;
  expect(coldDoc.cellCount).toBe(accountCount);
  expect('cells' in coldDoc).toBe(false);
  expect(coldDoc.hash).toBe(secondDoc.hash);
  expect(cold.merklePuts.length).toBeLessThan(50);

  const staleDoc: StorageEntityHashDoc = {
    entityId,
    hash: `0x${'11'.repeat(32)}`,
    cellCount: 1,
  };
  const staleRuntimeFields = await prepareStorageStateHashes({
    db: makeMemoryDb([...first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer])]),
    puts: [
      {
        family: 'account',
        entityId,
        counterpartyId: changedId,
        value: projectAccountDoc({
          ...base,
          state: { ...base.state, rightEntity: changedId },
          currentHeight: 999,
          proofHeader: { ...base.proofHeader, toEntity: changedId },
        }),
      },
    ],
    dels: [],
    entityHashDocs: new Map([[entityId, staleDoc]]),
  });
  const staleRuntimeDoc = staleRuntimeFields.entityHashDocs.get(entityId)!;
  expect(staleRuntimeDoc.cellCount).toBe(accountCount);
  expect(staleRuntimeDoc.hash).toBe(secondDoc.hash);
  expect(staleRuntimeFields.merklePuts.length).toBeLessThan(50);

  const persistedRootOnly = await prepareStorageStateHashes({
    db: makeMemoryDb([
      [keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica))],
      ...first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer]),
    ]),
    puts: [
      {
        family: 'account',
        entityId,
        counterpartyId: changedId,
        value: projectAccountDoc({
          ...base,
          state: { ...base.state, rightEntity: changedId },
          currentHeight: 999,
          proofHeader: { ...base.proofHeader, toEntity: changedId },
        }),
      },
    ],
    dels: [],
  });
  const persistedRootOnlyDoc = persistedRootOnly.entityHashDocs.get(entityId)!;
  expect(persistedRootOnlyDoc.cellCount).toBe(accountCount);
  expect(persistedRootOnlyDoc.hash).toBe(secondDoc.hash);

  await expect(
    prepareStorageStateHashes({
      db: makeMemoryDb([[keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica))]]),
      puts: [
        {
          family: 'account',
          entityId,
          counterpartyId: changedId,
          value: projectAccountDoc({
            ...base,
            state: { ...base.state, rightEntity: changedId },
            currentHeight: 999,
            proofHeader: { ...base.proofHeader, toEntity: changedId },
          }),
        },
      ],
      dels: [],
    }),
  ).rejects.toThrow('STORAGE_MERKLE_ROOT_MISSING');

  const putThenDelete = await prepareStorageStateHashes({
    db: makeMemoryDb([...first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer])]),
    puts: [
      {
        family: 'account',
        entityId,
        counterpartyId: changedId,
        value: projectAccountDoc({
          ...base,
          state: { ...base.state, rightEntity: changedId },
          currentHeight: 999,
          proofHeader: { ...base.proofHeader, toEntity: changedId },
        }),
      },
    ],
    dels: [{ family: 'account', entityId, counterpartyId: changedId }],
  });
  const merklePutKeys = new Set(putThenDelete.merklePuts.map(item => item.key.toString('hex')));
  expect(putThenDelete.merkleDels.some(key => merklePutKeys.has(key.toString('hex')))).toBe(false);

  const coldDelete = await prepareStorageStateHashes({
    db: makeMemoryDb([...first.merklePuts.map(item => [item.key, item.value] as [Buffer, Buffer])]),
    puts: [],
    dels: [{ family: 'account', entityId, counterpartyId: changedId }],
  });
  const coldDeleteDoc = coldDelete.entityHashDocs.get(entityId)!;
  expect(coldDeleteDoc.cellCount).toBe(accountCount - 1);
  expect(coldDelete.merkleDels.length).toBeGreaterThan(0);
  expect(coldDelete.merklePuts.length).toBeLessThan(50);
});

test('a superseded connection failure cannot close the newer authenticated socket', async () => {
  const previousWebSocket = globalThis.WebSocket;
  const sockets: SupersededAttemptWebSocket[] = [];
  const identityEnv = makeEnv();
  let releaseFirstSigner!: () => void;
  let markFirstSignerStarted!: () => void;
  const firstSignerStarted = new Promise<void>(resolve => { markFirstSignerStarted = resolve; });

  class SupersededAttemptWebSocket {
    static readonly OPEN = 1;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = SupersededAttemptWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(raw: unknown): void {
      const request = decodeTestRuntimeAdapterMessage<{ id: string; op: string; challenge?: string }>(raw);
      if (request.op !== 'auth') return;
      const identity = signRuntimeAdapterServerIdentity(identityEnv, request.challenge || '');
      queueMicrotask(() => this.onmessage?.({
        data: encodeRuntimeAdapterMessage({
          v: 1,
          inReplyTo: request.id,
          ok: true,
          payload: {
            authLevel: 'admin',
            commandLaneKind: 'capability',
            currentHeight: 12,
            nextCommandSequence: 1,
            commandReady: true,
            commandReadyReason: null,
            ...identity,
          },
        }),
      }));
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    SupersededAttemptWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    const firstConnect = adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://localhost/rpc',
      authKey: 'first-token',
      ownerBindingSigner: async () => {
        markFirstSignerStarted();
        await new Promise<void>(resolve => { releaseFirstSigner = resolve; });
        return '0x01';
      },
      requestTimeoutMs: 1_000,
    });
    await firstSignerStarted;

    await adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://localhost/rpc',
      authKey: 'second-token',
      requestTimeoutMs: 1_000,
    });
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    expect(adapter.currentHeight).toBe(12);
    expect(sockets).toHaveLength(2);

    releaseFirstSigner();
    await expect(firstConnect).rejects.toThrow('runtime adapter is not connected');
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    expect(sockets[1]?.readyState).toBe(SupersededAttemptWebSocket.OPEN);
    adapter.disconnect();
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
  }
});
