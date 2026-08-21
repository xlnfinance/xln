import { describe, expect, test } from 'bun:test';

import {
  recordSwapClosedLifecycle,
  recordSwapOfferLifecycle,
  recordSwapResolveLifecycle,
} from '../../../account/tx/handlers/swap/lifecycle/history';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import type { AccountReplica, SwapOffer } from '../../../types/account';

const makeAccount = (): AccountReplica => ({
  state: {
    leftEntity: 'maker',
    rightEntity: 'hub',
    domain: { chainId: 31337, depositoryAddress: `0x${'dd'.repeat(20)}` },
    watchSeed: `0x${'44'.repeat(32)}`,
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    jNonce: 0,
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
  },
  status: 'active',
  mempool: [],
  swapOrderHistory: new Map(),
  swapClosedOrders: new Map(),
  currentFrame: {
    height: 0,
    timestamp: 0,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: '',
    deltas: [],
    stateHash: '',
    byLeft: true,
  },
  currentHeight: 0,
  rollbackCount: 0,
  proofHeader: { fromEntity: 'maker', toEntity: 'hub', nextProofNonce: 0 },
  frameHistory: [],
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
});

describe('swap order history', () => {
  test('rejects a replica without its canonical lifecycle maps', () => {
    const malformed = makeAccount() as AccountReplica & {
      swapOrderHistory?: AccountReplica['swapOrderHistory'];
    };
    delete malformed.swapOrderHistory;
    expect(() => recordSwapOfferLifecycle(malformed as AccountReplica, {
      offerId: 'missing-map',
      giveTokenId: 1,
      giveAmount: 1n,
      wantTokenId: 2,
      wantAmount: 1n,
      makerIsLeft: true,
      createdHeight: 1,
    })).toThrow('ACCOUNT_SWAP_HISTORY_MAP_REQUIRED');
  });

  test('resolve lifecycle is idempotent for retried identical account application', () => {
    const account = makeAccount();
    const offer: SwapOffer = {
      offerId: 'offer-1',
      giveTokenId: 2,
      giveAmount: 40n,
      wantTokenId: 1,
      wantAmount: 100n,
      makerIsLeft: true,
      createdHeight: 1,
      quantizedGive: 40n,
      quantizedWant: 100n,
      priceTicks: 25_000_000n,
    };
    recordSwapOfferLifecycle(account, offer);

    const resolve = {
      fillRatio: 32768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      cancelRemainder: false,
      height: 2,
      executionGiveAmount: 20n,
      executionWantAmount: 50n,
    };

    recordSwapResolveLifecycle(account, offer.offerId, 2, resolve);
    recordSwapResolveLifecycle(account, offer.offerId, 2, { ...resolve });

    const history = account.swapOrderHistory.get(offer.offerId);
    expect(history?.originalGiveAmount).toBe(40n);
    expect(history?.originalWantAmount).toBe(100n);
    expect(history?.resolves).toHaveLength(1);
  });

  test('closed cross-j history owns an isolated route graph', () => {
    const account = makeAccount();
    const route = {
      orderId: 'cross-order-1',
      routeHash: `0x${'11'.repeat(32)}`,
      makerEntityId: 'maker',
      hubEntityId: 'hub',
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      source: {
        jurisdiction: 'source-j',
        entityId: 'maker',
        counterpartyEntityId: 'source-hub',
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: 'target-j',
        entityId: 'target',
        counterpartyEntityId: 'target-hub',
        tokenId: 2,
        amount: 200n,
      },
      sourcePull: {
        pullId: 'source-pull',
        tokenId: 1,
        amount: 100n,
        signedAmount: 100n,
        fullHash: `0x${'22'.repeat(32)}`,
        partialRoot: `0x${'33'.repeat(32)}`,
      },
      status: 'resting' as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const offer: SwapOffer = {
      offerId: route.orderId,
      giveTokenId: 1,
      giveAmount: 100n,
      wantTokenId: 2,
      wantAmount: 200n,
      makerIsLeft: true,
      createdHeight: 1,
      crossJurisdiction: route,
    };
    recordSwapOfferLifecycle(account, offer);
    recordSwapClosedLifecycle(account, offer.offerId);

    const activeRoute = account.swapOrderHistory.get(offer.offerId)?.crossJurisdiction;
    const closedRoute = account.swapClosedOrders.get(offer.offerId)?.crossJurisdiction;
    expect(closedRoute).toEqual(activeRoute);
    expect(closedRoute).not.toBe(activeRoute);
    expect(closedRoute?.source).not.toBe(activeRoute?.source);
    expect(() => structuredClone(account)).not.toThrow();
  });
});
