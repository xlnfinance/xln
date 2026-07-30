import { readFileSync } from 'node:fs';

import { expect, test } from 'bun:test';

import { createHmac } from 'crypto';

import { computeAddress, hexlify, keccak256, recoverAddress, SigningKey, toUtf8Bytes } from 'ethers';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';

import {
  deriveRuntimeAdapterCapabilityToken,
  resolveRuntimeAdapterAuthSeed,
  verifyRuntimeAdapterAuthCredential,
  verifyRuntimeAdapterAuthKey,
} from '../radapter/auth';

import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
  runtimeAdapterMaxMessageBytes,
} from '../radapter/codec';

import { EmbeddedRuntimeAdapter } from '../radapter/embedded';

import { RemoteRuntimeAdapter } from '../radapter/remote';

import { verifyRuntimeAdapterServerIdentity } from '../radapter/server-identity';

import { buildRuntimeAdapterOwnerBindingDigest } from '../radapter/owner-binding';

import { signRuntimeAdapterServerIdentity } from '../radapter/server-identity-signer';

import {
  assertRuntimeAdapterGraphFrameWireBudget,
  resolveRuntimeAdapterRead,
  type RuntimeAdapterGraphFrame,
} from '../radapter/resolve';

import { decryptRuntimeRecoveryBundle, deriveRuntimeRecoveryLookupKey } from '../recovery/crypto';

import { broadcastRuntimeAdapterTick, handleRuntimeAdapterMessage } from '../radapter/server';

import {
  applyRuntimeAdapterCommandMarker,
  MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES,
} from '../radapter/command-frontier';

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

import type { AccountTx, CrossJurisdictionSwapRoute, Delta, EntityReplica, RuntimeReplica, RuntimeInput } from '../runtime/types';

import type { BookState } from '../orderbook';

import { DEFAULT_SPREAD_DISTRIBUTION, type OrderbookExtState } from '../orderbook/types';

import { createGossipLayer } from '../networking/gossip';
import type { Profile } from '../entity/profile';

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
                    leftEntity: entityId,
                    rightEntity: counterpartyId,
                    domain: {
                      chainId: 31337,
                      depositoryAddress: '0x0000000000000000000000000000000000000002',
                    },
                    watchSeed: `0x${'34'.repeat(32)}`,
                    status: 'active',
                    mempool: [],
                    currentFrame: {
                      height: 1,
                      timestamp: 700,
                      jHeight: 0,
                      accountTxs: [],
                      prevFrameHash: 'genesis',
                      stateHash: `0x${'02'.repeat(32)}`,
                      accountStateRoot: `0x${'01'.repeat(32)}`,
                      deltas: [],
                    },
                    deltas: new Map(),
                    locks: new Map(),
                    swapOffers: new Map(),
                    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
                    currentHeight: 1,
                    pendingSignatures: [],
                    rollbackCount: 0,
                    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
                    proofBody: { tokenIds: [], deltas: [] },
                    pendingWithdrawals: new Map(),
                    requestedRebalance: new Map(),
                    requestedRebalanceFeeState: new Map(),
                    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
                    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
                    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
                    lastFinalizedJHeight: 0,
                    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
                    jNonce: 0,
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

test('runtime adapter solvency-summary returns per-stack asset conservation', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
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
    assets: [
      {
        stackId: '31337:0x0000000000000000000000000000000000000002',
        chainId: 31337,
        depositoryAddress: '0x0000000000000000000000000000000000000002',
        tokenId: 1,
        reserves: 100n,
        confirmedCollateral: 100n,
        pendingCollateral: 50n,
        delta: 0n,
        isValid: true,
      },
    ],
    isValid: true,
  });
  expect(summary).not.toHaveProperty('eReplicas');
  expect(summary).not.toHaveProperty('accounts');
});

test('runtime adapter solvency-summary rejects historical fallback until a projection exists', async () => {
  await expect(resolveRuntimeAdapterRead({ env: makeEnv() }, 'solvency-summary', { atHeight: 6 })).rejects.toThrow(
    'historical solvency-summary reads are not available yet',
  );
});

test('runtime adapter server diagnostics use structured logging only', () => {
  const source = readFileSync(new URL('../radapter/server.ts', import.meta.url), 'utf8');

  expect(source).toContain("createStructuredLogger('runtime.radapter')");
  expect(source).toContain('response_too_large');
  expect(source).not.toContain('[RADAPTER] RESPONSE_TOO_LARGE');
  expect(source).not.toContain('console.');
});

test('runtime adapter capability tokens are scoped by level', () => {
  const readToken = deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() + 60_000);
  const fullToken = deriveRuntimeAdapterCapabilityToken('seed', 'full', Date.now() + 60_000);
  expect(readToken).not.toBe(fullToken);
  expect(verifyRuntimeAdapterAuthKey('seed', readToken)).toBe('inspect');
  expect(verifyRuntimeAdapterAuthKey('seed', fullToken)).toBe('admin');
  expect(verifyRuntimeAdapterAuthCredential('seed', readToken)?.level).toBe('inspect');
  expect(verifyRuntimeAdapterAuthCredential('seed', fullToken)?.level).toBe('admin');
  expect(() => deriveRuntimeAdapterCapabilityToken('seed', 'read', Date.now() - 1)).toThrow(
    'RADAPTER_AUTH_EXPIRY_REQUIRED',
  );
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
  const signature = createHmac('sha256', 'seed').update(`xln-radapter-v1:cap:admin:${exp}`).digest('hex');
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
  expect(
    verifyRuntimeAdapterAuthCredential('seed', token, {
      audience: 'runtime-a',
      revokedTokenIds: new Set(['jti-a']),
    }),
  ).toBe(null);
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
  const head = await resolveRuntimeAdapterRead<{ latestHeight: number }>(
    {
      env,
      readHead: async () => null,
    },
    'head',
  );
  const entities = await resolveRuntimeAdapterRead<Array<{ entityId: string; label: string }>>({ env }, 'entities');
  const entity = await resolveRuntimeAdapterRead<{ entityId: string; profile: { name: string } }>(
    { env },
    `entity/${entityId}`,
  );
  const accounts = await resolveRuntimeAdapterRead<{
    items: Array<{ currentHeight: number }>;
    nextCursor: string | null;
  }>(ctx, `entity/${entityId}/accounts`);

  expect(head.latestHeight).toBe(7);
  expect(entities).toEqual([
    {
      entityId,
      signerId: 'signer',
      label: 'Adapter Test',
      height: 7,
      jurisdiction: {
        address: '0x0000000000000000000000000000000000000002',
        name: 'Testnet',
        chainId: 31337,
        entityProviderAddress: '0x0000000000000000000000000000000000000001',
        depositoryAddress: '0x0000000000000000000000000000000000000002',
      },
    },
  ]);
  expect(entity.entityId).toBe(entityId);
  expect(entity.profile.name).toBe('Adapter Test');
  expect(accounts.items).toHaveLength(1);
  expect(accounts.items[0]?.currentHeight).toBe(1);
  expect(accounts.nextCursor).toBe(null);
});

test('runtime adapter direct read paths return compact read snapshots', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)! as any;
  account.watchSeed = `0x${'42'.repeat(32)}`;
  account.mempool = Array.from({ length: 500 }, (_, index) => ({
    type: 'memo',
    data: { index, note: 'm'.repeat(200) },
  }));
  account.pendingSignatures = Array.from({ length: 500 }, (_, index) => `sig-${index}-${'s'.repeat(200)}`);
  account.currentFrame = {
    ...account.currentFrame,
    accountTxs: Array.from({ length: 500 }, (_, index) => ({
      type: 'frame_memo',
      data: { index, note: 'f'.repeat(200) },
    })),
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
  account.swapOrderHistory = new Map([['history', { note: 'h'.repeat(100_000), resolves: [] }]]);
  account.swapClosedOrders = new Map([['closed', { note: 'c'.repeat(100_000), resolves: [] }]]);
  account.swapOffers = new Map(
    Array.from({ length: 101 }, (_, index) => [
      `offer-${index}`,
      { offerId: `offer-${index}` },
    ]),
  );
  replica.state.nonces = new Map(
    Array.from({ length: 500 }, (_, index) => [`0x${index.toString(16).padStart(64, '0')}`, index]),
  );
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
    swapOffers: Map<string, { offerId: string }>;
    swapOrderHistory?: unknown;
    swapClosedOrders?: unknown;
  }>({ env }, `entity/${entityId}/account/${counterpartyId}`);
  const historicalEntity = await resolveRuntimeAdapterRead<typeof liveEntity>(
    {
      env,
      loadEntityState: async () => replica.state,
    },
    `entity/${entityId}`,
    { atHeight: env.state.height - 1 },
  );
  const historicalAccount = await resolveRuntimeAdapterRead<typeof liveAccount>(
    {
      env,
      loadEntityAccountDoc: async () => projectAccountDoc(account),
    },
    `entity/${entityId}/account/${counterpartyId}`,
    { atHeight: env.state.height - 1 },
  );
  const encodedLiveEntity = encodeRuntimeAdapterMessage({
    v: 1,
    inReplyTo: 'direct-entity',
    ok: true,
    payload: liveEntity,
  });
  const encodedLiveAccount = encodeRuntimeAdapterMessage({
    v: 1,
    inReplyTo: 'direct-account',
    ok: true,
    payload: liveAccount,
  });

  for (const core of [liveEntity, historicalEntity]) {
    expect('entityEncPrivKey' in core).toBe(false);
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
    expect(doc.swapOffers.size).toBe(100);
    expect(doc.swapOffers.has('offer-0')).toBe(false);
    expect(doc.swapOffers.get('offer-100')?.offerId).toBe('offer-100');
    expect(doc.swapOrderHistory).toBeInstanceOf(Map);
    expect(doc.swapOrderHistory?.size).toBe(1);
    expect(doc.swapClosedOrders).toBeInstanceOf(Map);
    expect(doc.swapClosedOrders?.size).toBe(1);
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
  expect(frame.entities.map(entity => entity.entityId)).toEqual([entityId]);
  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.activeEntity?.core.profile?.name).toBe('Adapter Test');
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.leftEntity).toBe(entityId);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
  expect(frame.activeEntity?.accounts.nextCursor).toBe(null);
  expect(frame.activeEntity?.books.items).toEqual([]);
});

test('current stored view frame overlays local identity without mixing a later live frame', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.prevFrameHash = 'frame-h7';
  replica.htlcNotes = new Map([['hashlock:local-h7', 'local note h7']]);
  const storedCore = structuredClone(projectEntityCoreDoc(replica.state));
  const frame = await resolveRuntimeAdapterRead<{
    height: number;
    activeEntity: {
      core: {
        signerId?: string;
        isProposer?: boolean;
        entityEncPubKey?: string;
        height: number;
        timestamp: number;
        prevFrameHash?: string;
        profile: { name: string };
        reserves: Map<number, bigint>;
        htlcNotes?: Map<string, string>;
      };
    } | null;
  }>(
    {
      env,
      readHead: async () => ({
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
      }),
      loadEntityViewPage: async () => {
        await Promise.resolve();
        env.state.height = 8;
        env.state.timestamp = 800;
        replica.isProposer = false;
        replica.state.height = 8;
        replica.state.timestamp = 800;
        replica.state.prevFrameHash = 'frame-h8';
        replica.state.profile = { ...replica.state.profile, name: 'Later live frame' };
        replica.state.reserves = new Map([[1, 800n]]);
        replica.entityEncPubKey = 'pub-h8';
        replica.htlcNotes = new Map([['hashlock:local-h8', 'local note h8']]);
        return {
          core: storedCore,
          accounts: { items: [], nextCursor: null },
          books: { items: [], nextCursor: null },
        };
      },
    },
    'view-frame',
  );

  expect(frame.height).toBe(7);
  expect(frame.activeEntity?.core.height).toBe(7);
  expect(frame.activeEntity?.core.timestamp).toBe(700);
  expect(frame.activeEntity?.core.prevFrameHash).toBe('frame-h7');
  expect(frame.activeEntity?.core.profile.name).toBe('Adapter Test');
  expect(frame.activeEntity?.core.reserves.get(1)).toBe(100n);
  expect(frame.activeEntity?.core.signerId).toBe(replica.signerId);
  expect(frame.activeEntity?.core.isProposer).toBe(true);
  expect(frame.activeEntity?.core.entityEncPubKey).toBe('pub');
  expect('entityEncPrivKey' in (frame.activeEntity?.core ?? {})).toBe(false);
  expect(frame.activeEntity?.core.htlcNotes).toEqual(new Map([['hashlock:local-h7', 'local note h7']]));
});

test('runtime adapter view-frame includes live gossip summaries for visible account peers', async () => {
  const env = makeEnv();
  env.gossip = createGossipLayer();
  env.gossip.announce(makeHubProfile(entityId, 'H1'));
  env.gossip.announce(makeHubProfile(counterpartyId, 'H2'));

  const frame = await resolveRuntimeAdapterRead<{
    entities: Array<{
      entityId: string;
      label: string;
      isHub?: boolean;
      jurisdiction?: { name?: string; chainId?: number };
    }>;
    activeEntity: { accounts: { items: Array<{ leftEntity: string; rightEntity: string }> } } | null;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'view-frame', { accountsLimit: 1, booksLimit: 1 });

  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
  expect(frame.entities.find(entry => entry.entityId === entityId)?.label).toBe('Adapter Test');
  const peer = frame.entities.find(entry => entry.entityId === counterpartyId);
  expect(peer?.label).toBe('H2');
  expect(peer?.isHub).toBe(true);
  expect(peer?.jurisdiction?.name).toBe('Testnet');
  expect(peer?.jurisdiction?.chainId).toBe(31337);
});

test('runtime adapter graph-frame keeps gossip peers and complete local account edges', async () => {
  const env = makeEnv();
  env.runtimeId = 'runtime:h1';
  env.gossip = createGossipLayer();
  env.gossip.announce(makeHubProfile(entityId, 'H1'));
  env.gossip.announce(makeHubProfile(counterpartyId, 'H2'));
  const account = Array.from(env.state.eReplicas.values())[0]!.state.accounts.get(counterpartyId)!;
  account.deltas.set(1, makeTestDelta(1, 25n));
  const activityTxs: AccountTx[] = [10n, 20n, 30n].map(amount => ({
    type: 'direct_payment',
    data: {
      tokenId: 1,
      amount,
      fromEntityId: entityId,
      toEntityId: counterpartyId,
      route: [entityId, counterpartyId],
      description: `full payload ${amount}`,
    },
  }));
  account.mempool = activityTxs;
  account.currentFrame.accountTxs = activityTxs;
  account.pendingFrame = {
    ...account.currentFrame,
    height: account.currentFrame.height + 1,
    accountTxs: activityTxs,
  };

  const frame = await resolveRuntimeAdapterRead<RuntimeAdapterGraphFrame>(
    {
      env,
      loadEntityViewPage: makeTestViewPageLoader(env),
    },
    'graph-frame',
    {
      limit: 10,
      accountsLimit: 10,
    },
  );

  expect(frame.runtimeId).toBe('runtime:h1');
  expect(frame.height).toBe(7);
  expect(frame.timestamp).toBe(700);
  expect(frame.stateHash).toBe('');
  expect(frame.entities.map(entry => entry.summary.entityId)).toEqual([entityId, counterpartyId]);
  const local = frame.entities.find(entry => entry.summary.entityId === entityId);
  expect(local?.core?.entityId).toBe(entityId);
  expect(local?.core?.reserves).toEqual(new Map([[1, 100n]]));
  expect(local?.accounts.items).toHaveLength(1);
  expect(local?.accounts.items[0]).toMatchObject({ leftEntity: entityId, rightEntity: counterpartyId });
  expect(local?.accounts.items[0]?.deltas.get(1)?.ondelta).toBe(25n);
  expect(local?.accounts.items[0]?.currentFrame.accountStateRoot).toBe(`0x${'01'.repeat(32)}`);
  expect(local?.accounts.items[0]?.mempoolCount).toBe(3);
  expect(local?.accounts.items[0]?.mempool.map(activity => activity.amount)).toEqual([20n, 30n]);
  expect(local?.accounts.items[0]?.currentFrame.accountTxCount).toBe(3);
  expect(local?.accounts.items[0]?.currentFrame.accountTxs.map(activity => activity.amount)).toEqual([20n, 30n]);
  expect(local?.accounts.items[0]?.pendingFrame?.accountTxCount).toBe(3);
  expect(local?.accounts.items[0]?.pendingFrame?.accountTxs.map(activity => activity.amount)).toEqual([20n, 30n]);
  expect(local?.accounts.items[0]?.currentFrame.accountTxs[0]).toEqual({
    type: 'direct_payment',
    tokenId: 1,
    amount: 20n,
    fromEntityId: entityId,
    toEntityId: counterpartyId,
  });
  expect(local?.accounts.items[0]?.currentFrame.accountTxs[0]).not.toHaveProperty('route');
  expect(local?.accounts.items[0]?.currentFrame.accountTxs[0]).not.toHaveProperty('description');
  for (const heavyCoreField of ['messages', 'nonces', 'proposals', 'entityEncPrivKey', 'jBlockChain', 'lockBook']) {
    expect(local?.core).not.toHaveProperty(heavyCoreField);
  }
  for (const heavyAccountField of [
    'watchSeed',
    'locks',
    'swapOffers',
    'pendingSignatures',
    'proofBody',
    'pendingWithdrawals',
    'rebalancePolicy',
    'globalCreditLimits',
  ]) {
    expect(local?.accounts.items[0]).not.toHaveProperty(heavyAccountField);
  }
  const peer = frame.entities.find(entry => entry.summary.entityId === counterpartyId);
  expect(peer?.summary.label).toBe('H2');
  expect(peer?.core).toBeNull();
  expect(peer?.accounts.items).toEqual([]);

  await expect(
    resolveRuntimeAdapterRead({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'graph-frame', {
      limit: 1,
      accountsLimit: 10,
    }),
  ).rejects.toThrow('graph-frame has 2 entities; limit is 1');
});

test('runtime adapter live graph-frame never reads a prunable storage generation', async () => {
  const env = makeEnv();
  env.runtimeId = 'runtime:h1';
  let storagePageReads = 0;

  const frame = await resolveRuntimeAdapterRead<RuntimeAdapterGraphFrame>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: env.state.height,
        latestMaterializedHeight: env.state.height,
        latestSnapshotHeight: Math.max(0, env.state.height - 1),
        snapshotPeriodFrames: 5,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      loadEntityViewPage: async () => {
        storagePageReads += 1;
        throw new Error(`STORAGE_DIFF_MISSING: height=${env.state.height} scope=entity:${entityId}`);
      },
    },
    'graph-frame',
    { limit: 10, accountsLimit: 10 },
  );

  expect(storagePageReads).toBe(0);
  expect(frame.height).toBe(env.state.height);
  expect(frame.entities.some(entry => entry.summary.entityId === entityId)).toBe(true);
});

test('runtime adapter explicit graph-frame height uses exact RDB state even at the live height', async () => {
  const env = makeEnv();
  const livePage = await makeTestViewPageLoader(env)(entityId, env.state.height, {
    accountsLimit: 10,
    booksLimit: 1,
  });
  if (!livePage) throw new Error('test storage page is required');
  const storedPage = {
    ...livePage,
    core: {
      ...livePage.core,
      timestamp: 601,
      profile: { ...livePage.core.profile, name: 'Persisted H7' },
    },
  };
  let storagePageReads = 0;
  const head = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: env.state.height,
    latestMaterializedHeight: env.state.height,
    latestSnapshotHeight: env.state.height,
    snapshotPeriodFrames: 5,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  };

  const frame = await resolveRuntimeAdapterRead<RuntimeAdapterGraphFrame>(
    {
      env,
      readHead: async () => head,
      listEntityIdsAtHeight: async () => [entityId],
      loadEntityViewPage: async () => {
        storagePageReads += 1;
        return storedPage;
      },
    },
    'graph-frame',
    { atHeight: env.state.height, limit: 10, accountsLimit: 10 },
  );

  const storedEntity = frame.entities.find(entry => entry.summary.entityId === entityId);
  expect(storagePageReads).toBeGreaterThan(0);
  expect(storedEntity?.summary.label).toBe('Persisted H7');
  expect(storedEntity?.core?.timestamp).toBe(601);

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readHead: async () => head,
        listEntityIdsAtHeight: async () => [entityId],
        loadEntityViewPage: async () => {
          throw new Error(`STORAGE_DIFF_MISSING: height=${env.state.height} scope=entity:${entityId}`);
        },
      },
      'graph-frame',
      { atHeight: env.state.height, limit: 10, accountsLimit: 10 },
    ),
  ).rejects.toThrow(`STORAGE_DIFF_MISSING: height=${env.state.height} scope=entity:${entityId}`);
});

test('runtime adapter graph-frame wire DTO stays below budget near topology limits', () => {
  const entityCount = 496;
  const accountCount = 500;
  const tokenIds = [1, 2, 3, 4];
  const ids = Array.from({ length: entityCount }, (_, index) => `0x${(index + 1).toString(16).padStart(64, '0')}`);
  let remainingAccounts = accountCount;
  const entities: RuntimeAdapterGraphFrame['entities'] = ids.map((id, entityIndex) => {
    const accountsForEntity = Math.min(remainingAccounts, entityIndex < 4 ? 2 : 1);
    remainingAccounts -= accountsForEntity;
    const accounts = Array.from({ length: accountsForEntity }, (_, accountIndex) => {
      const peerId = ids[(entityIndex + accountIndex + 1) % ids.length]!;
      const frameHash = `0x${(entityIndex + 1).toString(16).padStart(64, '0')}`;
      const activities = [1, 2].map(tokenId => ({
        type: 'direct_payment',
        tokenId,
        amount: BigInt((entityIndex + 1) * tokenId),
        fromEntityId: id,
        toEntityId: peerId,
      }));
      return {
        leftEntity: id,
        rightEntity: peerId,
        status: 'active' as const,
        mempool: activities,
        mempoolCount: activities.length,
        currentFrame: {
          height: 42,
          timestamp: 4_200,
          jHeight: 40,
          prevFrameHash: frameHash,
          accountStateRoot: frameHash,
          stateHash: frameHash,
          byLeft: true,
          accountTxs: activities,
          accountTxCount: activities.length,
        },
        deltas: new Map(
          tokenIds.map(tokenId => [tokenId, makeTestDelta(tokenId, BigInt((entityIndex + 1) * tokenId))]),
        ),
        currentHeight: 42,
        rollbackCount: 0,
      };
    });
    return {
      summary: {
        entityId: id,
        runtimeId: 'runtime:scale-test',
        label: `Entity ${entityIndex + 1}`,
        height: 42,
        isHub: entityIndex % 10 === 0,
      },
      core: {
        entityId: id,
        height: 42,
        timestamp: 4_200,
        reserves: new Map(tokenIds.map(tokenId => [tokenId, BigInt((entityIndex + 1) * tokenId * 1_000)])),
        profile: { name: `Entity ${entityIndex + 1}`, isHub: entityIndex % 10 === 0 },
        isHub: entityIndex % 10 === 0,
      },
      accounts: {
        items: accounts,
        nextCursor: null,
        totalItems: accounts.length,
        limit: accountCount,
      },
    };
  });
  expect(remainingAccounts).toBe(0);
  expect(entities).toHaveLength(entityCount);
  expect(entities.reduce((total, entity) => total + entity.accounts.items.length, 0)).toBe(accountCount);
  expect(entities.every(entity => entity.accounts.items.every(account => account.deltas.size <= 4))).toBe(true);

  const frame: RuntimeAdapterGraphFrame = {
    head: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: 42,
      latestMaterializedHeight: 42,
      latestSnapshotHeight: 40,
      snapshotPeriodFrames: 5,
      retainSnapshots: 3,
      epochMaxBytes: 1_073_741_824,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedHistoryBytes: 262_144,
    },
    runtimeId: 'runtime:scale-test',
    height: 42,
    timestamp: 4_200,
    stateHash: `0x${'42'.repeat(32)}`,
    entities,
  };

  const encodedBytes = assertRuntimeAdapterGraphFrameWireBudget(frame);
  expect(encodedBytes).toBeLessThan(runtimeAdapterMaxMessageBytes());

  const overBudgetFrame: RuntimeAdapterGraphFrame = {
    ...frame,
    entities: frame.entities.map((entity, index) =>
      index === 0
        ? {
            ...entity,
            summary: {
              ...entity.summary,
              label: 'x'.repeat(runtimeAdapterMaxMessageBytes()),
            },
          }
        : entity,
    ),
  };
  expect(() => assertRuntimeAdapterGraphFrameWireBudget(overBudgetFrame)).toThrow(
    'graph-frame response exceeds wire budget',
  );
});

test('runtime adapter graph-frame synthesizes missing account endpoint nodes', async () => {
  const env = makeEnv();
  const frame = await resolveRuntimeAdapterRead<{
    entities: Array<{ summary: { entityId: string; label: string }; core: unknown | null }>;
  }>({ env, loadEntityViewPage: makeTestViewPageLoader(env) }, 'graph-frame', {
    limit: 10,
    accountsLimit: 10,
  });

  expect(frame.entities.map(entry => entry.summary.entityId)).toEqual([entityId, counterpartyId]);
  expect(frame.entities.find(entry => entry.summary.entityId === counterpartyId)).toMatchObject({
    summary: { label: counterpartyId },
    core: null,
  });
});

test('runtime adapter historical graph-frame derives fallback timestamp from the selected frame', async () => {
  const env = makeEnv();
  env.runtimeId = 'runtime:h1';
  const liveLoader = makeTestViewPageLoader(env);
  const historicalHeight = 6;
  const historicalTimestamp = 600;
  const loadEntityViewPage = async (
    requestedEntityId: string,
    height: number,
    query?: Parameters<ReturnType<typeof makeTestViewPageLoader>>[2],
  ) => {
    if (height !== historicalHeight) return null;
    const live = await liveLoader(requestedEntityId, env.state.height, query);
    if (!live) return null;
    return {
      ...live,
      core: { ...live.core, height: historicalHeight, timestamp: historicalTimestamp },
    };
  };

  const frame = await resolveRuntimeAdapterRead<{
    height: number;
    timestamp: number;
    stateHash: string;
  }>(
    {
      env,
      readHead: async () => ({ latestHeight: env.state.height }) as StorageHead,
      readFrame: async () => null,
      listEntityIdsAtHeight: async () => [entityId],
      loadEntityViewPage,
    },
    'graph-frame',
    { atHeight: historicalHeight, limit: 10, accountsLimit: 10 },
  );

  expect(frame.height).toBe(historicalHeight);
  expect(frame.timestamp).toBe(historicalTimestamp);
  expect(frame.timestamp).not.toBe(env.state.timestamp);
  expect(frame.stateHash).toBe('');
});

test('runtime adapter entity summaries preserve gossip jurisdiction for live hub replicas', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.profile = { ...replica.state.profile, name: 'H1', isHub: true };
  env.gossip = createGossipLayer();
  env.gossip.announce(makeHubProfile(entityId, 'H1'));

  const entities = await resolveRuntimeAdapterRead<
    Array<{
      entityId: string;
      label: string;
      isHub?: boolean;
      jurisdiction?: { name?: string; chainId?: number; depositoryAddress?: string };
    }>
  >({ env }, 'entities');

  const hub = entities.find(entry => entry.entityId === entityId);
  expect(hub?.label).toBe('H1');
  expect(hub?.runtimeId).toBe('runtime:h1');
  expect(hub?.isHub).toBe(true);
  expect(hub?.jurisdiction?.name).toBe('Testnet');
  expect(hub?.jurisdiction?.chainId).toBe(31337);
  expect(hub?.jurisdiction?.depositoryAddress).toBe('0x0000000000000000000000000000000000000002');
});

test('runtime adapter view-frame exposes compact pending j-batch operations for cockpit actions', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.jBatchState = {
    batch: {
      flashloans: [],
      reserveToReserve: [],
      reserveToCollateral: [],
      collateralToReserve: [],
      settlements: [],
      disputeStarts: [
        {
          counterentity: counterpartyId,
          nonce: 9,
          proofbodyHash: `0x${'12'.repeat(32)}`,
          watchSeed: `0x${'34'.repeat(32)}`,
          sig: `0x${'56'.repeat(64)}`,
          starterInitialArguments: `0x${'78'.repeat(64)}`,
          starterIncrementedArguments: `0x${'90'.repeat(64)}`,
        },
      ],
      disputeFinalizations: [],
      externalTokenToReserve: [],
      reserveToExternalToken: [],
      revealSecrets: [],
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
  const primary = Array.from(env.state.eReplicas.values())[0]!;
  const emptyEntityId = `0x${'00'.repeat(32)}`;
  env.state.eReplicas.set(`${emptyEntityId}:empty-signer`, {
    ...primary,
    entityId: emptyEntityId,
    signerId: 'empty-signer',
    entityEncPubKey: '',
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

  expect(frame.entities.map(entity => entity.entityId)).toEqual([emptyEntityId, entityId]);
  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
});

test('runtime adapter historical batch without entityId defaults to live entity with real relationships', async () => {
  const env = makeEnv();
  const primary = Array.from(env.state.eReplicas.values())[0]!;
  const staleEntityId = `0x${'00'.repeat(32)}`;
  const emptyEntityId = `0x${'01'.repeat(32)}`;
  env.state.eReplicas.set(`${emptyEntityId}:empty-signer`, {
    ...primary,
    entityId: emptyEntityId,
    signerId: 'empty-signer',
    entityEncPubKey: '',
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
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 9,
        latestMaterializedHeight: 8,
        latestSnapshotHeight: 8,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      listEntityIdsAtHeight: async () => [staleEntityId, emptyEntityId, entityId],
      loadEntityViewPage: async requestedEntityId => {
        const normalizedEntityId = normalizeEntityId(requestedEntityId);
        if (normalizedEntityId === staleEntityId) return null;
        const replica = Array.from(env.state.eReplicas.values()).find(
          item => normalizeEntityId(item.entityId) === normalizedEntityId,
        );
        if (!replica) return null;
        const account = replica.state.accounts.get(counterpartyId);
        return {
          core: projectEntityReplicaCoreView(replica.state, replica),
          accounts: {
            items: account ? [projectAccountDoc(account)] : [],
            nextCursor: null,
          },
          books: { items: [], nextCursor: null },
        };
      },
    },
    'history-frame-batch',
    {
      heights: [8],
      accountsLimit: 1,
      booksLimit: 1,
    },
  );

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
    entityInputs: [
      {
        entityId,
        signerId: 'signer',
        entityTxs: [{ type: 'openAccount', data: { counterpartyId } }],
      },
    ],
  } as unknown as RuntimeInput;
  const frame: RuntimeFrame = {
    height: 7,
    timestamp: 700,
    prevFrameHash: 'prev',
    frameHash: 'frame',
    postStateHash: 'post-state',
    stateHash: 'state',
    runtimeInput,
    historyRecords: [],
    activityLogs: [],
    overlayRecords: [{ scope: { family: 'entity', entityId }, key: 'raw', value: new Uint8Array([1, 2, 3]) }],
    touchedEntities: [entityId],
    touchedAccounts: [{ entityId, counterpartyId }],
    touchedBookEntities: [entityId],
  };

  const summary = await resolveRuntimeAdapterRead<Record<string, unknown>>(
    {
      env,
      readFrame: async () => frame,
    },
    'frame/latest',
  );

  expect(summary.runtimeInput).toBeUndefined();
  expect(summary.overlayRecords).toBeUndefined();
  expect(summary.postStateHash).toBe('post-state');
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

test('runtime adapter timeline-index returns a bounded compact timestamp page', async () => {
  const env = makeEnv();
  const frames = new Map<number, RuntimeFrame>(
    Array.from({ length: 7 }, (_, index) => {
      const height = index + 1;
      return [
        height,
        {
          height,
          timestamp: height * 1_000,
          postStateHash: `post-state-${height}`,
          stateHash: `state-${height}`,
          materializedState: height % 2 === 0,
          runtimeInput: { runtimeTxs: [], entityInputs: [], jInputs: [] },
          touchedEntities: [],
          touchedAccounts: [],
          touchedBookEntities: [],
        } as RuntimeFrame,
      ];
    }),
  );

  const page = await resolveRuntimeAdapterRead<{
    entries: Array<{ height: number; timestamp: number; stateHash: string; materialized: boolean }>;
    scannedHeights: number;
    nextBeforeHeight: number | null;
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 7,
        latestSnapshotHeight: 6,
        snapshotPeriodFrames: 2,
        retainSnapshots: 3,
        epochMaxBytes: 1_000,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 1_000,
      }),
      readFrame: async height => frames.get(height) ?? null,
    },
    'timeline-index',
    { beforeHeight: 8, limit: 3 },
  );

  expect(page.entries).toEqual([
    {
      runtimeId: 'embedded',
      height: 5,
      timestamp: 5_000,
      stateHash: 'state-5',
      materialized: false,
      graphChanged: false,
    },
    {
      runtimeId: 'embedded',
      height: 6,
      timestamp: 6_000,
      stateHash: 'state-6',
      materialized: true,
      graphChanged: false,
    },
    {
      runtimeId: 'embedded',
      height: 7,
      timestamp: 7_000,
      stateHash: 'state-7',
      materialized: false,
      graphChanged: false,
    },
  ]);
  expect(page.scannedHeights).toBe(3);
  expect(page.nextBeforeHeight).toBe(5);
});

test('runtime adapter receipt read returns ingress receipt status over websocket protocol', async () => {
  const env = makeEnv();
  const receipt = await resolveRuntimeAdapterRead<Record<string, unknown>>(
    {
      env,
      readReceipt: id =>
        id === 'receipt-1'
          ? {
              id,
              kind: 'radapter-runtime-input',
              status: 'observed',
              counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
              enqueuedHeight: 7,
              observedHeight: 8,
              enqueuedAt: 1,
              expiresAt: 2,
            }
          : null,
    },
    'receipt/receipt-1',
  );

  expect(receipt.id).toBe('receipt-1');
  expect(receipt.status).toBe('observed');
  expect(receipt.observedHeight).toBe(8);
});

test('runtime adapter recovery bundle read is gated by seed-derived lookup key', async () => {
  const env = makeEnv();
  env.runtimeSeed = 'test test test test test test test test test test test junk';
  env.runtimeId = deriveSignerAddressSync(env.runtimeSeed, '1').toLowerCase();
  const lookupKey = deriveRuntimeRecoveryLookupKey(env.runtimeId, env.runtimeSeed);

  const response = await resolveRuntimeAdapterRead<{
    ok: true;
    runtimeId: string;
    lookupKey: string;
    bundle: Parameters<typeof decryptRuntimeRecoveryBundle>[0];
    bundles: Array<Parameters<typeof decryptRuntimeRecoveryBundle>[0]>;
  }>({ env }, `recovery/bundles/${encodeURIComponent(lookupKey)}`);

  expect(response.ok).toBe(true);
  expect(response.runtimeId).toBe(env.runtimeId);
  expect(response.lookupKey).toBe(lookupKey);
  expect(response.bundle.lookupKey).toBe(lookupKey);
  expect(response.bundles).toHaveLength(1);
  const decrypted = await decryptRuntimeRecoveryBundle(response.bundle, env.runtimeSeed);
  expect(decrypted.runtimeId).toBe(env.runtimeId);
  expect(decrypted.runtimeHeight).toBe(env.state.height);
  expect(decrypted.signers[0]?.address).toBe(env.runtimeId);

  await expect(resolveRuntimeAdapterRead({ env }, `recovery/bundles/0x${'00'.repeat(32)}`)).rejects.toThrow(
    'recovery bundle not found',
  );

  const noSeedEnv = { ...env, runtimeSeed: undefined } as RuntimeReplica;
  await expect(
    resolveRuntimeAdapterRead({ env: noSeedEnv }, `recovery/bundles/${encodeURIComponent(lookupKey)}`),
  ).rejects.toThrow('recovery bundle reads require runtimeSeed');
});

test('runtime adapter view frame defaults to 10 accounts and cursor pagination', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
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
  expect(second.items.map(item => item.rightEntity)).toEqual([
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
  expect(found.items.map(item => item.rightEntity)).toEqual([`0x${'0b'.padStart(64, '0')}`]);
  expect(found.totalItems).toBe(1);
});

test('runtime adapter view frame honors the requested entity id', async () => {
  const env = makeEnv();
  const first = Array.from(env.state.eReplicas.values())[0]!;
  const secondEntityId = `0x${'cc'.repeat(32)}`;
  env.state.eReplicas.set(`${secondEntityId}:signer`, {
    ...first,
    entityId: secondEntityId,
    signerId: 'other-signer',
    entityEncPubKey: '',
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
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  let fullLoadCalled = false;
  let pagedLoadCalled = false;

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: { accounts: { items: Array<{ rightEntity: string }> } } | null;
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 9,
        latestMaterializedHeight: 8,
        latestSnapshotHeight: 8,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
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
          core: projectEntityReplicaCoreView(replica.state, replica),
          accounts: { items: [projectAccountDoc(account)], nextCursor: null },
          books: { items: [], nextCursor: null },
        };
      },
    },
    'view-frame',
    { atHeight: 8, accountsLimit: 1 },
  );

  expect(pagedLoadCalled).toBe(true);
  expect(fullLoadCalled).toBe(false);
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
});

test('runtime adapter historical view frame skips missing non-active summaries without hiding active entity failures', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const missingEntityId = `0x${'de'.repeat(32)}`;

  const frame = await resolveRuntimeAdapterRead<{
    entities: Array<{ entityId: string }>;
    activeEntityId: string | null;
    activeEntity: { core: { entityId: string } } | null;
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 9,
        latestMaterializedHeight: 8,
        latestSnapshotHeight: 8,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      listEntityIdsAtHeight: async () => [missingEntityId, entityId],
      loadEntityState: async () => null,
      loadEntityViewPage: async requestedEntityId => {
        if (normalizeEntityId(requestedEntityId) !== entityId) return null;
        return {
          core: projectEntityReplicaCoreView(replica.state, replica),
          accounts: { items: [], nextCursor: null },
          books: { items: [], nextCursor: null },
        };
      },
    },
    'view-frame',
    { atHeight: 8, entityId, accountsLimit: 1 },
  );

  expect(frame.activeEntityId).toBe(entityId);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.entities.map(summary => summary.entityId)).toEqual([entityId]);

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readHead: async () => ({
          schemaVersion: STORAGE_SCHEMA_VERSION,
          latestHeight: 9,
          latestMaterializedHeight: 8,
          latestSnapshotHeight: 8,
          snapshotPeriodFrames: 256,
          retainSnapshots: 3,
          epochMaxBytes: 1,
          accountMerkleRadix: 16,
          epochReplayBytes: 0,
          retainedHistoryBytes: 0,
        }),
        listEntityIdsAtHeight: async () => [missingEntityId, entityId],
        loadEntityState: async () => null,
        loadEntityViewPage: async () => null,
      },
      'view-frame',
      { atHeight: 8, entityId, accountsLimit: 1 },
    ),
  ).rejects.toThrow('entity summary not found at height');
});

test('runtime adapter live view-frame stays live if env height advances during projection', async () => {
  const env = makeEnv();
  env.state.height = 8;
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.height = 8;
  let historicalListingCalled = false;

  const frame = await resolveRuntimeAdapterRead<{
    height: number;
    entities: Array<{ entityId: string }>;
    activeEntity: { core: { entityId: string } } | null;
  }>(
    {
      env,
      readHead: async () => {
        env.state.height = 9;
        replica.state.height = 9;
        return {
          schemaVersion: STORAGE_SCHEMA_VERSION,
          latestHeight: 9,
          latestMaterializedHeight: 8,
          latestSnapshotHeight: 8,
          snapshotPeriodFrames: 256,
          retainSnapshots: 3,
          epochMaxBytes: 1,
          accountMerkleRadix: 16,
          epochReplayBytes: 0,
          retainedHistoryBytes: 0,
        };
      },
      listEntityIdsAtHeight: async () => {
        historicalListingCalled = true;
        return [`0x${'de'.repeat(32)}`, entityId];
      },
      loadEntityViewPage: async () => ({
        core: projectEntityReplicaCoreView(replica.state, replica),
        accounts: { items: [], nextCursor: null },
        books: { items: [], nextCursor: null },
      }),
    },
    'view-frame',
    { entityId, accountsLimit: 1 },
  );

  expect(historicalListingCalled).toBe(false);
  expect(frame.height).toBe(8);
  expect(frame.activeEntity?.core.entityId).toBe(entityId);
  expect(frame.entities.map(summary => summary.entityId)).toContain(entityId);
});

test('runtime adapter history-frame-batch returns bounded historical view frames in one read', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  const loadedHeights: number[] = [];

  const batch = await resolveRuntimeAdapterRead<{
    requestedHeights: number[];
    frames: Array<{
      height: number;
      activeEntity: { accounts: { items: Array<{ rightEntity: string }> } } | null;
    }>;
    unavailable: Array<{ height: number; code: string; message: string }>;
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 9,
        latestMaterializedHeight: 8,
        latestSnapshotHeight: 8,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      listEntityIdsAtHeight: async () => [entityId],
      loadEntityViewPage: async (_entityId, height) => {
        loadedHeights.push(height);
        return {
          core: projectEntityReplicaCoreView(replica.state, replica),
          accounts: { items: [projectAccountDoc(account)], nextCursor: null },
          books: { items: [], nextCursor: null },
        };
      },
    },
    'history-frame-batch',
    {
      heights: [8, 9, 10],
      entityId,
      accountsLimit: 1,
      booksLimit: 1,
    },
  );

  expect(batch.requestedHeights).toEqual([8, 9, 10]);
  expect(batch.frames.map(frame => frame.height)).toEqual([8, 9]);
  expect(batch.frames.every(frame => frame.activeEntity?.accounts.items.length === 1)).toBe(true);
  expect(batch.frames.every(frame => frame.activeEntity?.accounts.items[0]?.rightEntity === counterpartyId)).toBe(true);
  expect(batch.unavailable).toHaveLength(1);
  expect(batch.unavailable[0]?.height).toBe(10);
  expect(batch.unavailable[0]?.code).toBe('E_NOT_FOUND');
  expect(loadedHeights).toEqual([8, 8, 9, 9]);
});

test('runtime adapter history-frame-batch marks missing storage diffs unavailable without failing the batch', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;

  const batch = await resolveRuntimeAdapterRead<{
    frames: Array<{ height: number }>;
    unavailable: Array<{ height: number; code: string; message: string }>;
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 9,
        latestMaterializedHeight: 8,
        latestSnapshotHeight: 8,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      listEntityIdsAtHeight: async () => [entityId],
      loadEntityViewPage: async (_entityId, height) => {
        if (height === 8) throw new Error(`STORAGE_DIFF_MISSING: height=${height} scope=entity:${entityId}`);
        return {
          core: projectEntityReplicaCoreView(replica.state, replica),
          accounts: { items: [projectAccountDoc(account)], nextCursor: null },
          books: { items: [], nextCursor: null },
        };
      },
    },
    'history-frame-batch',
    {
      heights: [8, 9],
      entityId,
      accountsLimit: 1,
      booksLimit: 1,
    },
  );

  expect(batch.frames.map(frame => frame.height)).toEqual([9]);
  expect(batch.unavailable).toHaveLength(1);
  expect(batch.unavailable[0]).toMatchObject({
    height: 8,
    code: 'E_NOT_FOUND',
  });
  expect(batch.unavailable[0]?.message).toContain('STORAGE_DIFF_MISSING');
});

test('runtime adapter history-frame-batch fails fast on malformed queries', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({ env }, 'history-frame-batch', { heights: ['1.5'] })).rejects.toThrow(
    'heights must be positive integers',
  );
});

test('runtime adapter activity read uses typed projection context', async () => {
  const env = makeEnv();
  const seen: unknown[] = [];

  const page = await resolveRuntimeAdapterRead<{
    ok: true;
    runtimeId?: string;
    latestHeight: number;
    events: Array<{ id: string; type: string }>;
  }>(
    {
      env,
      readActivityPage: async opts => {
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
          events: [
            {
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
            },
          ],
        };
      },
    },
    'activity',
    {
      entityId,
      kind: 'offchain',
      types: 'payment,htlc',
      q: 'accepted',
      beforeHeight: 12,
      limit: 40,
      scanLimit: 100,
    },
  );

  expect(page.latestHeight).toBe(12);
  expect(page.events).toHaveLength(1);
  expect(seen).toEqual([
    {
      entityId,
      kind: 'offchain',
      types: ['payment', 'htlc'],
      query: 'accepted',
      fromTimestamp: undefined,
      toTimestamp: undefined,
      beforeHeight: 12,
      limit: 40,
      scanLimit: 100,
    },
  ]);
});

test('runtime adapter activity read forwards bounded deep scan requests', async () => {
  const env = makeEnv();
  const seen: unknown[] = [];

  await resolveRuntimeAdapterRead(
    {
      env,
      readActivityPage: async opts => {
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
    },
    'activity',
    {
      entityId,
      kind: 'offchain',
      types: ['payment'],
      limit: 80,
      scanLimit: 1000,
    },
  );

  expect(seen).toEqual([
    {
      entityId,
      kind: 'offchain',
      types: ['payment'],
      query: '',
      fromTimestamp: undefined,
      toTimestamp: undefined,
      beforeHeight: undefined,
      limit: 80,
      scanLimit: 1000,
    },
  ]);
});

test('runtime adapter activity read fails fast on malformed queries', async () => {
  const env = makeEnv();

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readActivityPage: async () => {
          throw new Error('reader should not run');
        },
      },
      'activity',
      { kind: 'bad-kind' as never },
    ),
  ).rejects.toThrow('activity kind must be all, onchain, or offchain');

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readActivityPage: async () => {
          throw new Error('reader should not run');
        },
      },
      'activity',
      { entityId: 'alice' },
    ),
  ).rejects.toThrow('activity entityId must be 0x + 64 hex chars');

  await expect(resolveRuntimeAdapterRead({ env }, 'activity', { entityId })).rejects.toThrow(
    'activity reads are unavailable for this adapter',
  );
});

test('runtime adapter historical reads fail closed when storage loaders are missing', async () => {
  const env = makeEnv();

  await expect(resolveRuntimeAdapterRead({ env }, 'entities', { atHeight: env.state.height - 1 })).rejects.toThrow(
    'storage entity listing is required for historical reads',
  );
  await expect(resolveRuntimeAdapterRead({ env }, 'head', { atHeight: env.state.height - 1 })).rejects.toThrow(
    'storage head reader is required for historical reads',
  );
  await expect(
    resolveRuntimeAdapterRead({ env, listEntityIdsAtHeight: async () => [entityId] }, 'view-frame', {
      atHeight: env.state.height - 1,
    }),
  ).rejects.toThrow('storage head reader is required for historical reads');
});

test('runtime adapter historical view frame fails closed when storage head is missing', async () => {
  const env = makeEnv();

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readHead: async () => null,
        listEntityIdsAtHeight: async () => [entityId],
        loadEntityViewPage: async () => {
          throw new Error('view page loader should not run after missing head');
        },
      },
      'view-frame',
      { atHeight: env.state.height - 1 },
    ),
  ).rejects.toThrow('storage head not found at height');
});

test('runtime adapter historical entity summaries fail closed when listed state is missing', async () => {
  const env = makeEnv();

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        listEntityIdsAtHeight: async () => [entityId],
        loadEntityViewPage: async () => null,
        loadEntityState: async () => null,
      },
      'entities',
      { atHeight: env.state.height - 1 },
    ),
  ).rejects.toThrow('entity summary not found at height');
});

test('runtime adapter historical head reads persisted storage head', async () => {
  const env = makeEnv();
  const head = await resolveRuntimeAdapterRead<{ latestHeight: number; latestSnapshotHeight: number }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: 42,
        latestMaterializedHeight: 41,
        latestSnapshotHeight: 40,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 123,
      }),
    },
    'head',
    { atHeight: env.state.height - 1 },
  );

  expect(head.latestHeight).toBe(42);
  expect(head.latestSnapshotHeight).toBe(40);
});

test('runtime adapter current head exposes persisted snapshot cadence when storage is available', async () => {
  const env = makeEnv();
  env.state.height = 45;
  const storedHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 45,
    latestMaterializedHeight: 45,
    latestSnapshotHeight: 40,
    snapshotPeriodFrames: 5,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 1234,
  };

  const head = await resolveRuntimeAdapterRead<StorageHead>(
    {
      env,
      readHead: async () => storedHead,
    },
    'head',
  );
  const frame = await resolveRuntimeAdapterRead<{ head: StorageHead }>(
    {
      env,
      readHead: async () => storedHead,
      loadEntityViewPage: makeTestViewPageLoader(env),
    },
    'view-frame',
    { accountsLimit: 1, booksLimit: 1 },
  );

  expect(head.latestHeight).toBe(45);
  expect(head.latestSnapshotHeight).toBe(40);
  expect(head.snapshotPeriodFrames).toBe(5);
  expect(head.retainedHistoryBytes).toBe(1234);
  expect(frame.head.latestSnapshotHeight).toBe(40);
  expect(frame.head.snapshotPeriodFrames).toBe(5);
});

test('runtime adapter current head preserves persisted snapshot cadence when storage lags live height', async () => {
  const env = makeEnv();
  env.state.height = 19;
  const storedHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 16,
    latestMaterializedHeight: 16,
    latestSnapshotHeight: 16,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 4321,
  };

  const head = await resolveRuntimeAdapterRead<StorageHead>(
    {
      env,
      readHead: async () => storedHead,
    },
    'head',
  );

  expect(head.latestHeight).toBe(19);
  expect(head.latestSnapshotHeight).toBe(16);
  expect(head.snapshotPeriodFrames).toBe(256);
  expect(head.retainedHistoryBytes).toBe(4321);
});

test('runtime adapter rejects historical reads beyond the persisted storage head', async () => {
  const env = makeEnv();
  env.state.height = 20;
  const persistedHead: StorageHead = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    latestHeight: 8,
    latestMaterializedHeight: 8,
    latestSnapshotHeight: 8,
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1,
    accountMerkleRadix: 16,
    epochReplayBytes: 0,
    retainedHistoryBytes: 0,
  };
  let listedEntities = false;

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readHead: async () => persistedHead,
      },
      'head',
      { atHeight: 9 },
    ),
  ).rejects.toThrow('head height unavailable');

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readHead: async () => persistedHead,
        listEntityIdsAtHeight: async () => {
          listedEntities = true;
          return [entityId];
        },
      },
      'entities',
      { atHeight: 9 },
    ),
  ).rejects.toThrow('entity summary height unavailable');
  expect(listedEntities).toBe(false);

  await expect(
    resolveRuntimeAdapterRead(
      {
        env,
        readHead: async () => persistedHead,
        listEntityIdsAtHeight: async () => {
          throw new Error('future view-frame must not list entities');
        },
        loadEntityViewPage: async () => {
          throw new Error('future view-frame must not load entity pages');
        },
      },
      'view-frame',
      { atHeight: 9 },
    ),
  ).rejects.toThrow('view-frame height unavailable');
});

test('runtime adapter historical account search uses the point storage loader', async () => {
  const env = makeEnv();
  env.state.height = 9;
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const account = replica.state.accounts.get(counterpartyId)!;
  let viewPageCalled = false;
  let pointLookup: { entityId: string; counterpartyId: string; height: number } | null = null;

  const result = await resolveRuntimeAdapterRead<{
    items: Array<{ rightEntity: string }>;
    totalItems?: number;
  }>(
    {
      env,
      loadEntityAccountDoc: async (requestedEntityId, requestedCounterpartyId, height) => {
        pointLookup = { entityId: requestedEntityId, counterpartyId: requestedCounterpartyId, height };
        return projectAccountDoc(account);
      },
      loadEntityViewPage: async () => {
        viewPageCalled = true;
        return null;
      },
    },
    `entity/${entityId}/accounts`,
    {
      atHeight: 8,
      accountId: counterpartyId,
      accountsLimit: 1,
    },
  );

  expect(result.items.map(item => item.rightEntity)).toEqual([counterpartyId]);
  expect(result.totalItems).toBe(1);
  expect(pointLookup).toEqual({ entityId, counterpartyId, height: 8 });
  expect(viewPageCalled).toBe(false);
});

test('runtime adapter current view frame projects live state without replaying persisted history', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  let pagedLoadCalled = false;

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      accounts: {
        items: Array<{ rightEntity: string }>;
        summary?: { totalItems: number | null; visibleItems: number; sampleIds: string[] };
      };
    } | null;
  }>(
    {
      env,
      readHead: async () => ({
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
      }),
      loadEntityViewPage: async () => {
        pagedLoadCalled = true;
        throw new Error('current view-frame must not replay persisted history');
      },
    },
    'view-frame',
    { accountsLimit: 1 },
  );

  expect(pagedLoadCalled).toBe(false);
  expect(frame.activeEntity?.accounts.items).toHaveLength(1);
  expect(frame.activeEntity?.accounts.items[0]?.rightEntity).toBe(counterpartyId);
  expect(frame.activeEntity?.accounts.summary).toMatchObject({
    totalItems: 1,
    visibleItems: 1,
    sampleIds: [counterpartyId],
  });
});

test('runtime adapter historical 1M account view-frame stays aggregate-first and under wire budget', async () => {
  const env = makeEnv();
  env.state.height = 2;
  const replica = Array.from(env.state.eReplicas.values())[0]!;
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
  }>(
    {
      env,
      readHead: async () => ({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        latestHeight: env.state.height,
        latestMaterializedHeight: env.state.height,
        latestSnapshotHeight: env.state.height,
        snapshotPeriodFrames: 256,
        retainSnapshots: 3,
        epochMaxBytes: 1,
        accountMerkleRadix: 16,
        epochReplayBytes: 0,
        retainedHistoryBytes: 0,
      }),
      listEntityIdsAtHeight: async () => [entityId],
      loadEntityViewPage: async () => {
        loaderCalls += 1;
        return {
          core: projectEntityReplicaCoreView(replica.state, replica),
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
    },
    'view-frame',
    { entityId, atHeight: 1, accountsLimit: 10, booksLimit: 10 },
  );
  const elapsedMs = Date.now() - startedAt;
  const encoded = encodeRuntimeAdapterMessage({ v: 1, inReplyTo: 'budget', ok: true, payload: frame });

  expect(loaderCalls).toBe(2);
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
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  const largeNote = 'x'.repeat(4_000);
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
    replica.htlcNotes?.set(id, largeNote);
    replica.state.crossJurisdictionSwaps.set(id, route as any);
  }

  const frame = await resolveRuntimeAdapterRead<{
    activeEntity: {
      core: {
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
  expect('entityEncPrivKey' in (core ?? {})).toBe(false);
  expect(core?.htlcRoutes.size).toBeLessThanOrEqual(20);
  expect(core?.htlcNotes?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.crossJurisdictionSwaps?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.pendingCrossJurisdictionFillAcks?.size ?? 0).toBeLessThanOrEqual(20);
  expect(core?.crossJurisdictionBookAdmissions?.size ?? 0).toBeLessThanOrEqual(20);
});

test('runtime adapter view-frame excludes unbounded core internals from remote snapshots', async () => {
  const env = makeEnv();
  const replica = Array.from(env.state.eReplicas.values())[0]!;
  replica.state.nonces = new Map(
    Array.from({ length: 50_000 }, (_, index) => [`0x${index.toString(16).padStart(64, '0')}`, index]),
  );
  replica.state.crontabState = {
    tasks: new Map(),
    hooks: new Map(
      Array.from({ length: 10_000 }, (_, index) => [
        `hook-${index.toString().padStart(5, '0')}`,
        { method: 'hub_rebalance_kick', executeAt: index, payload: { note: 'x'.repeat(200) } },
      ]),
    ),
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
  replica.state.orderbookExt.referrals = new Map(
    Array.from({ length: 50_000 }, (_, index) => {
      const id = `0x${(index + 1).toString(16).padStart(64, '0')}`;
      return [id, { entityId: id, referrerId: null, timestamp: index }];
    }),
  );

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
});

test('remote runtime adapter rejects a tampered server identity proof', async () => {
  const previousWebSocket = globalThis.WebSocket;
  const identityEnv = makeEnv();

  class TamperedIdentityWebSocket {
    static readonly OPEN = 1;

    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      setTimeout(() => {
        this.readyState = TamperedIdentityWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(raw: unknown): void {
      const request = decodeTestRuntimeAdapterMessage<{ id: string; op: string; challenge?: string }>(raw);
      if (request.op !== 'auth') return;
      const identity = signRuntimeAdapterServerIdentity(identityEnv, request.challenge || '');
      const firstByte = identity.identitySignature.slice(2, 4) === '00' ? '01' : '00';
      identity.identitySignature = `0x${firstByte}${identity.identitySignature.slice(4)}`;
      setTimeout(
        () =>
          this.onmessage?.({
            data: encodeRuntimeAdapterMessage({
              v: 1,
              inReplyTo: request.id,
              ok: true,
              payload: {
                authLevel: 'admin',
                commandLaneKind: 'capability',
                currentHeight: 10,
                nextCommandSequence: 1,
                ...identity,
              },
            }),
          }),
        0,
      );
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = TamperedIdentityWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    await expect(
      adapter.connect({
        mode: 'remote',
        wsUrl: 'ws://runtime-adapter.invalid/rpc',
        authKey: 'token',
        reconnectMaxMs: 1_000,
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toThrow('runtime adapter server identity verification failed');
    expect(adapter.status).toBe('error');
    expect(adapter.authLevel).toBe(null);
    expect(adapter.serverFingerprint).toBe(null);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});
