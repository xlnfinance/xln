import { expect, test } from 'bun:test';

import { computeCanonicalEntityHash, computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';
import { applyCommand, createBook, replaceOrderbookPair } from '../orderbook';
import { hydrateEntityStateFromStorage, projectAccountDoc, projectEntityCoreDoc, projectReplicaMeta } from '../storage/projections';
import type { AccountMachine, EntityReplica, Env } from '../types';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const makeAccount = (frameStateHash: string): AccountMachine =>
  ({
    leftEntity: entityId,
    rightEntity: counterpartyId,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '0x0',
      stateHash: '0x1',
      deltas: [],
    },
    deltas: new Map([[1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 10n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
    }]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 1,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [{
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '0x0',
      stateHash: frameStateHash,
      deltas: [],
    }],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  }) as AccountMachine;

const makeEnv = (account: AccountMachine, reserves: Array<[number, bigint]>): Env =>
  ({
    height: 7,
    timestamp: 1234,
    eReplicas: new Map<string, EntityReplica>([
      [`${entityId}:1`, {
        entityId,
        signerId: '1',
        mempool: [],
        isProposer: true,
        state: {
          entityId,
          height: 7,
          timestamp: 1234,
          messages: [],
          nonces: new Map([['1', 1]]),
          proposals: new Map(),
          config: { mode: 'proposer-based', threshold: 1n, validators: ['1'], shares: { '1': 1n } },
          reserves: new Map(reserves),
          accounts: new Map([[counterpartyId, account]]),
          deferredAccountProposals: new Map(),
          lastFinalizedJHeight: 0,
          jBlockObservations: [],
          jBlockChain: [],
          entityEncPubKey: 'pub',
          entityEncPrivKey: 'priv',
          profile: { name: 'canonical-test', isHub: false, avatar: '', bio: '', website: '' },
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

const sharedOrderId = 'account:offer-1';

const createBookWithSharedOrder = () => {
  const book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 0 });
  return applyCommand(book, {
    kind: 0,
    ownerId: 'account',
    orderId: sharedOrderId,
    side: 0,
    tif: 0,
    postOnly: true,
    priceTicks: 100n,
    qtyLots: 1n,
  }).state;
};

const makeEnvWithOrderbookPairs = (pairIds: string[]): Env => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
  const orderbookExt = {
    books: new Map(),
    orderPairs: new Map(),
    referrals: new Map(),
    hubProfile: {},
  };
  for (const pairId of pairIds) {
    replaceOrderbookPair(orderbookExt as never, pairId, createBookWithSharedOrder());
  }
  replica.state.orderbookExt = orderbookExt as never;
  return env;
};

test('canonical storage hash is deterministic across Map insertion order', () => {
  const left = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[2, 20n], [1, 10n]]));
  const right = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 10n], [2, 20n]]));
  expect(left).toBe(right);
});

test('canonical storage hash is deterministic across orderbook pair index insertion order', () => {
  const left = makeEnvWithOrderbookPairs(['b-pair', 'a-pair']);
  const right = makeEnvWithOrderbookPairs(['a-pair', 'b-pair']);

  const leftIndex = Array.from(left.eReplicas.values())[0]!.state.orderbookExt!.orderPairs.get(sharedOrderId);
  const rightIndex = Array.from(right.eReplicas.values())[0]!.state.orderbookExt!.orderPairs.get(sharedOrderId);

  expect(leftIndex).toEqual(['a-pair', 'b-pair']);
  expect(rightIndex).toEqual(['a-pair', 'b-pair']);
  expect(computeCanonicalStateHashFromEnv(left)).toBe(computeCanonicalStateHashFromEnv(right));
});

test('canonical storage hash ignores UI frameHistory and reacts to consensus state', () => {
  const base = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 10n]]));
  const changedHistory = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-b'), [[1, 10n]]));
  const changedReserve = computeCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 11n]]));

  expect(changedHistory).toBe(base);
  expect(changedReserve).not.toBe(base);
});

test('canonical Entity hash excludes validator-private J history', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
  const before = computeCanonicalEntityHash(replica).hash;

  replica.jHistory = {
    jurisdictionRef: 'testnet:1',
    scannedThroughHeight: 25,
    tipBlockHash: `0x${'25'.repeat(32)}`,
    eventBlocks: new Map([[25, {
      jurisdictionRef: 'testnet:1',
      jHeight: 25,
      jBlockHash: `0x${'25'.repeat(32)}`,
      eventsHash: `0x${'26'.repeat(32)}`,
      events: [],
    }]]),
    blockHashes: new Map([[25, `0x${'25'.repeat(32)}`]]),
  };

  expect(computeCanonicalEntityHash(replica).hash).toBe(before);
});

test('storage projection round-trip preserves canonical account optional-field shape', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
  const state = replica.state;
  const account = state.accounts.get(counterpartyId)!;
  account.hankoSignature = '0xaccount-proof-hanko';
  account.pendingForward = {
    tokenId: 1,
    amount: 25n,
    route: [entityId, counterpartyId],
    description: 'projection-round-trip',
  };
  account.lendingIntents = new Map([['lend-0123456789abcdef', 'fund']]);
  account.subcontracts = new Map([['custom-transformer', {
    transformerAddress: `0x${'33'.repeat(20)}`,
    encodedBatch: '0x1234',
    allowances: [{ deltaIndex: 0, rightAllowance: 3n, leftAllowance: 4n }],
  }]]);
  account.disputePrepare = {
    startedAt: 100,
    readyAfter: 200,
    reason: 'projection-round-trip',
  };
  state.lending = {
    pools: new Map([['lend-0123456789abcdef', {
      positionId: 'lend-0123456789abcdef',
      hubEntityId: entityId,
      lenderEntityId: counterpartyId,
      tokenId: 1,
      principalAmount: 25n,
      availableAmount: 25n,
      borrowedAmount: 0n,
      interestBps: 100,
      termId: '1h',
      termMs: 3_600_000,
      createdAt: 100,
      updatedAt: 100,
      status: 'open',
    }]]),
    loans: new Map(),
  };

  expect(account.pulls).toBeUndefined();
  expect(account.swapOrderHistory).toBeUndefined();
  expect(account.swapClosedOrders).toBeUndefined();

  const hydratedState = hydrateEntityStateFromStorage({
    core: projectEntityCoreDoc(state, replica),
    accounts: new Map([[counterpartyId, projectAccountDoc(account)]]),
    books: new Map(),
  });

  const before = computeCanonicalEntityHash(replica);
  const after = computeCanonicalEntityHash({ ...replica, state: hydratedState });

  expect(hydratedState.accounts.get(counterpartyId)?.pulls).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.swapOrderHistory).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.swapClosedOrders).toBeUndefined();
  expect(hydratedState.accounts.get(counterpartyId)?.hankoSignature).toBe(account.hankoSignature);
  expect(hydratedState.accounts.get(counterpartyId)?.pendingForward).toEqual(account.pendingForward);
  expect(hydratedState.accounts.get(counterpartyId)?.lendingIntents).toEqual(account.lendingIntents);
  expect(hydratedState.accounts.get(counterpartyId)?.subcontracts).toEqual(account.subcontracts);
  expect(hydratedState.accounts.get(counterpartyId)?.disputePrepare).toEqual(account.disputePrepare);
  expect(hydratedState.lending).toEqual(state.lending);
  expect(after.hash).toBe(before.hash);
});

test('replica metadata projection preserves in-flight consensus and layout state', () => {
  const env = makeEnv(makeAccount('history-a'), [[1, 10n]]);
  const replica = Array.from(env.eReplicas.values())[0]!;
  replica.mempool = [{ type: 'broadcast', data: { message: 'pending' } }];
  replica.position = { x: 1, y: 2, z: 3, jurisdiction: 'Testnet' };
  replica.jHistory = {
    jurisdictionRef: 'testnet:1',
    scannedThroughHeight: 7,
    tipBlockHash: `0x${'07'.repeat(32)}`,
    eventBlocks: new Map(),
    blockHashes: new Map([[7, `0x${'07'.repeat(32)}`]]),
  };

  const meta = projectReplicaMeta(replica);

  expect(meta.mempool).toEqual(replica.mempool);
  expect(meta.position).toEqual(replica.position);
  expect(meta.jHistory).toEqual(replica.jHistory);
});
