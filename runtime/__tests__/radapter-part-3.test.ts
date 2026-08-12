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
} from '../api/runtime-adapter/security/auth';

import {
  decodeRuntimeAdapterBrowserMessage,
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
  runtimeAdapterMaxMessageBytes,
} from '../api/runtime-adapter/codec';

import { EmbeddedRuntimeAdapter } from '../api/runtime-adapter/embedded';

import { RemoteRuntimeAdapter } from '../api/runtime-adapter/remote';

import { verifyRuntimeAdapterServerIdentity } from '../api/runtime-adapter/security/server-identity';

import { buildRuntimeAdapterOwnerBindingDigest } from '../api/runtime-adapter/security/owner-binding';

import { signRuntimeAdapterServerIdentity } from '../api/runtime-adapter/security/server-identity-signer';

import {
  assertRuntimeAdapterGraphFrameWireBudget,
  resolveRuntimeAdapterRead,
  type RuntimeAdapterGraphFrame,
} from '../api/runtime-adapter/resolve';

import { decryptRuntimeRecoveryBundle, deriveRuntimeRecoveryLookupKey } from '../storage/recovery/bundle/crypto';

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
                      stateHash: '0x1',
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
                    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
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
      const request = decodeTestRuntimeAdapterMessage<{ id: string; op: string }>(raw);
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

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    RejectingAuthWebSocket as unknown as typeof WebSocket;
  try {
    const adapter = new RemoteRuntimeAdapter();
    await expect(
      adapter.connect({
        mode: 'remote',
        wsUrl: 'ws://runtime-adapter.invalid/rpc',
        authKey: 'wrong',
        reconnectMaxMs: 1_000,
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toThrow('bad auth');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(adapter.status).toBe('error');
    expect(adapter.authLevel).toBe(null);
    expect(constructed).toBe(1);
  } finally {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
  }
});
