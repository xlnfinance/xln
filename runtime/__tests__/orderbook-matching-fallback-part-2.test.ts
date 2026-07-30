import { describe, expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';

import { createBook, applyCommand, getBestAsk, getBestBid, getBookOrder, getBookSideLevels } from '../orderbook/core';

import { getSwapLotScale, ORDERBOOK_PRICE_SCALE, quoteAmountAtPrice, SWAP_LOT_SCALE } from '../orderbook/types';

import { removeCrossJurisdictionBookOrderByRouteId } from '../orderbook/cross-j';

import { processOrderbookCancels, processOrderbookSwaps } from '../entity/tx/handlers/account';

import { applyCrossJurisdictionBookProgressToState } from '../entity/tx/handlers/cross-j-book-order';

import { handleSwapResolve } from '../account/tx/handlers/swap-resolve';

import { createEmptyEnv } from '../runtime';
import { publishEntityCandidateEffects } from '../runtime/env-events';

import { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../extensions/cross-j/fill-ack';

import {
  deriveCanonicalSwapFillRatio,
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
} from '../orderbook/swap-execution';

import type { AccountState, AccountTx, SwapOffer } from '../types/account';
import type { EntityCandidateEffect } from '../entity/types';

import { createDefaultDelta } from '../account/delta';

const TESTNET_STACK = `stack:31337:0x${'11'.repeat(20)}`;

const TRON_STACK = `stack:31338:0x${'22'.repeat(20)}`;

const CROSS_WETH_USDC_PAIR = `cross:${TESTNET_STACK}:2/${TRON_STACK}:1`;

const CROSS_USDC_USDC_PAIR = `cross:${TESTNET_STACK}:1/${TRON_STACK}:1`;

const processCommittedOrderbookSwaps = (
  state: Parameters<typeof processOrderbookSwaps>[0],
  offers: NormalizedOrderbookOffer[],
  options?: Parameters<typeof processOrderbookSwaps>[2],
) => processOrderbookSwaps(state, offers.map(markWorkingOrderbookOffer), options);

function makeAccountMachine(offer: SwapOffer): AccountState {
  const heldGiveAmount = offer.quantizedGive ?? offer.giveAmount;
  const giveDelta = createDefaultDelta(offer.giveTokenId);
  giveDelta.leftCreditLimit = 10n ** 30n;
  giveDelta.rightCreditLimit = 10n ** 30n;
  if (offer.makerIsLeft) {
    giveDelta.leftHold = heldGiveAmount;
  } else {
    giveDelta.rightHold = heldGiveAmount;
  }

  const wantDelta = createDefaultDelta(offer.wantTokenId);
  wantDelta.leftCreditLimit = 10n ** 30n;
  wantDelta.rightCreditLimit = 10n ** 30n;

  return {
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
    deltas: new Map([
      [offer.giveTokenId, giveDelta],
      [offer.wantTokenId, wantDelta],
    ]),
    locks: new Map(),
    swapOffers: new Map([[offer.offerId, offer]]),
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
  };
}

describe('orderbook matching fallback execution mapping', () => {
  test('validates a remote cross-j book order from admitted route without refreshing it', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const filledSourceAmount = 10_000n * lot;
    const filledTargetAmount = quoteAmountAtPrice(2, 1, filledSourceAmount, 25_000_000n);
    const remainingSource = sourceTotal - filledSourceAmount;
    const pairId = CROSS_WETH_USDC_PAIR;
    const namespacedOrderId = 'maker-entity:maker-cross-partial';
    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 30_000n,
    }).state;

    const route = {
      orderId: 'maker-cross-partial',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'maker-entity',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: sourceTotal,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: targetTotal,
      },
      fillSeq: 1,
      cumulativeFillRatio: 16_384,
      claimedRatio: 16_384,
      filledSourceAmount,
      filledTargetAmount,
      sourceClaimed: filledSourceAmount,
      targetClaimed: filledTargetAmount,
      status: 'partially_filled',
      createdAt: 1,
      updatedAt: 2,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map(),
      crossJurisdictionBookAdmissions: new Map([
        [
          'maker-entity:maker-cross-partial',
          {
            orderId: 'maker-cross-partial',
            routeHash: 'hash',
            sourceEntityId: 'maker-entity',
            bookOwnerEntityId: 'hub-entity',
            status: 'admitted',
            route,
            updatedAt: 2,
          },
        ],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, staleBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [] as any);

    expect(result.bookUpdates).toEqual([]);
    expect(getBookOrder(staleBook, namespacedOrderId)?.qtyLots).toBe(30_000n);
  });

  test('applies committed cross-j book progress before matcher sees the next snapshot', () => {
    const env = createEmptyEnv('cross-book-progress');
    env.state.timestamp = 2;
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const filledSourceAmount = 10_000n * lot;
    const filledTargetAmount = quoteAmountAtPrice(2, 1, filledSourceAmount, 25_000_000n);
    const pairId = CROSS_WETH_USDC_PAIR;
    const namespacedOrderId = 'maker-entity:maker-cross-progress';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 40_000n,
    }).state;

    const route = {
      orderId: 'maker-cross-progress',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'maker-entity',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: sourceTotal,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: targetTotal,
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const entityState = {
      entityId: 'hub-entity',
      timestamp: 2,
      accounts: new Map(),
      crossJurisdictionBookAdmissions: new Map([
        [
          'maker-entity:maker-cross-progress',
          {
            orderId: 'maker-cross-progress',
            routeHash: 'hash',
            sourceEntityId: 'maker-entity',
            bookOwnerEntityId: 'hub-entity',
            status: 'admitted',
            route,
            updatedAt: 1,
          },
        ],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const changed = applyCrossJurisdictionBookProgressToState(env, entityState, {
      orderId: 'maker-cross-progress',
      sourceEntityId: 'maker-entity',
      fillSeq: 1,
      incrementalSourceAmount: filledSourceAmount,
      incrementalTargetAmount: filledTargetAmount,
      cumulativeSourceAmount: filledSourceAmount,
      cumulativeTargetAmount: filledTargetAmount,
      cumulativeFillRatio: 16_384,
      fillNumerator: 1n,
      fillDenominator: 4n,
      reason: 'test_committed_ack',
    });

    const admission = entityState.crossJurisdictionBookAdmissions.get('maker-entity:maker-cross-progress');
    expect(changed).toBe(true);
    expect(admission?.route.status).toBe('partially_filled');
    expect(admission?.route.filledSourceAmount).toBe(filledSourceAmount);
    expect(admission?.route.filledTargetAmount).toBe(filledTargetAmount);
    expect(getBookOrder(book, namespacedOrderId)?.qtyLots).toBe(30_000n);

    admission!.pendingFill = {
      fillId: 'pending-exact-duplicate',
      ackKind: 'fill',
      fillSeq: 1,
      cumulativeFillRatio: 0,
      cumulativeSourceAmount: filledSourceAmount,
      cumulativeTargetAmount: filledTargetAmount,
      fillNumerator: 1n,
      fillDenominator: 4n,
      routeHash: admission!.routeHash,
      updatedAt: 2,
      firstSeenAt: 2,
    };
    const duplicateChanged = applyCrossJurisdictionBookProgressToState(env, entityState, {
      orderId: 'maker-cross-progress',
      sourceEntityId: 'maker-entity',
      fillSeq: 1,
      incrementalSourceAmount: 0n,
      incrementalTargetAmount: 0n,
      cumulativeSourceAmount: filledSourceAmount,
      cumulativeTargetAmount: filledTargetAmount,
      cumulativeFillRatio: 0,
      fillNumerator: 1n,
      fillDenominator: 4n,
      reason: 'duplicate_exact_only_ack',
    });
    expect(duplicateChanged).toBe(false);
    expect(admission?.pendingFill).toBeUndefined();
    expect(admission?.route.fillSeq).toBe(1);
    expect(() => processCommittedOrderbookSwaps(entityState, [] as any)).not.toThrow();

    expect(removeCrossJurisdictionBookOrderByRouteId(entityState, 'maker-entity', 'maker-cross-progress', [])).toBe(
      true,
    );
    expect(getBookOrder(book, namespacedOrderId)).toBeNull();

    const halfSourceAmount = 20_000n * lot;
    const halfTargetAmount = quoteAmountAtPrice(2, 1, halfSourceAmount, 25_000_000n);
    const materialized = applyCrossJurisdictionBookProgressToState(env, entityState, {
      orderId: 'maker-cross-progress',
      sourceEntityId: 'maker-entity',
      fillSeq: 2,
      incrementalSourceAmount: halfSourceAmount - filledSourceAmount,
      incrementalTargetAmount: halfTargetAmount - filledTargetAmount,
      cumulativeSourceAmount: halfSourceAmount,
      cumulativeTargetAmount: halfTargetAmount,
      cumulativeFillRatio: 32_768,
      fillNumerator: 1n,
      fillDenominator: 2n,
      reason: 'committed_taker_remainder',
    });
    expect(materialized).toBe(true);
    expect(getBookOrder(book, namespacedOrderId)?.qtyLots).toBe(20_000n);
  });

  test('suspends a cross-j order while its partial fill ack is pending', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const filledSourceAmount = 10000152590218966n;
    const filledTargetAmount = quoteAmountAtPrice(2, 1, filledSourceAmount, 25_000_000n);
    const remainingSource = sourceTotal - filledSourceAmount;
    const pairId = CROSS_WETH_USDC_PAIR;
    const makerOrderId = 'maker-account:maker-cross-pending';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: remainingSource / lot,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-pending',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'maker-entity',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: sourceTotal,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: targetTotal,
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const makerOffer = {
      offerId: 'maker-cross-pending',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: sourceTotal,
      quantizedGive: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      quantizedWant: targetTotal,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    };
    const takerRoute = {
      ...makerRoute,
      orderId: 'taker-cross-pending',
      makerEntityId: 'taker-entity',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: filledTargetAmount,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: filledSourceAmount,
      },
      status: 'resting',
    };
    const takerOffer = {
      offerId: 'taker-cross-pending',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: filledTargetAmount,
      quantizedGive: filledTargetAmount,
      wantTokenId: 2,
      wantAmount: filledSourceAmount,
      quantizedWant: filledSourceAmount,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-account',
          {
            swapOffers: new Map([['maker-cross-pending', makerOffer]]),
            pendingFrame: {
              accountTxs: [
                {
                  type: 'cross_swap_fill_ack',
                  data: {
                    offerId: 'maker-cross-pending',
                    fillSeq: 1,
                    incrementalSourceAmount: filledSourceAmount,
                    incrementalTargetAmount: filledTargetAmount,
                    cumulativeSourceAmount: filledSourceAmount,
                    cumulativeTargetAmount: filledTargetAmount,
                    cumulativeFillRatio: 16_384,
                    cancelRemainder: false,
                  },
                },
              ],
            },
          },
        ],
        ['taker-account', { swapOffers: new Map([['taker-cross-pending', takerOffer]]) }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer] as any);

    expect(result.accountTxs).toEqual([]);
    expect(result.crossJurisdictionFills).toEqual([]);
    expect(getBookOrder(book, makerOrderId)).not.toBeNull();
  });

  test('fails fast when pending cross-j ack has no swapOffer or admitted route to validate the row', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const filledSourceAmount = 10000152590218966n;
    const filledTargetAmount = quoteAmountAtPrice(2, 1, filledSourceAmount, 25_000_000n);
    const remainingSource = sourceTotal - filledSourceAmount;
    const pairId = CROSS_WETH_USDC_PAIR;
    const makerOrderId = 'maker-account:maker-cross-pending';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: remainingSource / lot,
    }).state;

    const route = {
      orderId: 'taker-cross-pending',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'taker-entity',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: filledTargetAmount,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: filledSourceAmount,
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const takerOffer = {
      offerId: 'taker-cross-pending',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: filledTargetAmount,
      quantizedGive: filledTargetAmount,
      wantTokenId: 2,
      wantAmount: filledSourceAmount,
      quantizedWant: filledSourceAmount,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: route,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-account',
          {
            swapOffers: new Map(),
            pendingFrame: {
              accountTxs: [
                {
                  type: 'cross_swap_fill_ack',
                  data: {
                    offerId: 'maker-cross-pending',
                    fillSeq: 1,
                    incrementalSourceAmount: filledSourceAmount,
                    incrementalTargetAmount: filledTargetAmount,
                    cumulativeSourceAmount: filledSourceAmount,
                    cumulativeTargetAmount: filledTargetAmount,
                    cumulativeFillRatio: 16_384,
                    cancelRemainder: false,
                  },
                },
              ],
            },
          },
        ],
        ['taker-account', { swapOffers: new Map([['taker-cross-pending', takerOffer]]) }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerOffer] as any)).toThrow(
      /ORDERBOOK_CROSS_J_SNAPSHOT_MISSING/,
    );
  });

  test('keeps matching committed cross-j orders while another order has a pending fill ack', () => {
    const lot = getSwapLotScale(1);
    const pairId = CROSS_USDC_USDC_PAIR;
    const pendingOrderId = 'maker-pending-account:maker-cross-pending';
    const committedOrderId = 'maker-committed-account:maker-cross-committed';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-pending',
      orderId: pendingOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 2n,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-committed',
      orderId: committedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 2n,
    }).state;

    const pendingRoute = {
      orderId: 'maker-cross-pending',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'maker-pending',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-pending',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-pending',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const pendingOffer = {
      offerId: 'maker-cross-pending',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-pending',
      accountId: 'maker-pending-account',
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: 2n * lot,
      quantizedGive: 2n * lot,
      wantTokenId: 1,
      wantAmount: 2n * lot,
      quantizedWant: 2n * lot,
      timeInForce: 0,
      priceTicks: 10_000n,
      crossJurisdiction: pendingRoute,
    };
    const committedRoute = {
      ...pendingRoute,
      orderId: 'maker-cross-committed',
      makerEntityId: 'maker-committed',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-committed',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-committed',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
    };
    const committedOffer = {
      offerId: 'maker-cross-committed',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-committed',
      accountId: 'maker-committed-account',
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: 2n * lot,
      quantizedGive: 2n * lot,
      wantTokenId: 1,
      wantAmount: 2n * lot,
      quantizedWant: 2n * lot,
      timeInForce: 0,
      priceTicks: 10_000n,
      crossJurisdiction: committedRoute,
    };
    const takerRoute = {
      ...committedRoute,
      orderId: 'taker-cross',
      makerEntityId: 'taker',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'taker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'taker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
      status: 'resting',
    };
    const takerOffer = {
      offerId: 'taker-cross',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: 2n * lot,
      quantizedGive: 2n * lot,
      wantTokenId: 1,
      wantAmount: 2n * lot,
      quantizedWant: 2n * lot,
      timeInForce: 0,
      priceTicks: 10_000n,
      crossJurisdiction: takerRoute,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-pending-account',
          {
            swapOffers: new Map([['maker-cross-pending', pendingOffer]]),
            pendingFrame: {
              accountTxs: [
                {
                  type: 'cross_swap_fill_ack',
                  data: {
                    offerId: 'maker-cross-pending',
                    fillSeq: 1,
                    incrementalSourceAmount: 2n * lot,
                    incrementalTargetAmount: 2n * lot,
                    cumulativeSourceAmount: 2n * lot,
                    cumulativeTargetAmount: 2n * lot,
                    cumulativeFillRatio: 65_535,
                    cancelRemainder: true,
                  },
                },
              ],
            },
          },
        ],
        ['maker-committed-account', { swapOffers: new Map([['maker-cross-committed', committedOffer]]) }],
        ['taker-account', { swapOffers: new Map([['taker-cross', takerOffer]]) }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer] as any);

    expect(getBookOrder(book, pendingOrderId)).not.toBeNull();
    expect(getBookOrder(book, committedOrderId)).toBeNull();
    expect(result.crossJurisdictionFills.map(fill => fill.offerId).sort()).toEqual([
      'maker-cross-committed',
      'taker-cross',
    ]);
    expect(result.accountTxs.map(op => `${op.accountId}:${op.tx.type}`).sort()).toEqual([
      'maker-committed-account:cross_swap_fill_ack',
      'taker-account:cross_swap_fill_ack',
    ]);
  });

  test('matches remote cross-j book metadata from admitted route without rebuilding the row', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const remoteOrderId = 'remote-maker:maker-cross';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'remote-maker',
      orderId: remoteOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 30n,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'remote-maker',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'remote-maker',
        counterpartyEntityId: 'remote-source-hub',
        tokenId: 2,
        amount: 30n * lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'hub-entity',
        counterpartyEntityId: 'remote-target-user',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const takerRoute = {
      ...makerRoute,
      orderId: 'taker-cross',
      makerEntityId: 'local-taker',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'local-taker',
        counterpartyEntityId: 'local-source-hub',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'hub-entity',
        counterpartyEntityId: 'local-target-user',
        tokenId: 2,
        amount: 30n * lot,
      },
    };
    const takerOffer = {
      offerId: 'taker-cross',
      makerIsLeft: true,
      fromEntity: 'local-taker',
      toEntity: 'local-source-hub',
      accountId: 'local-taker-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      wantTokenId: 2,
      wantAmount: 30n * lot,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['local-taker-account', { swapOffers: new Map([['taker-cross', takerOffer]]) }]]),
      crossJurisdictionBookAdmissions: new Map([
        [
          'remote-maker:maker-cross',
          {
            orderId: 'maker-cross',
            routeHash: 'hash',
            sourceEntityId: 'remote-maker',
            bookOwnerEntityId: 'hub-entity',
            status: 'admitted',
            route: makerRoute,
            updatedAt: 1,
          },
        ],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer] as any);

    expect(result.crossJurisdictionFills.map(fill => fill.offerId).sort()).toEqual(['maker-cross', 'taker-cross']);
    expect(result.accountTxs.map(op => `${op.accountId}:${op.tx.type}`).sort()).toEqual([
      'local-taker-account:cross_swap_fill_ack',
      'remote-maker:cross_swap_fill_ack',
    ]);
  });

  test('suspends remote admitted cross-j row while book progress is pending', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const remoteOrderId = 'remote-maker:maker-cross-pending-progress';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'remote-maker',
      orderId: remoteOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 30n,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-pending-progress',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'remote-maker',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'remote-maker',
        counterpartyEntityId: 'remote-source-hub',
        tokenId: 2,
        amount: 30n * lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'hub-entity',
        counterpartyEntityId: 'remote-target-user',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const takerRoute = {
      ...makerRoute,
      orderId: 'local-taker-cross-pending-progress',
      makerEntityId: 'local-taker',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'local-taker',
        counterpartyEntityId: 'local-source-hub',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'hub-entity',
        counterpartyEntityId: 'local-target-user',
        tokenId: 2,
        amount: 30n * lot,
      },
    };
    const takerOffer = {
      offerId: 'local-taker-cross-pending-progress',
      makerIsLeft: true,
      fromEntity: 'local-taker',
      toEntity: 'local-source-hub',
      accountId: 'local-taker-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      wantTokenId: 2,
      wantAmount: 30n * lot,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['local-taker-account', { swapOffers: new Map([['local-taker-cross-pending-progress', takerOffer]]) }],
      ]),
      crossJurisdictionBookAdmissions: new Map([
        [
          'remote-maker:maker-cross-pending-progress',
          {
            orderId: 'maker-cross-pending-progress',
            routeHash: 'hash',
            sourceEntityId: 'remote-maker',
            bookOwnerEntityId: 'hub-entity',
            status: 'admitted',
            route: makerRoute,
            pendingFill: {
              fillId: 'test-pending-fill',
              ackKind: 'fill',
              fillSeq: 1,
              cumulativeFillRatio: 16_384,
              cumulativeSourceAmount: 1n,
              cumulativeTargetAmount: 1n,
              routeHash: 'hash',
              updatedAt: 2,
              firstSeenAt: 2,
            },
            updatedAt: 2,
          },
        ],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer] as any);

    expect(result.crossJurisdictionFills).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    expect(getBookOrder(book, remoteOrderId)).not.toBeNull();
  });

  test('preserves expired remote admitted cross-j pending fill progress for replay', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const remoteOrderId = 'remote-maker:maker-cross-expired-pending-progress';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'remote-maker',
      orderId: remoteOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 30n,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-expired-pending-progress',
      routeHash: 'expired-pending-hash',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'remote-maker',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'remote-maker',
        counterpartyEntityId: 'remote-source-hub',
        tokenId: 2,
        amount: 30n * lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'hub-entity',
        counterpartyEntityId: 'remote-target-user',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const takerRoute = {
      ...makerRoute,
      orderId: 'local-taker-cross-expired-pending-progress',
      makerEntityId: 'local-taker',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'local-taker',
        counterpartyEntityId: 'local-source-hub',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'hub-entity',
        counterpartyEntityId: 'local-target-user',
        tokenId: 2,
        amount: 30n * lot,
      },
    };
    const takerOffer = {
      offerId: 'local-taker-cross-expired-pending-progress',
      makerIsLeft: true,
      fromEntity: 'local-taker',
      toEntity: 'local-source-hub',
      accountId: 'local-taker-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: quoteAmountAtPrice(2, 1, 30n * lot, 25_000_000n),
      wantTokenId: 2,
      wantAmount: 30n * lot,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };

    const entityState = {
      entityId: 'hub-entity',
      timestamp: CROSS_J_PENDING_FILL_ACK_TTL_MS + 100,
      accounts: new Map([
        ['local-taker-account', { swapOffers: new Map([['local-taker-cross-expired-pending-progress', takerOffer]]) }],
      ]),
      crossJurisdictionBookAdmissions: new Map([
        [
          'remote-maker:maker-cross-expired-pending-progress',
          {
            orderId: 'maker-cross-expired-pending-progress',
            routeHash: 'expired-pending-hash',
            sourceEntityId: 'remote-maker',
            bookOwnerEntityId: 'hub-entity',
            status: 'admitted',
            route: makerRoute,
            pendingFill: {
              fillId: 'test-expired-pending-fill',
              ackKind: 'fill',
              fillSeq: 1,
              cumulativeFillRatio: 16_384,
              cumulativeSourceAmount: 1n,
              cumulativeTargetAmount: 1n,
              routeHash: 'expired-pending-hash',
              updatedAt: 1,
              firstSeenAt: 1,
            },
            updatedAt: 1,
          },
        ],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const runtimeEnv = createEmptyEnv('cross-j-expired-book-fill-security-status');
    runtimeEnv.state.timestamp = entityState.timestamp;
    runtimeEnv.error = () => undefined;
    const candidateEffects: EntityCandidateEffect[] = [];
    expect(() => processCommittedOrderbookSwaps(
      entityState,
      [takerOffer] as any,
      { candidateEffects },
    )).not.toThrow();
    const admission = entityState.crossJurisdictionBookAdmissions.get(
      'remote-maker:maker-cross-expired-pending-progress',
    );
    expect(admission?.pendingFill?.ttlExpiredAt).toBe(entityState.timestamp);
    expect(runtimeEnv.infrastructure?.securityIncidents).toBeUndefined();
    publishEntityCandidateEffects(runtimeEnv, candidateEffects);
    expect([...runtimeEnv.infrastructure!.securityIncidents!.values()]).toContainEqual(
      expect.objectContaining({
        code: 'CROSS_J_BOOK_FILL_TTL_EXPIRED',
        status: 'active',
        entityId: entityState.entityId,
      }),
    );
  });

  test('suspends cross-j orders after the first same-pass fill until ACK commits', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_USDC_USDC_PAIR;
    const baseRoute = {
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      hubEntityId: 'hub-entity',
      createdAt: 1,
      updatedAt: 1,
      status: 'resting',
    };
    const makerRoute = {
      ...baseRoute,
      orderId: 'maker-cross',
      makerEntityId: 'maker-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: 2n * lot,
      },
    };
    const makerOffer = {
      offerId: 'maker-cross',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: 2n * lot,
      quantizedGive: 2n * lot,
      wantTokenId: 1,
      wantAmount: 2n * lot,
      quantizedWant: 2n * lot,
      timeInForce: 0,
      priceTicks: 10_000n,
      crossJurisdiction: makerRoute,
    };
    const takerOffer = (id: string) => {
      const route = {
        ...baseRoute,
        orderId: id,
        makerEntityId: id,
        source: {
          jurisdiction: TRON_STACK,
          entityId: id,
          counterpartyEntityId: 'hub-entity',
          tokenId: 1,
          amount: lot,
        },
        target: {
          jurisdiction: TESTNET_STACK,
          entityId: id,
          counterpartyEntityId: 'hub-entity',
          tokenId: 1,
          amount: lot,
        },
      };
      return {
        offerId: id,
        makerIsLeft: false,
        fromEntity: 'hub-entity',
        toEntity: id,
        accountId: `${id}-account`,
        createdHeight: 2,
        giveTokenId: 1,
        giveAmount: lot,
        quantizedGive: lot,
        wantTokenId: 1,
        wantAmount: lot,
        quantizedWant: lot,
        timeInForce: 0,
        priceTicks: 10_000n,
        crossJurisdiction: route,
      };
    };
    const takerOne = takerOffer('taker-one');
    const takerTwo = takerOffer('taker-two');

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map([['maker-cross', makerOffer]]) }],
        ['taker-one-account', { swapOffers: new Map([['taker-one', takerOne]]) }],
        ['taker-two-account', { swapOffers: new Map([['taker-two', takerTwo]]) }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map(),
        pairConfig: new Map(),
      },
    };

    const result = processCommittedOrderbookSwaps(entityState as any, [makerOffer, takerOne, takerTwo] as any);
    const makerAcks = result.accountTxs.filter(
      op => op.accountId === 'maker-account' && op.tx.type === 'cross_swap_fill_ack',
    );

    expect(makerAcks).toHaveLength(1);
    expect(makerAcks[0]?.tx.data.fillSeq).toBe(1);
    expect(makerAcks[0]?.tx.data.cumulativeFillRatio).toBe(32_768);
    expect(makerAcks[0]?.tx.data.incrementalSourceAmount).toBe(lot);
    expect(result.accountTxs.filter(op => op.tx.type === 'cross_swap_fill_ack')).toHaveLength(2);
    expect(
      result.accountTxs.some(op => op.accountId === 'taker-two-account' && op.tx.type === 'cross_swap_fill_ack'),
    ).toBe(false);
  });

  test('debug cross-j rebuild does not persist a resting projection', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_USDC_USDC_PAIR;
    const route = {
      orderId: 'debug-cross',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'maker-entity',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'maker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: lot,
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const offer = {
      offerId: 'debug-cross',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: lot,
      quantizedGive: lot,
      wantTokenId: 1,
      wantAmount: lot,
      quantizedWant: lot,
      timeInForce: 0,
      priceTicks: 10_000n,
      crossJurisdiction: route,
    };
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['maker-account', { swapOffers: new Map([['debug-cross', offer]]) }]]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: [pairId],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [offer] as any, {
      debugRebuildProjectionOnly: true,
    });

    expect(result.bookUpdates).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    expect(result.crossJurisdictionFills).toEqual([]);
    expect(result.debugProjectionRejects).toEqual([]);
    expect(entityState.orderbookExt.books.has(pairId)).toBe(false);
  });

  test('fails fast when persisted book price diverges from account offer', () => {
    const lot = SWAP_LOT_SCALE;
    const makerAsk = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (lot * 25_000_000n) / 10_000n,
      timeInForce: 0,
      priceTicks: 25_000_000n,
    };
    const crossedBid = {
      offerId: 'crossed-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'crossed-entity',
      accountId: 'crossed-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: (lot * 25_000_100n) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: 25_000_100n,
    };
    const takerBid = {
      offerId: 'taker-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      createdHeight: 3,
      giveTokenId: 1,
      giveAmount: (lot * 24_999_900n) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: 24_999_900n,
    };

    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: 'maker-account:maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 24_999_500n,
      qtyLots: 1n,
    }).state;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map([['maker-ask', makerAsk]]) }],
        ['crossed-account', { swapOffers: new Map([['crossed-bid', crossedBid]]) }],
        ['taker-account', { swapOffers: new Map() }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2'],
        },
        books: new Map([['1/2', staleBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerBid] as any)).toThrow(/ORDERBOOK_CACHE_MISMATCH/);
  });

  test('fails fast instead of auto-fixing a mismatched cached pair', () => {
    const firstAskPriceTicks = 25_000_002n;
    const secondAskPriceTicks = 25_000_006n;
    const bidPriceTicks = 24_999_998n;
    const lot = SWAP_LOT_SCALE;

    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-a',
      orderId: 'maker-account:maker-ask-a',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 24_999_998n,
      qtyLots: 1n,
    }).state;
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-b',
      orderId: 'maker-account:maker-ask-b',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: secondAskPriceTicks,
      qtyLots: 1n,
    }).state;

    const makeAskOffer = (offerId: string, makerEntity: string, priceTicks: bigint) => ({
      offerId,
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: makerEntity,
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (lot * priceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks,
    });
    const makerOfferA = makeAskOffer('maker-ask-a', 'maker-a', firstAskPriceTicks);
    const makerOfferB = makeAskOffer('maker-ask-b', 'maker-b', secondAskPriceTicks);
    const takerOffer = {
      offerId: 'taker-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: (lot * bidPriceTicks) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-account',
          {
            swapOffers: new Map([
              ['maker-ask-a', makerOfferA],
              ['maker-ask-b', makerOfferB],
            ]),
          },
        ],
        ['taker-account', { swapOffers: new Map() }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2'],
        },
        books: new Map([['1/2', staleBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerOffer] as any)).toThrow(/ORDERBOOK_CACHE_MISMATCH/);
  });

  test('suspends a persisted same-chain book order when its swap resolution is already pending', () => {
    const askPriceTicks = 25_000_000n;
    const bidPriceTicks = 25_000_000n;
    const lot = SWAP_LOT_SCALE;

    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: 'maker-account:maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: askPriceTicks,
      qtyLots: 1n,
    }).state;

    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (lot * askPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: askPriceTicks,
    };
    const takerOffer = {
      offerId: 'taker-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: (lot * bidPriceTicks) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-account',
          {
            swapOffers: new Map([['maker-ask', makerOffer]]),
            mempool: [
              {
                type: 'swap_resolve',
                data: {
                  offerId: 'maker-ask',
                  fillRatio: 32768,
                  cancelRemainder: false,
                },
              },
            ],
          },
        ],
        ['taker-account', { swapOffers: new Map() }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2'],
        },
        books: new Map([['1/2', staleBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer] as any);

    expect(result.accountTxs).toEqual([]);
    expect(getBookOrder(staleBook, 'maker-account:maker-ask')).not.toBeNull();
  });

  test('accepts wide-range resting orders without mutating the existing anchor order price', () => {
    const anchorPriceTicks = 25_015_002n;
    const overflowPriceTicks = 25_262_625n;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', { swapOffers: new Map() }]]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const anchorOffer = {
      offerId: 'offer-a',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: 210n * SWAP_LOT_SCALE,
      wantTokenId: 1,
      wantAmount: (210n * SWAP_LOT_SCALE * anchorPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: anchorPriceTicks,
    };

    entityState.accounts.get('alice')!.swapOffers = new Map([['offer-a', anchorOffer]]);
    const firstPass = processCommittedOrderbookSwaps(entityState, [anchorOffer] as any);
    const initialBook = firstPass.bookUpdates.at(-1)?.book;
    expect(initialBook).toBeDefined();
    expect(getBookOrder(initialBook!, 'alice:offer-a')).not.toBeNull();

    entityState.orderbookExt.books = new Map([['1/2', initialBook]]);

    const overflowOffer = {
      offerId: 'offer-b',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 2,
      giveTokenId: 2,
      giveAmount: 960n * SWAP_LOT_SCALE,
      wantTokenId: 1,
      wantAmount: (960n * SWAP_LOT_SCALE * overflowPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: overflowPriceTicks,
    };

    const overflowPass = processCommittedOrderbookSwaps(entityState, [overflowOffer] as any);
    const finalBook = overflowPass.bookUpdates.at(-1)?.book ?? entityState.orderbookExt.books.get('1/2');
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'alice:offer-a')?.priceTicks).toBe(anchorPriceTicks);
    expect(getBookOrder(finalBook!, 'alice:offer-b')?.priceTicks).toBe(overflowPriceTicks);
  });

  test('queues cancelRemainder instead of throwing when a pair book reaches its order cap', () => {
    const maxOrders = 3;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', { swapOffers: new Map() }]]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 2,
          supportedPairs: ['2/5'],
        },
        books: new Map([['2/5', createBook({ bucketWidthTicks: 10_000n, maxOrders, stpPolicy: 1 })]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const rejectedOfferId = `offer-${String(maxOrders + 1).padStart(2, '0')}`;
    const offers = Array.from({ length: maxOrders + 1 }, (_, index) => ({
      offerId: `offer-${String(index + 1).padStart(2, '0')}`,
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: index + 1,
      giveTokenId: 2,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 5,
      wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    }));

    const result = processCommittedOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(finalBook!.orders.size).toBe(maxOrders);

    const cancelOp = result.accountTxs.find(
      item => item.tx.type === 'swap_resolve' && item.tx.data.offerId === rejectedOfferId,
    );
    expect(cancelOp).toBeDefined();
    expect(cancelOp!.tx.data.cancelRemainder).toBe(true);
    expect(cancelOp!.tx.data.fillRatio).toBe(0);
  });

  test('fails fast on pair-local persisted book corruption', () => {
    const lot = SWAP_LOT_SCALE;
    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (lot * 10_000n) / 10_000n,
      timeInForce: 0,
      priceTicks: 10_000n,
    };
    const takerOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      createdHeight: 2,
      giveTokenId: 5,
      giveAmount: (lot * 10_000n) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: 10_000n,
    };

    let corruptedBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    corruptedBook = applyCommand(corruptedBook, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: 'maker-account:maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;
    const corruptedOrder = corruptedBook.orders.get('maker-account:maker-ask');
    expect(corruptedOrder).toBeDefined();
    corruptedOrder!.bucketId = 999_999n;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-account',
          {
            leftEntity: 'hub-entity',
            rightEntity: 'maker-entity',
            swapOffers: new Map([['maker-ask', makerOffer]]),
          },
        ],
        ['taker-account', { swapOffers: new Map() }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 2,
          supportedPairs: ['2/5'],
        },
        books: new Map([['2/5', corruptedBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerOffer] as any)).toThrow(
      /ORDERBOOK_PAIR_COMMAND_FAILED/,
    );
  });

  test('processOrderbookCancels queues account-level cancel once for an active orderbook order', () => {
    const lot = SWAP_LOT_SCALE;
    const offer = {
      offerId: 'offer-cancel',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (1000n * lot) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const aliceAccount = makeAccountMachine(offer as any);
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'alice',
      orderId: 'alice:offer-cancel',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', aliceAccount]]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2'],
        },
        books: new Map([['1/2', book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookCancels(entityState, [{ accountId: 'alice', offerId: 'offer-cancel' }]);
    expect(result.accountTxs).toHaveLength(1);
    expect(result.accountTxs[0]!.accountId).toBe('alice');
    expect(result.accountTxs[0]!.tx.type).toBe('swap_resolve');
    expect(result.accountTxs[0]!.tx.data.offerId).toBe('offer-cancel');
    expect(result.accountTxs[0]!.tx.data.cancelRemainder).toBe(true);
  });

  test('processOrderbookCancels does not duplicate account-level cancel already pending in frame', () => {
    const lot = SWAP_LOT_SCALE;
    const offer = {
      offerId: 'offer-cancel-pending',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (1000n * lot) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const aliceAccount = makeAccountMachine(offer as any);
    aliceAccount.pendingFrame = {
      height: 1,
      timestamp: 1,
      jHeight: 0,
      accountTxs: [
        { type: 'swap_resolve', data: { offerId: 'offer-cancel-pending', fillRatio: 0, cancelRemainder: true } },
      ],
      prevFrameHash: '',
      deltas: [],
      stateHash: '',
      byLeft: true,
    };

    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'alice',
      orderId: 'alice:offer-cancel-pending',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', aliceAccount]]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2'],
        },
        books: new Map([['1/2', book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookCancels(entityState, [{ accountId: 'alice', offerId: 'offer-cancel-pending' }]);
    expect(result.accountTxs).toHaveLength(0);
  });

  test('fails fast on malformed persisted book order ids', () => {
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });

    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker',
      orderId: 'malformed',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;

    const lot = SWAP_LOT_SCALE;
    const takerOffer = {
      offerId: 'taker-buy-malformed',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: (lot * 10_000n) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 10_000n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['taker-account', { swapOffers: new Map() }],
        ['maker-account', { swapOffers: new Map() }],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 2,
          supportedPairs: ['2/5'],
        },
        books: new Map([['2/5', book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerOffer] as any)).toThrow(
      /ORDERBOOK_MALFORMED_BOOK_ORDER/,
    );
  });

  test('processOrderbookCancels fails fast on duplicate order ids across pair books', () => {
    const lot = SWAP_LOT_SCALE;
    const offer = {
      offerId: 'dup',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (1000n * lot) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    let bookA = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    let bookB = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });

    for (const bookRef of [bookA, bookB]) {
      const updated = applyCommand(bookRef, {
        kind: 0,
        ownerId: 'alice',
        orderId: 'alice:dup',
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1000n,
        qtyLots: 1n,
      }).state;
      if (bookRef === bookA) bookA = updated;
      else bookB = updated;
    }

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', makeAccountMachine(offer as any)]]),
      orderbookExt: {
        hubProfile: {
          entityId: 'hub-entity',
          name: 'Hub',
          minTradeSize: 0n,
          spreadDistribution: {
            makerBps: 0,
            takerBps: 10_000,
            hubBps: 0,
            makerReferrerBps: 0,
            takerReferrerBps: 0,
          },
          referenceTokenId: 1,
          supportedPairs: ['1/2', '3/4'],
        },
        books: new Map([
          ['1/2', bookA],
          ['3/4', bookB],
        ]),
        pairConfig: new Map(),
      } as any,
    } as any;

    expect(() => processOrderbookCancels(entityState, [{ accountId: 'alice', offerId: 'dup' }])).toThrow(
      /ORDERBOOK_DUPLICATE_BOOK_ORDER/,
    );
  });
});
