import { describe, expect, test } from 'bun:test';

import {
  recordSwapClosedLifecycle,
  recordSwapOfferLifecycle,
  recordSwapResolveLifecycle,
} from '../account/tx/handlers/swap-history';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import type { AccountMachine, SwapOffer } from '../types';

const makeAccount = (): AccountMachine => ({
  leftEntity: 'maker',
  rightEntity: 'hub',
  status: 'active',
  mempool: [],
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
  deltas: new Map(),
  locks: new Map(),
  swapOffers: new Map(),
  globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
  currentHeight: 0,
  pendingSignatures: [],
  rollbackCount: 0,
  proofHeader: { fromEntity: 'maker', toEntity: 'hub', nextProofNonce: 0 },
  proofBody: { tokenIds: [], deltas: [] },
  frameHistory: [],
  pendingWithdrawals: new Map(),
  requestedRebalance: new Map(),
  requestedRebalanceFeeState: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
  rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
  lastFinalizedJHeight: 0,
  disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
  jNonce: 0,
});

describe('swap order history', () => {
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

    const history = account.swapOrderHistory?.get(offer.offerId);
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
        revealedUntilTimestamp: 1_700_000_000,
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

    const activeRoute = account.swapOrderHistory?.get(offer.offerId)?.crossJurisdiction;
    const closedRoute = account.swapClosedOrders?.get(offer.offerId)?.crossJurisdiction;
    expect(closedRoute).toEqual(activeRoute);
    expect(closedRoute).not.toBe(activeRoute);
    expect(closedRoute?.source).not.toBe(activeRoute?.source);
    expect(() => structuredClone(account)).not.toThrow();
  });
});
