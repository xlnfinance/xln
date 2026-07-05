import { expect, test } from 'bun:test';
import { createHmac } from 'crypto';

import {
  deriveRuntimeAdapterCapabilityToken,
  resolveRuntimeAdapterAuthSeed,
  verifyRuntimeAdapterAuthCredential,
  verifyRuntimeAdapterAuthKey,
} from '../radapter/auth';
import { decodeRuntimeAdapterMessage, encodeRuntimeAdapterMessage } from '../radapter/codec';
import { EmbeddedRuntimeAdapter } from '../radapter/embedded';
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
  normalizeEntityId,
  textBytes,
} from '../storage/keys';
import { projectAccountDoc, projectEntityCoreDoc } from '../storage/projections';
import { loadEntityAccountDocFromStorage, loadEntityStateFromStorage, loadEntityViewPageFromStorage } from '../storage/read';
import type {
  RuntimeDbLike,
  StorageEntityHashDoc,
  StorageFrameRecord,
  StorageHead,
  StorageMerkleLeafDoc,
  StorageMerkleRootDoc,
  StorageSnapshotManifest,
} from '../storage/types';
import type { Delta, EntityReplica, Env, RuntimeInput } from '../types';
import type { BookState } from '../orderbook';
import { DEFAULT_SPREAD_DISTRIBUTION, type OrderbookExtState } from '../orderbook/types';
import { createGossipLayer, type Profile } from '../networking/gossip';

const entityId = `0x${'aa'.repeat(32)}`;
const counterpartyId = `0x${'bb'.repeat(32)}`;

process.env['XLN_RADAPTER_AUTH_SEED'] = process.env['XLN_RADAPTER_AUTH_SEED'] || 'seed';

const makeHubProfile = (id: string, name: string, lastUpdated = 7): Profile => ({
  entityId: id,
  name,
  avatar: '',
  bio: '',
  website: '',
  lastUpdated,
  runtimeId: `runtime:${name.toLowerCase()}`,
  runtimeEncPubKey: `0x${'11'.repeat(32)}`,
  publicAccounts: [],
  wsUrl: null,
  relays: [],
  metadata: {
    entityEncPubKey: `0x${'22'.repeat(32)}`,
    isHub: true,
    routingFeePPM: 0,
    baseFee: 0n,
    board: {
      threshold: 1,
      validators: [{
        signer: `0x${'33'.repeat(20)}`,
        weight: 1,
        signerId: `0x${'33'.repeat(20)}`,
        publicKey: `0x${'44'.repeat(32)}`,
      }],
    },
    jurisdiction: {
      name: 'Testnet',
      chainId: 31337,
      entityProviderAddress: '0x0000000000000000000000000000000000000001',
      depositoryAddress: '0x0000000000000000000000000000000000000002',
    },
  },
  accounts: [],
});

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

const makeCrowdedBidLevelBook = (price: bigint, orderCount: number): BookState => {
  const orderIds = Array.from({ length: orderCount }, (_, index) => `order-${index.toString().padStart(2, '0')}`);
  const orders = new Map(orderIds.map((orderId, index) => [
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
  ]));
  return {
    ...makeBook(price),
    orders,
    bidBuckets: new Map([[price.toString(), {
      bucketId: price,
      pricesAsc: [price],
      levels: new Map([[price.toString(), {
        priceTicks: price,
        orderIds,
        totalQtyLots: BigInt(orderCount),
      }]]),
    }]]),
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

test('runtime adapter solvency-summary returns compact aggregate metrics only', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  account.deltas.set(1, { ...makeTestDelta(1, 0n), collateral: 100n });
  account.pendingFrame = {
    ...account.currentFrame,
    deltas: [{ ...makeTestDelta(1, 0n), collateral: 50n }],
  };

  const summary = await resolveRuntimeAdapterRead<Record<string, unknown>>({ env }, 'solvency-summary');

  expect(summary).toEqual({
    ok: true,
    height: 7,
    entityCount: 1,
    accountViews: 1,
    m1: 100n,
    m2: 50n,
    m3: 25n,
    total: 75n,
    delta: 25n,
    isValid: false,
  });
  expect(summary).not.toHaveProperty('eReplicas');
  expect(summary).not.toHaveProperty('accounts');
});

test('runtime adapter solvency-summary rejects historical fallback until a projection exists', async () => {
  await expect(resolveRuntimeAdapterRead({ env: makeEnv() }, 'solvency-summary', { atHeight: 6 }))
    .rejects.toThrow('historical solvency-summary reads are not available yet');
});

const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const readTestPageLimit = (raw: unknown, fallback = 10): number => {
  const numeric = Number(raw ?? fallback);
  return Math.max(1, Math.min(500, Number.isFinite(numeric) ? Math.floor(numeric) : fallback));
};

const makeTestViewPageLoader = (env: Env) => async (
  requestedEntityId: string,
  height: number,
  query?: { limit?: number; cursor?: string; accountsLimit?: number; accountsCursor?: string; booksLimit?: number; booksCursor?: string; sortDir?: 'asc' | 'desc' },
) => {
  const normalizedEntityId = String(requestedEntityId).toLowerCase();
  const replica = Array.from(env.eReplicas.values()).find((item) => String(item.entityId).toLowerCase() === normalizedEntityId);
  if (!replica || height !== env.height) return null;
  const accountLimit = readTestPageLimit(query?.accountsLimit ?? query?.limit, 10);
  const accountCursor = String(query?.accountsCursor ?? query?.cursor ?? '').toLowerCase();
  const accountDirection = query?.sortDir === 'desc' ? 'desc' : 'asc';
  const accountIds = Array.from(replica.state.accounts.keys())
    .map((id) => String(id).toLowerCase())
    .sort((left, right) => accountDirection === 'desc' ? compareAscii(right, left) : compareAscii(left, right))
    .filter((id) => !accountCursor || (accountDirection === 'desc' ? id < accountCursor : id > accountCursor));
  const visibleAccountIds = accountIds.slice(0, accountLimit);
  const bookLimit = readTestPageLimit(query?.booksLimit ?? query?.limit, 10);
  const bookCursor = String(query?.booksCursor ?? '').trim();
  const bookPairs = Array.from(replica.state.orderbookExt?.books?.entries?.() ?? [])
    .map(([pairId, book]) => [String(pairId), book] as [string, BookState])
    .sort((left, right) => compareAscii(left[0], right[0]));
  const bookOffset = bookCursor ? Math.max(0, bookPairs.findIndex(([pairId]) => pairId === bookCursor) + 1) : 0;
  const visibleBooks = bookPairs.slice(bookOffset, bookOffset + bookLimit);
  return {
    core: projectEntityCoreDoc(replica.state, replica),
    accounts: {
      items: visibleAccountIds.map((id) => {
        const account = replica.state.accounts.get(id);
        if (!account) throw new Error(`TEST_ACCOUNT_MISSING: ${id}`);
        return projectAccountDoc(account);
      }),
      nextCursor: accountIds.length > accountLimit ? visibleAccountIds[visibleAccountIds.length - 1] ?? null : null,
    },
    books: {
      items: visibleBooks.map(([pairId, book]) => ({ pairId, book })),
      nextCursor: bookOffset + bookLimit < bookPairs.length ? visibleBooks[visibleBooks.length - 1]?.[0] ?? null : null,
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
        .map((item) => item.key)
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
  createHmac('sha256', seed)
    .update(`xln-radapter-v1:${level}`)
    .digest('hex');

const inspectToken = (): string => deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000);

test('runtime adapter capability tokens are scoped by level', () => {
  const readToken = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000);
  const fullToken = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
  expect(readToken).not.toBe(fullToken);
  expect(verifyRuntimeAdapterAuthKey('seed', readToken)).toBe('inspect');
  expect(verifyRuntimeAdapterAuthKey('seed', fullToken)).toBe('admin');
  expect(verifyRuntimeAdapterAuthCredential('seed', readToken)?.level).toBe('inspect');
  expect(verifyRuntimeAdapterAuthCredential('seed', fullToken)?.level).toBe('admin');
  expect(() => deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() - 1)).toThrow('RADAPTER_AUTH_EXPIRY_REQUIRED');
  const flippedSuffix = fullToken.endsWith('0') ? '1' : '0';
  expect(verifyRuntimeAdapterAuthKey('seed', `${fullToken.slice(0, -1)}${flippedSuffix}`)).toBe(null);
});

test('runtime adapter rejects old static auth keys', () => {
  const oldAdmin = oldStaticAuthKey('seed', 'admin');
  const token = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
  expect(verifyRuntimeAdapterAuthCredential('seed', oldAdmin)).toBe(null);
  expect(verifyRuntimeAdapterAuthCredential('seed', token)?.level).toBe('admin');
});

test('runtime adapter rejects legacy four-part capability tokens', () => {
  const exp = Date.now() + 60_000;
  const signature = createHmac('sha256', 'seed')
    .update(`xln-radapter-v1:cap:admin:${exp}`)
    .digest('hex');
  expect(verifyRuntimeAdapterAuthCredential('seed', `xlnra1.full.${exp}.${signature}`)).toBe(null);
});

test('runtime adapter capability tokens are audience scoped and revocable', () => {
  const token = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000, {
    audience: 'runtime-a',
    keyId: 'kid-a',
    tokenId: 'jti-a',
  });
  expect(verifyRuntimeAdapterAuthCredential('seed', token, { audience: 'runtime-a' })?.level).toBe('inspect');
  expect(verifyRuntimeAdapterAuthCredential('seed', token, { audience: 'runtime-b' })).toBe(null);
  expect(verifyRuntimeAdapterAuthCredential('seed', token, {
    audience: 'runtime-a',
    revokedTokenIds: new Set(['jti-a']),
  })).toBe(null);
});

test('runtime adapter capability token ttl is configurable', () => {
  const previous = process.env['XLN_RADAPTER_TOKEN_TTL_MS'];
  process.env['XLN_RADAPTER_TOKEN_TTL_MS'] = '5000';
  const before = Date.now();
  try {
    const token = deriveRuntimeAdapterCapabilityToken('seed', 'read');
    const exp = Number(token.split('.')[2]);
    expect(exp).toBeGreaterThanOrEqual(before + 4_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 6_000);
  } finally {
    if (previous === undefined) delete process.env['XLN_RADAPTER_TOKEN_TTL_MS'];
    else process.env['XLN_RADAPTER_TOKEN_TTL_MS'] = previous;
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

test('runtime adapter runtime seed auth fallback is explicit opt-in', () => {
  const previousNodeEnv = process.env['NODE_ENV'];
  const previousAllowFallback = process.env['XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH'];
  const previousAuthSeed = process.env['XLN_RADAPTER_AUTH_SEED'];
  try {
    delete process.env['NODE_ENV'];
    delete process.env['XLN_RADAPTER_AUTH_SEED'];
    delete process.env['XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH'];
    expect(resolveRuntimeAdapterAuthSeed(makeEnv())).toBe(null);
    process.env['XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH'] = '1';
    expect(resolveRuntimeAdapterAuthSeed(makeEnv())).toBe('seed');
  } finally {
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousNodeEnv;
    if (previousAllowFallback === undefined) delete process.env['XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH'];
    else process.env['XLN_RADAPTER_ALLOW_RUNTIME_SEED_AUTH'] = previousAllowFallback;
    if (previousAuthSeed === undefined) delete process.env['XLN_RADAPTER_AUTH_SEED'];
    else process.env['XLN_RADAPTER_AUTH_SEED'] = previousAuthSeed;
  }
});

test('runtime adapter production auth seed requires entropy', () => {
  const previousNodeEnv = process.env['NODE_ENV'];
  const previousAuthSeed = process.env['XLN_RADAPTER_AUTH_SEED'];
  try {
    process.env['NODE_ENV'] = 'production';
    process.env['XLN_RADAPTER_AUTH_SEED'] = 'short';
    expect(() => resolveRuntimeAdapterAuthSeed(makeEnv())).toThrow('RADAPTER_AUTH_SEED_TOO_WEAK');
    process.env['XLN_RADAPTER_AUTH_SEED'] = 'x'.repeat(32);
    expect(resolveRuntimeAdapterAuthSeed(makeEnv())).toBe('x'.repeat(32));
  } finally {
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousNodeEnv;
    if (previousAuthSeed === undefined) delete process.env['XLN_RADAPTER_AUTH_SEED'];
    else process.env['XLN_RADAPTER_AUTH_SEED'] = previousAuthSeed;
  }
});

test('runtime adapter resolver reads live head and entity paths', async () => {
  const env = makeEnv();
  const ctx = { env, loadEntityViewPage: makeTestViewPageLoader(env) };
  const head = await resolveRuntimeAdapterRead<{ latestHeight: number }>({
    env,
    readHead: async () => null,
  }, 'head');
  const entities = await resolveRuntimeAdapterRead<Array<{ entityId: string; label: string }>>({ env }, 'entities');
  const entity = await resolveRuntimeAdapterRead<{ entityId: string; profile: { name: string } }>({ env }, `entity/${entityId}`);
  const accounts = await resolveRuntimeAdapterRead<{ items: Array<{ currentHeight: number }>; nextCursor: string | null }>(
    ctx,
    `entity/${entityId}/accounts`,
  );

  expect(head.latestHeight).toBe(7);
  expect(entities).toEqual([{ entityId, signerId: 'signer', label: 'Adapter Test', height: 7 }]);
  expect(entity.entityId).toBe(entityId);
  expect(entity.profile.name).toBe('Adapter Test');
  expect(accounts.items).toHaveLength(1);
  expect(accounts.items[0]?.currentHeight).toBe(1);
  expect(accounts.nextCursor).toBe(null);
});

test('runtime adapter direct read paths return compact read snapshots', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)! as any;
  account.watchSeed = `0x${'42'.repeat(32)}`;
  account.mempool = Array.from({ length: 500 }, (_, index) => ({ type: 'memo', data: { index, note: 'm'.repeat(200) } }));
  account.pendingSignatures = Array.from({ length: 500 }, (_, index) => `sig-${index}-${'s'.repeat(200)}`);
  account.currentFrame = {
    ...account.currentFrame,
    accountTxs: Array.from({ length: 500 }, (_, index) => ({ type: 'frame_memo', data: { index, note: 'f'.repeat(200) } })),
    deltas: Array.from({ length: 500 }, (_, index) => ({
      tokenId: index,
      ondelta: BigInt(index),
      offdelta: -BigInt(index),
      collateral: 0n,
    })),
  };
  account.disputeProofBodiesByHash = {
    [`0x${'aa'.repeat(32)}`]: { proof: 'p'.repeat(100_000) },
  };
  account.disputeArgumentSnapshotsByHash = {
    [`0x${'bb'.repeat(32)}`]: { args: 'a'.repeat(100_000) },
  };
  account.settlementWorkspace = { notes: 'w'.repeat(100_000) };
  account.swapOrderHistory = new Map([['history', { note: 'h'.repeat(100_000) }]]);
  account.swapClosedOrders = new Map([['closed', { note: 'c'.repeat(100_000) }]]);
  replica.state.entityEncPrivKey = 'private-key';
  replica.state.nonces = new Map(Array.from({ length: 500 }, (_, index) => [
    `0x${index.toString(16).padStart(64, '0')}`,
    index,
  ]));
  replica.state.crontabState = { tasks: new Map(), hooks: new Map([['heavy', { note: 'x'.repeat(100_000) }]]) } as any;
  replica.state.jBatchState = {
    batch: {
      disputeStarts: Array.from({ length: 80 }, (_, index) => ({
        counterentity: counterpartyId,
        nonce: index + 1,
        proofbodyHash: `0x${'12'.repeat(32)}`,
        watchSeed: `0x${'34'.repeat(32)}`,
        sig: `0x${'56'.repeat(64)}`,
        starterInitialArguments: `0x${'78'.repeat(1024)}`,
        starterIncrementedArguments: `0x${'90'.repeat(1024)}`,
      })),
      notes: 'y'.repeat(100_000),
    },
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'accumulating',
  } as any;

  const liveEntity = await resolveRuntimeAdapterRead<{
    entityEncPrivKey: string;
    nonces: Map<string, number>;
    crontabState?: unknown;
    jBatchState?: {
      batch?: {
        disputeStarts?: Array<{
          watchSeed?: string;
          sig?: string;
          starterInitialArguments?: string;
          starterIncrementedArguments?: string;
        }>;
        notes?: string;
      };
    };
  }>({ env }, `entity/${entityId}`);
  const liveAccount = await resolveRuntimeAdapterRead<{
    watchSeed: string;
    mempool: unknown[];
    pendingSignatures: string[];
    currentFrame: { accountTxs: unknown[]; deltas: unknown[] };
    disputeProofBodiesByHash?: unknown;
    disputeArgumentSnapshotsByHash?: unknown;
    settlementWorkspace?: unknown;
    swapOrderHistory?: unknown;
    swapClosedOrders?: unknown;
  }>({ env }, `entity/${entityId}/account/${counterpartyId}`);
  const historicalEntity = await resolveRuntimeAdapterRead<typeof liveEntity>({
    env,
    loadEntityState: async () => replica.state,
  }, `entity/${entityId}`, { atHeight: env.height - 1 });
  const historicalAccount = await resolveRuntimeAdapterRead<typeof liveAccount>({
    env,
    loadEntityAccountDoc: async () => projectAccountDoc(account),
  }, `entity/${entityId}/account/${counterpartyId}`, { atHeight: env.height - 1 });
  const encodedLiveEntity = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'direct-entity', ok: true, payload: liveEntity });
  const encodedLiveAccount = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'direct-account', ok: true, payload: liveAccount });

  for (const core of [liveEntity, historicalEntity]) {
    expect(core.entityEncPrivKey).toBe('');
    expect(core.nonces.size).toBeLessThanOrEqual(100);
    expect(core.crontabState).toBeUndefined();
    expect(core.jBatchState?.batch?.disputeStarts?.length ?? 0).toBeLessThanOrEqual(50);
    expect(core.jBatchState?.batch?.disputeStarts?.[0]?.watchSeed).toBe('');
    expect(core.jBatchState?.batch?.disputeStarts?.[0]?.sig).toBe('[redacted]');
    expect(core.jBatchState?.batch?.disputeStarts?.[0]?.starterInitialArguments).toBe('[redacted]');
    expect(core.jBatchState?.batch?.disputeStarts?.[0]?.starterIncrementedArguments).toBe('[redacted]');
    expect(core.jBatchState?.batch?.notes).toBeUndefined();
  }
  for (const doc of [liveAccount, historicalAccount]) {
    expect(doc.watchSeed).toBe('');
    expect(doc.mempool).toHaveLength(0);
    expect(doc.pendingSignatures).toHaveLength(0);
    expect(doc.currentFrame.accountTxs.length).toBeLessThanOrEqual(20);
    expect(doc.currentFrame.deltas.length).toBeLessThanOrEqual(100);
    expect(doc.disputeProofBodiesByHash).toBeUndefined();
    expect(doc.disputeArgumentSnapshotsByHash).toBeUndefined();
    expect(doc.settlementWorkspace).toBeUndefined();
    expect(doc.swapOrderHistory).toBeUndefined();
    expect(doc.swapClosedOrders).toBeUndefined();
  }
  expect(encodedLiveEntity.byteLength).toBeLessThan(1_048_576);
  expect(encodedLiveAccount.byteLength).toBeLessThan(1_048_576);
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
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });

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

test('runtime adapter view-frame includes live gossip summaries for visible account peers', async () => {
  const env = makeEnv();
  env.gossip = createGossipLayer();
  env.gossip.announce(makeHubProfile(entityId, 'H1'));
  env.gossip.announce(makeHubProfile(counterpartyId, 'H2'));

  const frame = await resolveRuntimeAdapterRead<{
    entities: Array<{ entityId: string; label: string; isHub?: boolean; jurisdiction?: { name?: string; chainId?: number } }>;
    activeEntity: { accounts: { items: Array<{ leftEntity: string; rightEntity: string }> } } | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });

  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
  expect(frame.entities.find((entry) => entry.entityId === entityId)?.label).toBe('Adapter Test');
  const peer = frame.entities.find((entry) => entry.entityId === counterpartyId);
  expect(peer?.label).toBe('H2');
  expect(peer?.isHub).toBe(true);
  expect(peer?.jurisdiction?.name).toBe('Testnet');
  expect(peer?.jurisdiction?.chainId).toBe(31337);
});

test('runtime adapter entity summaries preserve gossip jurisdiction for live hub replicas', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.profile = { ...replica.state.profile, name: 'H1', isHub: true };
  env.gossip = createGossipLayer();
  env.gossip.announce(makeHubProfile(entityId, 'H1'));

  const entities = await resolveRuntimeAdapterRead<Array<{
    entityId: string;
    label: string;
    isHub?: boolean;
    jurisdiction?: { name?: string; chainId?: number; depositoryAddress?: string };
  }>>({ env }, 'entities');

  const hub = entities.find((entry) => entry.entityId === entityId);
  expect(hub?.label).toBe('H1');
  expect(hub?.runtimeId).toBe('runtime:h1');
  expect(hub?.isHub).toBe(true);
  expect(hub?.jurisdiction?.name).toBe('Testnet');
  expect(hub?.jurisdiction?.chainId).toBe(31337);
  expect(hub?.jurisdiction?.depositoryAddress).toBe('0x0000000000000000000000000000000000000002');
});

test('runtime adapter view-frame exposes compact pending j-batch operations for cockpit actions', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.jBatchState = {
    batch: {
      flashloans: [],
      reserveToReserve: [],
      reserveToCollateral: [],
      collateralToReserve: [],
      settlements: [],
      disputeStarts: [{
        counterentity: counterpartyId,
        nonce: 9,
        proofbodyHash: `0x${'12'.repeat(32)}`,
        watchSeed: `0x${'34'.repeat(32)}`,
        sig: `0x${'56'.repeat(64)}`,
        starterInitialArguments: `0x${'78'.repeat(64)}`,
        starterIncrementedArguments: `0x${'90'.repeat(64)}`,
      }],
      disputeFinalizations: [],
      externalTokenToReserve: [],
      reserveToExternalToken: [],
      revealSecrets: [],
      hub_id: 0,
    },
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'accumulating',
  };

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      core: {
        jBatchState?: {
          batch: {
            disputeStarts: Array<{
              counterentity: string;
              nonce: number;
              watchSeed: string;
              sig: string;
              starterInitialArguments: string;
              starterIncrementedArguments: string;
            }>;
          };
        };
      };
    } | null;
  }>({ env }, 'view-frame', { entityId, accountsLimit: 1, booksLimit: 1 });

  const disputeStarts = frame.activeEntity?.core.jBatchState?.batch.disputeStarts ?? [];
  expect(disputeStarts).toHaveLength(1);
  expect(disputeStarts[0]?.counterentity).toBe(counterpartyId);
  expect(disputeStarts[0]?.nonce).toBe(9);
  expect(disputeStarts[0]?.watchSeed).toBe('');
  expect(disputeStarts[0]?.sig).toBe('[redacted]');
  expect(disputeStarts[0]?.starterInitialArguments).toBe('[redacted]');
  expect(disputeStarts[0]?.starterIncrementedArguments).toBe('[redacted]');
});

test('runtime adapter view frame defaults to the live entity with real relationships', async () => {
  const env = makeEnv();
  const primary = Array.from(env.eReplicas.values())[0]!;
  const emptyEntityId = `0x${'00'.repeat(32)}`;
  env.eReplicas.set(`${emptyEntityId}:empty-signer`, {
    ...primary,
    entityId: emptyEntityId,
    signerId: 'empty-signer',
    state: {
      ...primary.state,
      entityId: emptyEntityId,
      accounts: new Map(),
      orderbookExt: {
        books: new Map(),
        orderPairs: new Map(),
        referrals: new Map(),
        hubProfile: {
          entityId: emptyEntityId,
          name: 'Empty Hub',
          spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
          referenceTokenId: 1,
          minTradeSize: 0n,
          supportedPairs: [],
        },
      },
      profile: { ...primary.state.profile, name: 'Empty Hub', isHub: true },
    },
  } as EntityReplica);

  const frame = await resolveRuntimeAdapterRead<{
    entities: Array<{ entityId: string }>;
    activeEntityId: string | null;
    activeEntity: { accounts: { items: Array<{ rightEntity: string }> } } | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', { accountsLimit: 10, booksLimit: 10 });

  expect(frame.entities.map((entity) => entity.entityId)).toEqual([emptyEntityId, entityId]);
  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
});

test('runtime adapter historical batch without entityId defaults to live entity with real relationships', async () => {
  const env = makeEnv();
  const primary = Array.from(env.eReplicas.values())[0]!;
  const staleEntityId = `0x${'00'.repeat(32)}`;
  const emptyEntityId = `0x${'01'.repeat(32)}`;
  env.eReplicas.set(`${emptyEntityId}:empty-signer`, {
    ...primary,
    entityId: emptyEntityId,
    signerId: 'empty-signer',
    state: {
      ...primary.state,
      entityId: emptyEntityId,
      accounts: new Map(),
      orderbookExt: {
        books: new Map(),
        orderPairs: new Map(),
        referrals: new Map(),
        hubProfile: {
          entityId: emptyEntityId,
          name: 'Empty Hub',
          spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
          referenceTokenId: 1,
          minTradeSize: 0n,
          supportedPairs: [],
        },
      },
      profile: { ...primary.state.profile, name: 'Empty Hub', isHub: true },
    },
  } as EntityReplica);

  const batch = await resolveRuntimeAdapterRead<{
    frames: Array<{
      activeEntityId: string | null;
      activeEntity: { accounts: { items: Array<{ rightEntity: string }> } } | null;
    }>;
    unavailable: Array<{ height: number; code: string; message: string }>;
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
    listEntityIdsAtHeight: async () => [staleEntityId, emptyEntityId, entityId],
    loadEntityViewPage: async (requestedEntityId) => {
      const normalizedEntityId = normalizeEntityId(requestedEntityId);
      if (normalizedEntityId === staleEntityId) return null;
      const replica = Array.from(env.eReplicas.values())
        .find((item) => normalizeEntityId(item.entityId) === normalizedEntityId);
      if (!replica) return null;
      const account = replica.state.accounts.get(counterpartyId);
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: {
          items: account ? [projectAccountDoc(account)] : [],
          nextCursor: null,
        },
        books: { items: [], nextCursor: null },
      };
    },
  }, 'history-frame-batch', {
    heights: [8],
    accountsLimit: 1,
    booksLimit: 1,
  });

  expect(batch.unavailable).toEqual([]);
  expect(batch.frames).toHaveLength(1);
  expect(batch.frames[0]?.activeEntityId).toBe(entityId);
  expect(batch.frames[0]?.activeEntity?.accounts.items).toHaveLength(1);
  expect(batch.frames[0]?.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
});

test('runtime adapter frame read returns compact summary without raw runtime input', async () => {
  const env = makeEnv();
  const runtimeInput = {
    runtimeTxs: [{ type: 'importReplica', entityId, signerId: 'signer', data: { isProposer: true } }],
    jInputs: [],
    entityInputs: [{
      entityId,
      signerId: 'signer',
      entityTxs: [{ type: 'openAccount', data: { counterpartyId } }],
    }],
  } as unknown as RuntimeInput;
  const frame: StorageFrameRecord = {
    height: 7,
    timestamp: 700,
    prevFrameHash: 'prev',
    frameHash: 'frame',
    stateHash: 'state',
    runtimeInput,
    overlayRecords: [{ scope: { family: 'entity', entityId }, key: 'raw', value: new Uint8Array([1, 2, 3]) }],
    touchedEntities: [entityId],
    touchedAccounts: [{ entityId, counterpartyId }],
    touchedBookEntities: [entityId],
  };

  const summary = await resolveRuntimeAdapterRead<Record<string, unknown>>({
    env,
    readFrame: async () => frame,
  }, 'frame/latest');

  expect(summary.runtimeInput).toBeUndefined();
  expect(summary.overlayRecords).toBeUndefined();
  expect(summary.runtimeInputCounts).toEqual({
    runtimeTxs: 1,
    jInputs: 0,
    entityInputs: 1,
    entityTxs: 1,
  });
  expect(summary.touchedCounts).toEqual({
    entities: 1,
    accounts: 1,
    bookEntities: 1,
    overlays: 1,
  });
});

test('runtime adapter receipt read returns ingress receipt status over websocket protocol', async () => {
  const env = makeEnv();
  const receipt = await resolveRuntimeAdapterRead<Record<string, unknown>>({
    env,
    readReceipt: (id) => id === 'receipt-1'
      ? {
          id,
          kind: 'radapter-runtime-input',
          status: 'observed',
          counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
          enqueuedHeight: 7,
          observedHeight: 8,
          createdAt: 1,
          expiresAt: 2,
        }
      : null,
  }, 'receipt/receipt-1');

  expect(receipt.id).toBe('receipt-1');
  expect(receipt.status).toBe('observed');
  expect(receipt.observedHeight).toBe(8);
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
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame');
  expect(first.activeEntity?.accounts.items).toHaveLength(10);
  expect(first.activeEntity?.accounts.nextCursor).toBe(`0x${'0a'.padStart(64, '0')}`);
  expect(first.activeEntity?.accounts.totalItems).toBe(12);
  expect(first.activeEntity?.accounts.pageIndex).toBe(0);
  expect(first.activeEntity?.accounts.pageCount).toBe(2);

  const second = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    nextCursor: string | null;
    prevCursor?: string | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, `entity/${entityId}/accounts`, { accountsPage: 1 });
  expect(second.items).toHaveLength(2);
  expect(second.items.map((item) => item.rightEntity)).toEqual([
    `0x${'0b'.padStart(64, '0')}`,
    `0x${'0c'.padStart(64, '0')}`,
  ]);
  expect(second.nextCursor).toBe(null);
  expect(second.prevCursor).toBe(`0x${'01'.padStart(64, '0')}`);

  const found = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    totalItems?: number;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, `entity/${entityId}/accounts`, {
    accountId: `0x${'0b'.padStart(64, '0')}`,
  });
  expect(found.items.map((item) => item.rightEntity)).toEqual([`0x${'0b'.padStart(64, '0')}`]);
  expect(found.totalItems).toBe(1);
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
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', { entityId: secondEntityId });

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

test('runtime adapter historical view frame skips missing non-active summaries without hiding active entity failures', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const missingEntityId = `0x${'de'.repeat(32)}`;

  const frame = await resolveRuntimeAdapterRead<{
    entities: Array<{ entityId: string }>;
    activeEntityId: string | null;
    activeEntity: { core: { entityId: string } } | null;
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
    listEntityIdsAtHeight: async () => [missingEntityId, entityId],
    loadEntityState: async () => null,
    loadEntityViewPage: async (requestedEntityId) => {
      if (normalizeEntityId(requestedEntityId) !== entityId) return null;
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: { items: [], nextCursor: null },
        books: { items: [], nextCursor: null },
      };
    },
  }, 'view-frame', { atHeight: 8, entityId, accountsLimit: 1 });

  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.entities.map((summary) => summary.entityId)).toEqual([entityId]);

  await expect(resolveRuntimeAdapterRead({
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
    listEntityIdsAtHeight: async () => [missingEntityId, entityId],
    loadEntityState: async () => null,
    loadEntityViewPage: async () => null,
  }, 'view-frame', { atHeight: 8, entityId, accountsLimit: 1 }))
    .rejects.toThrow('entity summary not found at height');
});

test('runtime adapter live view-frame stays live if env height advances during projection', async () => {
  const env = makeEnv();
  env.height = 8;
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.height = 8;
  let historicalListingCalled = false;

  const frame = await resolveRuntimeAdapterRead<{
    height: number;
    entities: Array<{ entityId: string }>;
    activeEntity: { core: { entityId: string } } | null;
  }>({
    env,
    readHead: async () => {
      env.height = 9;
      replica.state.height = 9;
      return {
        schemaVersion: 1,
        latestHeight: 9,
        latestMaterializedHeight: 8,
        latestSnapshotHeight: 8,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        retainedHistoryBytes: 0,
      };
    },
    listEntityIdsAtHeight: async () => {
      historicalListingCalled = true;
      return [`0x${'de'.repeat(32)}`, entityId];
    },
    loadEntityViewPage: async () => ({
      core: projectEntityCoreDoc(replica.state, replica),
      accounts: { items: [], nextCursor: null },
      books: { items: [], nextCursor: null },
    }),
  }, 'view-frame', { entityId, accountsLimit: 1 });

  expect(historicalListingCalled).toBe(false);
  expect(frame.height).toBe(8);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.entities.map((summary) => summary.entityId)).toContain(entityId);
});

test('runtime adapter history-frame-batch returns bounded historical view frames in one read', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  const loadedHeights: number[] = [];

  const batch = await resolveRuntimeAdapterRead<{
    requestedHeights: number[];
    frames: Array<{
      height: number;
      activeEntity: { accounts: { items: Array<{ rightEntity: string }> } } | null;
    }>;
    unavailable: Array<{ height: number; code: string; message: string }>;
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
    loadEntityViewPage: async (_entityId, height) => {
      loadedHeights.push(height);
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: { items: [projectAccountDoc(account)], nextCursor: null },
        books: { items: [], nextCursor: null },
      };
    },
  }, 'history-frame-batch', {
    heights: [8, 9, 10],
    entityId,
    accountsLimit: 1,
    booksLimit: 1,
  });

  expect(batch.requestedHeights).toEqual([8, 9, 10]);
  expect(batch.frames.map((frame) => frame.height)).toEqual([8, 9]);
  expect(batch.frames.every((frame) => frame.activeEntity?.accounts.items.length === 1)).toBe(true);
  expect(batch.frames.every((frame) => frame.activeEntity?.accounts.items[0]?.rightEntity === counterpartyId)).toBe(true);
  expect(batch.unavailable).toHaveLength(1);
  expect(batch.unavailable[0]?.height).toBe(10);
  expect(batch.unavailable[0]?.code).toBe('E_NOT_FOUND');
  expect(loadedHeights).toEqual([8, 8, 9, 9]);
});

test('runtime adapter history-frame-batch marks missing storage diffs unavailable without failing the batch', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;

  const batch = await resolveRuntimeAdapterRead<{
    frames: Array<{ height: number }>;
    unavailable: Array<{ height: number; code: string; message: string }>;
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
    loadEntityViewPage: async (_entityId, height) => {
      if (height === 8) throw new Error(`STORAGE_DIFF_MISSING: height=${height} scope=entity:${entityId}`);
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: { items: [projectAccountDoc(account)], nextCursor: null },
        books: { items: [], nextCursor: null },
      };
    },
  }, 'history-frame-batch', {
    heights: [8, 9],
    entityId,
    accountsLimit: 1,
    booksLimit: 1,
  });

  expect(batch.frames.map((frame) => frame.height)).toEqual([9]);
  expect(batch.unavailable).toHaveLength(1);
  expect(batch.unavailable[0]).toMatchObject({
    height: 8,
    code: 'E_NOT_FOUND',
  });
  expect(batch.unavailable[0]?.message).toContain('STORAGE_DIFF_MISSING');
});

test('runtime adapter history-frame-batch fails fast on malformed queries', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({ env }, 'history-frame-batch', { heights: ['1.5'] }))
    .rejects.toThrow('heights must be positive integers');
});

test('runtime adapter activity read uses typed projection context', async () => {
  const env = makeEnv();
  const seen: unknown[] = [];

  const page = await resolveRuntimeAdapterRead<{
    ok: true;
    runtimeId?: string;
    latestHeight: number;
    events: Array<{ id: string; type: string }>;
  }>({
    env,
    readActivityPage: async (opts) => {
      seen.push(opts);
      return {
        ok: true,
        runtimeId: 'activity-runtime',
        latestHeight: 12,
        fromHeight: 9,
        toHeight: 12,
        scannedFrames: 4,
        returned: 1,
        limit: 40,
        scanLimit: 100,
        nextBeforeHeight: 8,
        filters: opts,
        events: [{
          id: 'event-1',
          height: 12,
          timestamp: 1000,
          kind: 'offchain',
          type: 'payment',
          source: 'runtime_input',
          direction: 'out',
          title: 'Payment sent',
          subtitle: 'to peer',
          status: 'accepted',
          rawType: 'directPayment',
        }],
      };
    },
  }, 'activity', {
    entityId,
    kind: 'offchain',
    types: 'payment,htlc',
    q: 'accepted',
    beforeHeight: 12,
    limit: 40,
    scanLimit: 100,
  });

  expect(page.latestHeight).toBe(12);
  expect(page.events).toHaveLength(1);
  expect(seen).toEqual([{
    entityId,
    kind: 'offchain',
    types: ['payment', 'htlc'],
    query: 'accepted',
    fromTimestamp: undefined,
    toTimestamp: undefined,
    beforeHeight: 12,
    limit: 40,
    scanLimit: 100,
  }]);
});

test('runtime adapter activity read forwards bounded deep scan requests', async () => {
  const env = makeEnv();
  const seen: unknown[] = [];

  await resolveRuntimeAdapterRead({
    env,
    readActivityPage: async (opts) => {
      seen.push(opts);
      return {
        ok: true,
        runtimeId: 'activity-runtime',
        latestHeight: 1000,
        fromHeight: 1,
        toHeight: 1000,
        scannedFrames: 1000,
        returned: 0,
        limit: 80,
        scanLimit: 1000,
        nextBeforeHeight: null,
        filters: opts,
        events: [],
      };
    },
  }, 'activity', {
    entityId,
    kind: 'offchain',
    types: ['payment'],
    limit: 80,
    scanLimit: 1000,
  });

  expect(seen).toEqual([{
    entityId,
    kind: 'offchain',
    types: ['payment'],
    query: '',
    fromTimestamp: undefined,
    toTimestamp: undefined,
    beforeHeight: undefined,
    limit: 80,
    scanLimit: 1000,
  }]);
});

test('runtime adapter activity read fails fast on malformed queries', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({ env, readActivityPage: async () => {
    throw new Error('reader should not run');
  } }, 'activity', { kind: 'bad-kind' as never }))
    .rejects.toThrow('activity kind must be all, onchain, or offchain');

  await expect(resolveRuntimeAdapterRead({ env, readActivityPage: async () => {
    throw new Error('reader should not run');
  } }, 'activity', { entityId: 'alice' }))
    .rejects.toThrow('activity entityId must be 0x + 64 hex chars');

  await expect(resolveRuntimeAdapterRead({ env }, 'activity', { entityId }))
    .rejects.toThrow('activity reads are unavailable for this adapter');
});

test('runtime adapter historical reads fail closed when storage loaders are missing', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({ env }, 'entities', { atHeight: env.height - 1 }))
    .rejects.toThrow('storage entity listing is required for historical reads');
  await expect(resolveRuntimeAdapterRead({ env }, 'head', { atHeight: env.height - 1 }))
    .rejects.toThrow('storage head reader is required for historical reads');
  await expect(resolveRuntimeAdapterRead({ env, listEntityIdsAtHeight: async () => [entityId] }, 'view-frame', { atHeight: env.height - 1 }))
    .rejects.toThrow('storage head reader is required for historical reads');
});

test('runtime adapter historical view frame fails closed when storage head is missing', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({
    env,
    readHead: async () => null,
    listEntityIdsAtHeight: async () => [entityId],
    loadEntityViewPage: async () => {
      throw new Error('view page loader should not run after missing head');
    },
  }, 'view-frame', { atHeight: env.height - 1 }))
    .rejects.toThrow('storage head not found at height');
});

test('runtime adapter historical entity summaries fail closed when listed state is missing', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({
    env,
    listEntityIdsAtHeight: async () => [entityId],
    loadEntityViewPage: async () => null,
    loadEntityState: async () => null,
  }, 'entities', { atHeight: env.height - 1 }))
    .rejects.toThrow('entity summary not found at height');
});

test('runtime adapter historical head reads persisted storage head', async () => {
  const env = makeEnv();
  const head = await resolveRuntimeAdapterRead<{ latestHeight: number; latestSnapshotHeight: number }>({
    env,
    readHead: async () => ({
      schemaVersion: 1,
      latestHeight: 42,
      latestMaterializedHeight: 41,
      latestSnapshotHeight: 40,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 123,
    }),
  }, 'head', { atHeight: env.height - 1 });

  expect(head.latestHeight).toBe(42);
  expect(head.latestSnapshotHeight).toBe(40);
});

test('runtime adapter current head exposes persisted snapshot cadence when storage is available', async () => {
  const env = makeEnv();
  env.height = 45;
  const storedHead: StorageHead = {
    schemaVersion: 1,
    latestHeight: 45,
    latestMaterializedHeight: 45,
    latestSnapshotHeight: 40,
    snapshotPeriodFrames: 5,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    retainedHistoryBytes: 1234,
  };

  const head = await resolveRuntimeAdapterRead<StorageHead>({
    env,
    readHead: async () => storedHead,
  }, 'head');
  const frame = await resolveRuntimeAdapterRead<{ head: StorageHead }>({
    env,
    readHead: async () => storedHead,
    loadEntityViewPage: makeTestViewPageLoader(env),
  }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });

  expect(head.latestHeight).toBe(45);
  expect(head.latestSnapshotHeight).toBe(40);
  expect(head.snapshotPeriodFrames).toBe(5);
  expect(head.retainedHistoryBytes).toBe(1234);
  expect(frame.head.latestSnapshotHeight).toBe(40);
  expect(frame.head.snapshotPeriodFrames).toBe(5);
});

test('runtime adapter current head preserves persisted snapshot cadence when storage lags live height', async () => {
  const env = makeEnv();
  env.height = 19;
  const storedHead: StorageHead = {
    schemaVersion: 1,
    latestHeight: 16,
    latestMaterializedHeight: 16,
    latestSnapshotHeight: 16,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    retainedHistoryBytes: 4321,
  };

  const head = await resolveRuntimeAdapterRead<StorageHead>({
    env,
    readHead: async () => storedHead,
  }, 'head');

  expect(head.latestHeight).toBe(19);
  expect(head.latestSnapshotHeight).toBe(16);
  expect(head.snapshotPeriodFrames).toBe(256);
  expect(head.retainedHistoryBytes).toBe(4321);
});

test('runtime adapter rejects historical reads beyond the persisted storage head', async () => {
  const env = makeEnv();
  env.height = 20;
  const persistedHead: StorageHead = {
    schemaVersion: 1,
    latestHeight: 8,
    latestMaterializedHeight: 8,
    latestSnapshotHeight: 8,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    retainedHistoryBytes: 0,
  };
  let listedEntities = false;

  await expect(resolveRuntimeAdapterRead({
    env,
    readHead: async () => persistedHead,
  }, 'head', { atHeight: 9 })).rejects.toThrow('head height unavailable');

  await expect(resolveRuntimeAdapterRead({
    env,
    readHead: async () => persistedHead,
    listEntityIdsAtHeight: async () => {
      listedEntities = true;
      return [entityId];
    },
  }, 'entities', { atHeight: 9 })).rejects.toThrow('entity summary height unavailable');
  expect(listedEntities).toBe(false);

  await expect(resolveRuntimeAdapterRead({
    env,
    readHead: async () => persistedHead,
    listEntityIdsAtHeight: async () => {
      throw new Error('future view-frame must not list entities');
    },
    loadEntityViewPage: async () => {
      throw new Error('future view-frame must not load entity pages');
    },
  }, 'view-frame', { atHeight: 9 })).rejects.toThrow('view-frame height unavailable');
});

test('runtime adapter historical account search uses the point storage loader', async () => {
  const env = makeEnv();
  env.height = 9;
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  let viewPageCalled = false;
  let pointLookup: { entityId: string; counterpartyId: string; height: number } | null = null;

  const result = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    totalItems?: number;
  }>({
    env,
    loadEntityAccountDoc: async (requestedEntityId, requestedCounterpartyId, height) => {
      pointLookup = { entityId: requestedEntityId, counterpartyId: requestedCounterpartyId, height };
      return projectAccountDoc(account);
    },
    loadEntityViewPage: async () => {
      viewPageCalled = true;
      return null;
    },
  }, `entity/${entityId}/accounts`, {
    atHeight: 8,
    accountId: counterpartyId,
    accountsLimit: 1,
  });

  expect(result.items.map((item) => item.rightEntity)).toEqual([counterpartyId]);
  expect(result.totalItems).toBe(1);
  expect(pointLookup).toEqual({ entityId, counterpartyId, height: 8 });
  expect(viewPageCalled).toBe(false);
});

test('runtime adapter current view frame prefers storage page loader when current height is persisted', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const storedOnlyCounterpartyId = `0x${'cc'.repeat(32)}`;
  const account = replica.state.accounts.get(counterpartyId)!;
  const storedDoc = projectAccountDoc({
    ...account,
    rightEntity: storedOnlyCounterpartyId,
    proofHeader: { ...account.proofHeader, toEntity: storedOnlyCounterpartyId },
  });
  let pagedLoadCalled: { entityId: string; height: number } | null = null;

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      accounts: {
        items: Array<{ rightEntity: string }>;
        summary?: { totalItems: number | null; visibleItems: number; sampleIds: string[] };
      };
    } | null;
  }>({
    env,
    readHead: async () => ({
      schemaVersion: 1,
      latestHeight: env.height,
      latestMaterializedHeight: env.height,
      latestSnapshotHeight: 0,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 0,
    }),
    loadEntityViewPage: async (requestedEntityId, height) => {
      pagedLoadCalled = { entityId: requestedEntityId, height };
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: {
          items: [storedDoc],
          nextCursor: 'next-page',
          firstCursor: storedOnlyCounterpartyId,
          lastCursor: storedOnlyCounterpartyId,
          pageIndex: 0,
          pageCount: 1_000_000,
          totalItems: 1_000_000,
          limit: 1,
        },
        books: { items: [], nextCursor: null, pageIndex: 0, pageCount: 0, totalItems: 0, limit: 1 },
      };
    },
  }, 'view-frame', { accountsLimit: 1 });

  expect(pagedLoadCalled).toEqual({ entityId, height: env.height });
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(storedOnlyCounterpartyId);
  expect(frame.activeEntity?.accounts.summary).toMatchObject({
    totalItems: 1_000_000,
    visibleItems: 1,
    sampleIds: [storedOnlyCounterpartyId],
  });
});

test('runtime adapter 1M account view-frame stays aggregate-first and under wire budget', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  let loaderCalls = 0;
  const visibleDocs = Array.from({ length: 10 }, (_, index) => {
    const id = `0x${(index + 1).toString(16).padStart(64, '0')}`;
    return projectAccountDoc({
      ...account,
      rightEntity: id,
      currentFrame: {
        ...account.currentFrame,
        stateHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      },
      deltas: new Map([[1, makeTestDelta(1, BigInt(index + 1) * 1_000n)]]),
      proofHeader: { ...account.proofHeader, toEntity: id },
    });
  });

  const startedAt = Date.now();
  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      accounts: {
        items: Array<{ rightEntity: string }>;
        nextCursor: string | null;
        summary?: {
          totalItems: number | null;
          visibleItems: number;
          hasMore: boolean;
          sampleIds: string[];
          pageStateHashes: string[];
          visibleTopDeltas: Array<{ counterpartyId: string; tokenId: number; delta: string }>;
        };
      };
    } | null;
  }>({
    env,
    readHead: async () => ({
      schemaVersion: 1,
      latestHeight: env.height,
      latestMaterializedHeight: env.height,
      latestSnapshotHeight: env.height,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      retainedHistoryBytes: 0,
    }),
    loadEntityViewPage: async () => {
      loaderCalls += 1;
      return {
        core: projectEntityCoreDoc(replica.state, replica),
        accounts: {
          items: visibleDocs,
          nextCursor: visibleDocs[visibleDocs.length - 1]!.rightEntity,
          firstCursor: visibleDocs[0]!.rightEntity,
          lastCursor: visibleDocs[visibleDocs.length - 1]!.rightEntity,
          pageIndex: 0,
          pageCount: 100_000,
          totalItems: 1_000_000,
          limit: 10,
        },
        books: { items: [], nextCursor: null, pageIndex: 0, pageCount: 0, totalItems: 0, limit: 10 },
      };
    },
  }, 'view-frame', { entityId, accountsLimit: 10, booksLimit: 10 });
  const elapsedMs = Date.now() - startedAt;
  const encoded = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'budget', ok: true, payload: frame });

  expect(loaderCalls).toBe(1);
  expect(elapsedMs).toBeLessThan(100);
  expect(encoded.byteLength).toBeLessThan(100_000);
  expect(frame.activeEntity?.accounts.items).toHaveLength(10);
  expect(frame.activeEntity?.accounts.summary).toMatchObject({
    totalItems: 1_000_000,
    visibleItems: 10,
    hasMore: true,
  });
  expect(frame.activeEntity?.accounts.summary?.sampleIds).toHaveLength(8);
  expect(frame.activeEntity?.accounts.summary?.pageStateHashes).toHaveLength(8);
  expect(frame.activeEntity?.accounts.summary?.visibleTopDeltas[0]).toMatchObject({
    tokenId: 1,
    delta: '10000',
  });
});

test('runtime adapter view-frame caps route-heavy core maps under wire budget', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const largeNote = 'x'.repeat(4_000);
  replica.state.entityEncPrivKey = 'secret-key-must-not-leave-server';
  replica.state.crossJurisdictionSwaps = new Map();
  for (let index = 0; index < 400; index += 1) {
    const id = `route-${index.toString().padStart(3, '0')}`;
    const route = {
      orderId: id,
      makerEntityId: entityId,
      hubEntityId: counterpartyId,
      source: {
        jurisdiction: 'Testnet',
        entityId,
        counterpartyEntityId: counterpartyId,
        tokenId: 1,
        amount: 1n,
      },
      target: {
        jurisdiction: 'Tron',
        entityId: counterpartyId,
        counterpartyEntityId: entityId,
        tokenId: 2,
        amount: 1n,
      },
      status: 'resting',
      createdAt: index,
      updatedAt: index,
      note: largeNote,
    };
    replica.state.htlcRoutes.set(id, { id, note: largeNote } as any);
    replica.state.htlcNotes?.set(id, largeNote);
    replica.state.crossJurisdictionSwaps.set(id, route as any);
  }

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      core: {
        entityEncPrivKey: string;
        htlcRoutes: Map<string, unknown>;
        htlcNotes?: Map<string, unknown>;
        crossJurisdictionSwaps?: Map<string, unknown>;
        pendingCrossJurisdictionFillAcks?: Map<string, unknown>;
        crossJurisdictionBookAdmissions?: Map<string, unknown>;
      };
    } | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });
  const encoded = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'route-budget', ok: true, payload: frame });
  const core = frame.activeEntity?.core;

  expect(encoded.byteLength).toBeLessThan(1_048_576);
  expect(core?.entityEncPrivKey).toBe('');
  expect(core?.htlcRoutes.size).toBeLessThanOrEqual(20);
  expect(core?.htlcNotes?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.crossJurisdictionSwaps?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.pendingCrossJurisdictionFillAcks?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.crossJurisdictionBookAdmissions?.size ?? 0).toBeLessThanOrEqual(20);
});

test('runtime adapter view-frame excludes unbounded core internals from remote snapshots', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.nonces = new Map(Array.from({ length: 50_000 }, (_, index) => [
    `0x${index.toString(16).padStart(64, '0')}`,
    index,
  ]));
  replica.state.crontabState = {
    tasks: new Map(),
    hooks: new Map(Array.from({ length: 10_000 }, (_, index) => [
      `hook-${index.toString().padStart(5, '0')}`,
      { method: 'hub_rebalance_kick', executeAt: index, payload: { note: 'x'.repeat(200) } },
    ])),
  } as any;
  replica.state.jBatchState = {
    batch: { settlements: Array.from({ length: 10_000 }, (_, index) => ({ id: index, note: 'y'.repeat(200) })) },
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'idle',
  } as any;
  replica.state.orderbookExt = makeOrderbookExt(new Map());
  replica.state.orderbookExt.hubProfile.supportedPairs = Array.from({ length: 5_000 }, (_, index) => `1/${index + 2}`);
  replica.state.orderbookExt.referrals = new Map(Array.from({ length: 50_000 }, (_, index) => {
    const id = `0x${(index + 1).toString(16).padStart(64, '0')}`;
    return [id, { entityId: id, referrerId: null, timestamp: index }];
  }));

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      core: {
        nonces: Map<string, number>;
        crontabState?: unknown;
        jBatchState?: {
          batch?: {
            settlements?: Array<{
              note?: string;
              sig?: string;
              hankoData?: string;
            }>;
          };
        };
        orderbookHubProfile?: { supportedPairs: string[] };
        orderbookReferrals?: Map<string, unknown>;
      };
    } | null;
  }>({ env }, 'view-frame', { entityId, accountsLimit: 1, booksLimit: 1 });
  const encoded = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'core-budget', ok: true, payload: frame });
  const core = frame.activeEntity?.core;

  expect(encoded.byteLength).toBeLessThan(1_048_576);
  expect(core?.nonces.size ?? 0).toBeLessThanOrEqual(100);
  expect(core?.orderbookHubProfile?.supportedPairs.length ?? 0).toBeLessThanOrEqual(50);
  expect(core?.orderbookReferrals?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.crontabState).toBeUndefined();
  expect(core?.jBatchState?.batch?.settlements?.length ?? 0).toBeLessThanOrEqual(50);
  expect(core?.jBatchState?.batch?.settlements?.[0]?.note?.length ?? 0).toBeLessThanOrEqual(200);
  expect(core?.jBatchState?.batch?.settlements?.[0]?.sig).toBe('');
  expect(core?.jBatchState?.batch?.settlements?.[0]?.hankoData).toBe('');
});

test('runtime adapter view-frame excludes unbounded account internals from remote snapshots', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)! as any;
  account.watchSeed = `0x${'11'.repeat(32)}`;
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
  account.leftJObservations = Array.from({ length: 5_000 }, (_, index) => ({
    jHeight: index,
    jBlockHash: `0x${index.toString(16).padStart(64, '0')}`,
    events: [{ kind: 'left', payload: 'l'.repeat(160) }],
    observedAt: index,
  }));
  account.rightJObservations = Array.from({ length: 5_000 }, (_, index) => ({
    jHeight: index,
    jBlockHash: `0x${index.toString(16).padStart(64, '0')}`,
    events: [{ kind: 'right', payload: 'r'.repeat(160) }],
    observedAt: index,
  }));
  account.jEventChain = Array.from({ length: 5_000 }, (_, index) => ({
    jHeight: index,
    jBlockHash: `0x${index.toString(16).padStart(64, '0')}`,
    events: [{ kind: 'final', payload: 'f'.repeat(160) }],
    finalizedAt: index,
  }));
  account.abiProofBody = {
    encodedProofBody: `0x${'ab'.repeat(500_000)}`,
    proofBodyHash: `0x${'cd'.repeat(32)}`,
    lastUpdatedHeight: 1,
  };
  account.disputeProofBodiesByHash = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
    `0x${index.toString(16).padStart(64, '0')}`,
    { proof: 'p'.repeat(800) },
  ]));
  account.disputeArgumentSnapshotsByHash = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
    `0x${(index + 1).toString(16).padStart(64, '0')}`,
    { args: 'a'.repeat(800) },
  ]));
  account.settlementWorkspace = { notes: 's'.repeat(500_000) };
  account.swapOrderHistory = new Map(Array.from({ length: 20_000 }, (_, index) => [
    `history-${index}`,
    { offerId: `history-${index}`, status: 'closed', note: 'h'.repeat(120) },
  ]));
  account.swapClosedOrders = new Map(Array.from({ length: 20_000 }, (_, index) => [
    `closed-${index}`,
    { offerId: `closed-${index}`, status: 'closed', note: 'c'.repeat(120) },
  ]));

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
        }>;
      };
    } | null;
  }>({ env }, 'view-frame', { entityId, accountsLimit: 1, booksLimit: 1 });
  const encoded = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'account-budget', ok: true, payload: frame });
  const compact = frame.activeEntity?.accounts.items[0];

  expect(encoded.byteLength).toBeLessThan(1_048_576);
  expect(compact?.watchSeed).toBe('');
  expect(compact?.mempool).toHaveLength(0);
  expect(compact?.pendingSignatures).toHaveLength(0);
  expect(compact?.currentFrame.accountTxs.length ?? 0).toBeLessThanOrEqual(20);
  expect(compact?.currentFrame.deltas.length ?? 0).toBeLessThanOrEqual(100);
  expect(compact?.pendingFrame?.accountTxs.length ?? 0).toBeLessThanOrEqual(20);
  expect(compact?.pendingFrame?.deltas.length ?? 0).toBeLessThanOrEqual(100);
  expect(compact?.abiProofBody).toBeUndefined();
  expect(compact?.disputeProofBodiesByHash).toBeUndefined();
  expect(compact?.disputeArgumentSnapshotsByHash).toBeUndefined();
  expect(compact?.settlementWorkspace).toBeUndefined();
  expect(compact?.swapOrderHistory).toBeUndefined();
  expect(compact?.swapClosedOrders).toBeUndefined();
});

test('storage-backed historical view pages support desc account and book cursors', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  const baseAccount = replica.state.accounts.get(counterpartyId)!;
  const snapshotHeight = 4;
  const latestHeight = 5;
  const accountIds = [1, 2, 3, 4].map((value) => `0x${value.toString(16).padStart(64, '0')}`);
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
  const manifest: StorageSnapshotManifest = { height: snapshotHeight, createdAt: 400, docCount: 7 };
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
  expect(first?.accounts.items.map((item) => item.rightEntity)).toEqual([accountIds[3], accountIds[2]]);
  expect(first?.accounts.nextCursor).toBe(accountIds[2]);
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
  expect(second?.accounts.items.map((item) => item.rightEntity)).toEqual([accountIds[1], accountIds[0]]);
  expect(second?.accounts.nextCursor).toBe(null);
  expect(second?.books.items.map((item) => item.pairId)).toEqual(['1/2']);
  expect(second?.books.nextCursor).toBe(null);
});

test('storage readers reject requested heights beyond the persisted head', async () => {
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
  const db = makeMemoryDb([
    [KEY_HEAD, encodeBuffer(head)],
    [keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica.state, replica))],
    [keyLiveAccount(entityId, counterpartyId), encodeBuffer(projectAccountDoc(account))],
  ]);
  const futureHeight = env.height + 1;

  await expect(loadEntityStateFromStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    entityId,
    height: futureHeight,
  })).rejects.toThrow('STORAGE_HEIGHT_UNAVAILABLE');

  await expect(loadEntityAccountDocFromStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    entityId,
    counterpartyId,
    height: futureHeight,
  })).rejects.toThrow('STORAGE_HEIGHT_UNAVAILABLE');

  await expect(loadEntityViewPageFromStorage({
    env,
    tryOpenDb: async () => true,
    getRuntimeDb: () => db,
    entityId,
    height: futureHeight,
  })).rejects.toThrow('STORAGE_HEIGHT_UNAVAILABLE');
});

test('storage live recovery verifies doc values through merkle leaves', async () => {
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
    const db = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
      [keyLiveAccount(entityId, counterpartyId), prepared.docValueBuffers.get(`a:${entityId}:${counterpartyId}`)!],
      ...prepared.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
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

test('storage live recovery rejects live docs that do not match merkle leaf value hashes', async () => {
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
    const corruptedAccountRaw = encodeBuffer({ ...accountDoc, currentHeight: accountDoc.currentHeight + 1 });
    const db = makeMemoryDb([
      [KEY_HEAD, encodeBuffer(head)],
      [keyLiveEntity(entityId), prepared.docValueBuffers.get(`e:${entityId}`)!],
      [keyLiveAccount(entityId, counterpartyId), corruptedAccountRaw],
      ...prepared.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
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
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, `entity/${entityId}/accounts`, { limit: 3 });
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
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, `entity/${entityId}/books`);
  expect(books.items).toHaveLength(10);
  expect(books.nextCursor).toBeTruthy();
});

test('runtime adapter compact book view preserves full level depth while trimming visible orders', async () => {
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.orderbookExt = makeOrderbookExt(new Map([
    ['1/2', makeCrowdedBidLevelBook(100n, 25)],
  ]));

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

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-1', op: 'auth', key: inspectToken() }, env, {
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

test('runtime adapter websocket handler rejects send under inspect auth', async () => {
  const messages: unknown[] = [];
  const socket = { send: (message: unknown) => { messages.push(message); } };
  const env = makeEnv();
  let enqueued = 0;

  await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth-1', op: 'auth', key: inspectToken() }, env, {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
  });
  const authed = decodeRuntimeAdapterMessage<{ ok: true; payload: { authLevel: string } }>(messages.pop());
  expect(authed.ok).toBe(true);
  expect(authed.payload.authLevel).toBe('inspect');

  await handleRuntimeAdapterMessage(socket, {
    v: 1,
    id: 'send-1',
    op: 'send',
    input: {
      runtimeTxs: [],
      entityInputs: [],
    },
  }, env, {
    enqueueRuntimeInput: () => {
      enqueued += 1;
    },
  });

  const denied = decodeRuntimeAdapterMessage<{ ok: false; error: { code: string; message: string } }>(messages.pop());
  expect(denied.ok).toBe(false);
  expect(denied.error.code).toBe('E_UNAUTHORIZED');
  expect(denied.error.message).toContain('admin auth required');
  expect(enqueued).toBe(0);
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
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth', op: 'auth', key: inspectToken() }, env, {
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

  await handleRuntimeAdapterMessage(inspectSocket, { v: 1, id: 'auth-inspect', op: 'auth', key: inspectToken() }, env, {
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
    await handleRuntimeAdapterMessage(socket, { v: 1, id: 'auth', op: 'auth', key: inspectToken() }, env, {
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

test('embedded adapter sends to the latest active env after runtime switch', async () => {
  const staleEnv = makeEnv();
  staleEnv.height = 1;
  staleEnv.eReplicas = new Map();

  const activeEnv = makeEnv();
  activeEnv.height = 5;

  let currentEnv: Env | null = staleEnv;
  const writtenEnv: Env[] = [];
  const adapter = new EmbeddedRuntimeAdapter({
    getEnv: () => currentEnv,
    enqueueRuntimeInput: (env, input) => {
      writtenEnv.push(env);
      expect(input.entityInputs?.[0]?.entityId).toBe(entityId);
      env.height = Math.max(0, Math.floor(Number(env.height ?? 0))) + 1;
    },
    registerEnvChangeCallback: () => () => {},
  });

  await adapter.connect({ mode: 'embedded' });
  currentEnv = activeEnv;

  await adapter.send({
    runtimeTxs: [],
    entityInputs: [{
      entityId,
      signerId: 'signer',
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: counterpartyId, tokenId: 1, creditAmount: 1n } }],
    }],
  });

  expect(writtenEnv).toEqual([activeEnv]);
  expect(staleEnv.height).toBe(1);
  expect(activeEnv.height).toBe(6);
  expect(adapter.currentHeight).toBe(6);
});

test('remote adapter can inspect and control a hub over the rpc wire', async () => {
  const previousWebSocket = globalThis.WebSocket;
  const env = makeEnv();
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.state.profile = { ...replica.state.profile, name: 'H1 Hub', isHub: true };
	  const token = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
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
      const request = decodeRuntimeAdapterMessage<Record<string, unknown>>(raw);
	      void handleRuntimeAdapterMessage(this.serverSocket, request, env, {
	        validateRuntimeInputAdmission: (_targetEnv, input) => {
	          if (!Array.isArray(input.entityInputs)) throw new Error('entityInputs required');
	        },
	        enqueueRuntimeInput: (targetEnv, input) => {
	          enqueued.push(input);
	          targetEnv.height = Math.max(0, Math.floor(Number(targetEnv.height ?? 0))) + 1;
	        },
	        registerReceipt: (receipt) => {
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
	        buildRuntimeInputStatusUrl: (id) => `/api/control/runtime-input/${id}/status`,
	        loadEntityViewPage: async () => ({
          core: projectEntityCoreDoc(replica.state, replica),
          accounts: {
            items: Array.from(replica.state.accounts.values()).slice(0, 10).map((account) => projectAccountDoc(account)),
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
    adapter.onChange((height) => heights.push(height));

    await adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://127.0.0.1:8092/rpc',
      authKey: token,
      requestTimeoutMs: 1_000,
      reconnectMaxMs: 1_000,
    });

    expect(constructed).toBe(1);
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('admin');
    expect(adapter.currentHeight).toBe(7);
    const changesAfterAuth = heights.length;
    broadcastRuntimeAdapterTick(env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.currentHeight).toBe(7);
    expect(heights).toHaveLength(changesAfterAuth);

    const view = await adapter.read<{
      height: number;
      entities: Array<{ entityId: string; label: string }>;
      activeEntity: { summary: { entityId: string; label: string }; accounts: { items: unknown[]; nextCursor: string | null } };
    }>('view-frame', { entityId, accountsLimit: 10, booksLimit: 10 });
    expect(view.height).toBe(7);
    expect(view.entities.some((entry) => entry.entityId === entityId && entry.label === 'H1 Hub')).toBe(true);
    expect(view.activeEntity.summary.entityId).toBe(entityId);
    expect(view.activeEntity.summary.label).toBe('H1 Hub');
    expect(view.activeEntity.accounts.items).toHaveLength(1);
    expect(view.activeEntity.accounts.nextCursor).toBe(null);

    const input: RuntimeInput = {
      runtimeTxs: [],
      entityInputs: [{ entityId, signerId: 'signer', entityTxs: [] }],
    };
	    const sent = await adapter.send(input);
	    expect(enqueued).toHaveLength(1);
	    expect(enqueued[0]).toEqual(input);
	    expect(sent.height).toBe(7);
	    expect(sent.receipt?.id).toBe('receipt-1');
	    expect(sent.receipt?.kind).toBe('radapter-runtime-input');
	    expect(sent.receipt?.enqueuedHeight).toBe(7);
	    expect(sent.statusUrl).toBe('/api/control/runtime-input/receipt-1/status');

    broadcastRuntimeAdapterTick(env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.currentHeight).toBe(8);
    expect(heights).toContain(8);

    const head = await adapter.read<{ latestHeight: number }>('head');
    expect(head.latestHeight).toBe(8);
    env.height = 12;
    const newerHead = await adapter.read<{ latestHeight: number }>('head');
    expect(newerHead.latestHeight).toBe(12);
    expect(adapter.currentHeight).toBe(12);
    expect(heights).toContain(12);
    adapter.disconnect();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test('storage entity hash docs persist root metadata only', async () => {
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

  expect(firstDoc.cellCount).toBe(accountCount);
  expect('cells' in firstDoc).toBe(false);
  expect(first.entityHashes[0]?.cellCount).toBe(accountCount);
  const firstRootPut = first.merklePuts.find((item) => Buffer.compare(item.key, keyMerkleRoot(entityId, 'runtime-roots')) === 0);
  const firstRoot = decodeBuffer<StorageMerkleRootDoc>(firstRootPut!.value);
  expect(firstRoot.rootHash).toBe(firstDoc.hash);
  expect(firstRoot.leafCount).toBe(accountCount);
  expect(firstRoot.rootKind).toBe('branch');
  expect(Array.isArray(firstRoot.rootPath)).toBe(true);

  const oldRoot = firstDoc.hash;
  const changedId = `0x${(2_001).toString(16).padStart(64, '0')}`;
  const second = await prepareStorageStateHashes({
    db: makeMemoryDb([
      ...first.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ]),
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
  expect('cells' in secondDoc).toBe(false);
  expect(secondDoc.hash).not.toBe(oldRoot);
  expect(second.merklePuts.length).toBeLessThan(50);
  expect(second.merkleDels).toHaveLength(0);

  const cold = await prepareStorageStateHashes({
    db: makeMemoryDb([
      ...first.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ]),
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
    db: makeMemoryDb([
      ...first.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ]),
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
    entityHashDocs: new Map([[entityId, staleDoc]]),
  });
  const staleRuntimeDoc = staleRuntimeFields.entityHashDocs.get(entityId)!;
  expect(staleRuntimeDoc.cellCount).toBe(accountCount);
  expect(staleRuntimeDoc.hash).toBe(secondDoc.hash);
  expect(staleRuntimeFields.merklePuts.length).toBeLessThan(50);

  const persistedRootOnly = await prepareStorageStateHashes({
    db: makeMemoryDb([
      [keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica))],
      ...first.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ]),
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
  });
  const persistedRootOnlyDoc = persistedRootOnly.entityHashDocs.get(entityId)!;
  expect(persistedRootOnlyDoc.cellCount).toBe(accountCount);
  expect(persistedRootOnlyDoc.hash).toBe(secondDoc.hash);

  await expect(prepareStorageStateHashes({
    db: makeMemoryDb([[keyLiveEntity(entityId), encodeBuffer(projectEntityCoreDoc(replica))]]),
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
  })).rejects.toThrow('STORAGE_MERKLE_ROOT_MISSING');

  const putThenDelete = await prepareStorageStateHashes({
    db: makeMemoryDb([
      ...first.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ]),
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
    dels: [{ family: 'account', entityId, counterpartyId: changedId }],
  });
  const merklePutKeys = new Set(putThenDelete.merklePuts.map((item) => item.key.toString('hex')));
  expect(putThenDelete.merkleDels.some((key) => merklePutKeys.has(key.toString('hex')))).toBe(false);

  const coldDelete = await prepareStorageStateHashes({
    db: makeMemoryDb([
      ...first.merklePuts.map((item) => [item.key, item.value] as [Buffer, Buffer]),
    ]),
    puts: [],
    dels: [{ family: 'account', entityId, counterpartyId: changedId }],
  });
  const coldDeleteDoc = coldDelete.entityHashDocs.get(entityId)!;
  expect(coldDeleteDoc.cellCount).toBe(accountCount - 1);
  expect(coldDelete.merkleDels.length).toBeGreaterThan(0);
  expect(coldDelete.merklePuts.length).toBeLessThan(50);
});

test('remote runtime adapter reports connected only after auth and accepts lower remote ticks', async () => {
  const previousWebSocket = globalThis.WebSocket;
  let socket: { onmessage: ((event: { data: unknown }) => void) | null } | null = null;

  class DelayedAuthWebSocket {
    static readonly OPEN = 1;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      socket = this;
      setTimeout(() => {
        this.readyState = DelayedAuthWebSocket.OPEN;
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
            ok: true,
            payload: {
              authLevel: 'inspect',
              currentHeight: 10,
            },
          }),
        });
      }, 25);
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = DelayedAuthWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    const statuses: string[] = [];
    const heights: number[] = [];
    adapter.onStatus(status => statuses.push(status));
    adapter.onChange(height => heights.push(height));

    const connectPromise = adapter.connect({
      mode: 'remote',
      wsUrl: 'ws://runtime-adapter.invalid/rpc',
      authKey: 'token',
      reconnectMaxMs: 1_000,
      requestTimeoutMs: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(adapter.status).toBe('connecting');
    expect(statuses).not.toContain('connected');

    await connectPromise;
    expect(adapter.status).toBe('connected');
    expect(adapter.authLevel).toBe('inspect');
    expect(adapter.currentHeight).toBe(10);

    socket?.onmessage?.({
      data: encodeRuntimeAdapterMessage({
        v: 1,
        op: 'tick',
        height: 2,
      }),
    });
    expect(adapter.currentHeight).toBe(2);
    expect(heights).toContain(2);
    adapter.disconnect();
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
  }
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
