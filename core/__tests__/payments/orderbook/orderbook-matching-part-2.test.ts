import { describe, expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import { createBook, applyCommand, getBestAsk, getBestBid, getBookOrder, getBookSideLevels } from '../../../orderbook/core';
import { commitBookOverlay, setBookPageTree } from '../../../orderbook/book-overlay';

import { getStaticSwapTokenDimensions, getSwapExactQuoteLotMultipleAtPriceForDimensions, getSwapLotScale, ORDERBOOK_PRICE_SCALE, quoteAmountAtPrice, SWAP_LOT_SCALE } from '../../../orderbook/types';

import { removeCrossJurisdictionBookOrderByRouteId } from '../../../orderbook/cross-j';

import { processOrderbookCancels, processOrderbookSwaps } from '../../../entity/tx/handlers/account/index';

import { buildCrossMarketOfferFromBookOrder } from '../../../entity/tx/handlers/account/orderbook/helpers';


import { handleSwapResolve } from '../../../account/tx/handlers/swap/resolve/index';

import { createEmptyEnv } from '../../../runtime';
import { publishEntityCandidateEffects } from '../../../runtime/observability/env-events';


import {
  deriveCanonicalSwapFillRatio,
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
} from '../../../orderbook/swap-execution';

import type { AccountReplica, AccountTx, SwapOffer } from '../../../types/account';
import type { EntityCandidateEffect } from '../../../entity/types';

import { createDefaultDelta } from '../../../account/state/delta';

const TESTNET_STACK = `stack:31337:0x${'11'.repeat(20)}`;

const TRON_STACK = `stack:31338:0x${'22'.repeat(20)}`;

const CROSS_WETH_USDC_PAIR = `cross:${TESTNET_STACK}:2/${TRON_STACK}:1`;

const CROSS_USDC_USDC_PAIR = `cross:${TESTNET_STACK}:1/${TRON_STACK}:1`;

const ALICE_ACCOUNT = `0x${'a1'.repeat(32)}`;
const CROSSED_ACCOUNT = `0x${'a2'.repeat(32)}`;
const FIXTURE_PEER = `0x${'a3'.repeat(32)}`;
const LOCAL_TAKER_ACCOUNT = `0x${'a4'.repeat(32)}`;
const MAKER_ACCOUNT = `0x${'a5'.repeat(32)}`;
const MAKER_COMMITTED_ACCOUNT = `0x${'a6'.repeat(32)}`;
const MAKER_PENDING_ACCOUNT = `0x${'a7'.repeat(32)}`;
const REMOTE_MAKER_ACCOUNT = `0x${'a8'.repeat(32)}`;
const TAKER_ACCOUNT = `0x${'a9'.repeat(32)}`;
const TAKER_ONE_ACCOUNT = `0x${'aa'.repeat(32)}`;
const TAKER_TWO_ACCOUNT = `0x${'ab'.repeat(32)}`;
const HUB_ENTITY = `0x${'ac'.repeat(32)}`;
const MAKER_ENTITY = `0x${'ad'.repeat(32)}`;
const TAKER_ENTITY = `0x${'ae'.repeat(32)}`;
const CROSSED_ENTITY = `0x${'af'.repeat(32)}`;
const orderKey = (entityId: string, offerId: string): string => `${entityId}:${offerId}`;
const exactWethBaseAmount = (priceTicks: bigint, minimumLots: bigint): bigint => {
  const multiple = getSwapExactQuoteLotMultipleAtPriceForDimensions(18, 6, priceTicks);
  return ((minimumLots + multiple - 1n) / multiple) * multiple * SWAP_LOT_SCALE;
};

const withStaticDimensions = <T extends { giveTokenId: number; wantTokenId: number }>(offer: T) => ({
  ...getStaticSwapTokenDimensions(offer.giveTokenId, offer.wantTokenId),
  ...offer,
});

const processCommittedOrderbookSwaps = (
  state: Parameters<typeof processOrderbookSwaps>[0],
  offers: NormalizedOrderbookOffer[],
  options?: Parameters<typeof processOrderbookSwaps>[2],
) => processOrderbookSwaps(state, offers.map(withStaticDimensions).map(markWorkingOrderbookOffer), options);

function makeAccountMachine(input: SwapOffer | readonly SwapOffer[]): AccountReplica {
  const offers = (Array.isArray(input) ? input : [input]).map(withStaticDimensions).map(offer =>
    offer.crossJurisdiction
      ? {
          ...offer,
          crossJurisdiction: {
            ...offer.crossJurisdiction,
            sourceDisputeConfig: offer.crossJurisdiction.sourceDisputeConfig ?? { leftResponseSeconds: 10, rightResponseSeconds: 10 },
            targetDisputeConfig: offer.crossJurisdiction.targetDisputeConfig ?? { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          },
        }
      : offer,
  );
  const firstOffer = offers[0];
  const deltas = new Map<number, ReturnType<typeof createDefaultDelta>>();
  for (const offer of offers) {
    for (const tokenId of [offer.giveTokenId, offer.wantTokenId]) {
      if (deltas.has(tokenId)) continue;
      const delta = createDefaultDelta(tokenId);
      delta.leftCreditLimit = 10n ** 30n;
      delta.rightCreditLimit = 10n ** 30n;
      deltas.set(tokenId, delta);
    }
    const giveDelta = deltas.get(offer.giveTokenId)!;
    const heldGiveAmount = offer.quantizedGive ?? offer.giveAmount;
    if (offer.makerIsLeft) giveDelta.leftHold += heldGiveAmount;
    else giveDelta.rightHold += heldGiveAmount;
  }

  const account: AccountReplica = {
    state: {
      leftEntity: firstOffer?.fromEntity ?? HUB_ENTITY,
      rightEntity: firstOffer?.toEntity ?? FIXTURE_PEER,
      domain: {
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
      },
      watchSeed: `0x${'11'.repeat(32)}`,
      deltas,
      locks: new Map(),
      swapOffers: new Map(offers.map((offer) => [offer.offerId, offer])),
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
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: {
      fromEntity: firstOffer?.fromEntity ?? HUB_ENTITY,
      toEntity: firstOffer?.toEntity ?? FIXTURE_PEER,
      nextProofNonce: 0,
    },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
  return account;
}

/** See part 1: projection-only fixtures still use the canonical AccountReplica shape. */
function makeAccountIndex(offerIds: readonly string[]): AccountReplica {
  return makeAccountMachine(
    offerIds.map((offerId) => ({
      offerId,
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: FIXTURE_PEER,
      accountId: FIXTURE_PEER,
      createdHeight: 0,
      giveTokenId: 1,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 2,
      wantAmount: SWAP_LOT_SCALE,
      timeInForce: 0,
      priceTicks: ORDERBOOK_PRICE_SCALE,
    })),
  );
}

describe('orderbook matching execution mapping', () => {
  test('validates a remote cross-j book order from admitted route without refreshing it', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const filledSourceAmount = 10_000n * lot;
    const filledTargetAmount = quoteAmountAtPrice(2, 1, filledSourceAmount, 25_000_000n);
    const remainingSource = sourceTotal - filledSourceAmount;
    const pairId = CROSS_WETH_USDC_PAIR;
    const namespacedOrderId = orderKey(MAKER_ENTITY, 'maker-cross-partial');
    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 30_000n,
    }).state;

    const route = {
      orderId: 'maker-cross-partial',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: MAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: sourceTotal,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: targetTotal,
      },
      fillSeq: 1,
      cumulativeFillRatio: 16_384,
      claimedRatio: 16_384,
      fillNumerator: 1n,
      fillDenominator: 4n,
      filledSourceAmount,
      filledTargetAmount,
      sourceClaimed: filledSourceAmount,
      targetClaimed: filledTargetAmount,
      status: 'partially_filled',
      createdAt: 1,
      updatedAt: 2,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map(),
      crossJurisdictionBookAdmissions: new Map([
        [
          orderKey(MAKER_ENTITY, 'maker-cross-partial'),
          {
            orderId: 'maker-cross-partial',
            routeHash: 'hash',
            sourceEntityId: MAKER_ENTITY,
            bookOwnerEntityId: HUB_ENTITY,
            status: 'admitted',
            route,
            updatedAt: 2,
          },
        ],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map([[namespacedOrderId, [pairId]]]),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [] as any);

    expect(result.bookUpdates).toEqual([]);
    expect(getBookOrder(staleBook, namespacedOrderId)?.qtyLots).toBe(30_000n);
  });

  test('debug cross-j rebuild does not persist a resting projection', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_USDC_USDC_PAIR;
    const route = {
      orderId: 'debug-cross',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: MAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
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
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
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
      entityId: HUB_ENTITY,
      accounts: new Map([[MAKER_ACCOUNT, makeAccountMachine([offer])]]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
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
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
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
      fromEntity: HUB_ENTITY,
      toEntity: CROSSED_ENTITY,
      accountId: CROSSED_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: (lot * 25_000_100n) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: 25_000_100n,
    };
    const takerAmount = exactWethBaseAmount(24_999_900n, 1n);
    const takerBid = {
      offerId: 'taker-bid',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 3,
      giveTokenId: 1,
      giveAmount: (takerAmount * 24_999_900n) / 10_000n,
      wantTokenId: 2,
      wantAmount: takerAmount,
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
      ownerId: MAKER_ENTITY,
      orderId: MAKER_ACCOUNT + ':maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 24_999_500n,
      qtyLots: 1n,
    }).state;

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([makerAsk])],
        [CROSSED_ACCOUNT, makeAccountMachine([crossedBid])],
        [TAKER_ACCOUNT, makeAccountMachine([])],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
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
      orderId: MAKER_ACCOUNT + ':maker-ask-a',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 24_999_998n,
      qtyLots: 1n,
    }).state;
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-b',
      orderId: MAKER_ACCOUNT + ':maker-ask-b',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: secondAskPriceTicks,
      qtyLots: 1n,
    }).state;

    const makeAskOffer = (offerId: string, makerEntity: string, priceTicks: bigint) => ({
      offerId,
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: makerEntity,
      accountId: MAKER_ACCOUNT,
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
    const takerAmount = exactWethBaseAmount(bidPriceTicks, 1n);
    const takerOffer = {
      offerId: 'taker-bid',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: (takerAmount * bidPriceTicks) / 10_000n,
      wantTokenId: 2,
      wantAmount: takerAmount,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [
          MAKER_ACCOUNT,
          makeAccountMachine([makerOfferA, makerOfferB]),
        ],
        [TAKER_ACCOUNT, makeAccountMachine([])],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
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
      ownerId: MAKER_ENTITY,
      orderId: MAKER_ACCOUNT + ':maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: askPriceTicks,
      qtyLots: 1n,
    }).state;

    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
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
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: (lot * bidPriceTicks) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [
          MAKER_ACCOUNT,
          {
            ...makeAccountMachine([makerOffer]),
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
        [TAKER_ACCOUNT, makeAccountMachine([])],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer] as any);

    expect(result.accountTxs).toEqual([]);
    expect(getBookOrder(staleBook, MAKER_ACCOUNT + ':maker-ask')).not.toBeNull();
  });

  test('accepts wide-range resting orders without mutating the existing anchor order price', () => {
    const anchorPriceTicks = 25_015_002n;
    const overflowPriceTicks = 25_262_625n;
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE_ACCOUNT, makeAccountMachine([])]]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const anchorAmount = exactWethBaseAmount(anchorPriceTicks, 210n);
    const anchorOffer = {
      offerId: 'offer-a',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE_ACCOUNT,
      accountId: ALICE_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: anchorAmount,
      wantTokenId: 1,
      wantAmount: (anchorAmount * anchorPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: anchorPriceTicks,
    };

    entityState.accounts.set(ALICE_ACCOUNT, makeAccountMachine([anchorOffer]));
    const firstPass = processCommittedOrderbookSwaps(entityState, [anchorOffer] as any);
    const initialBook = firstPass.bookUpdates.at(-1)?.book;
    expect(initialBook).toBeDefined();
    expect(getBookOrder(initialBook!, ALICE_ACCOUNT + ':offer-a')).not.toBeNull();

    entityState.orderbookExt.books = new Map([['1/2', initialBook]]);

    const overflowAmount = exactWethBaseAmount(overflowPriceTicks, 960n);
    const overflowOffer = {
      offerId: 'offer-b',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE_ACCOUNT,
      accountId: ALICE_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 2,
      giveAmount: overflowAmount,
      wantTokenId: 1,
      wantAmount: (overflowAmount * overflowPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: overflowPriceTicks,
    };

    const overflowPass = processCommittedOrderbookSwaps(entityState, [overflowOffer] as any);
    const finalBook = overflowPass.bookUpdates.at(-1)?.book ?? entityState.orderbookExt.books.get('1/2');
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, ALICE_ACCOUNT + ':offer-a')?.priceTicks).toBe(anchorPriceTicks);
    expect(getBookOrder(finalBook!, ALICE_ACCOUNT + ':offer-b')?.priceTicks).toBe(overflowPriceTicks);
  });

  test('queues cancelRemainder instead of throwing when a pair book reaches its order cap', () => {
    const maxOrders = 3;
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE_ACCOUNT, makeAccountMachine([])]]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const rejectedOfferId = `offer-${String(maxOrders + 1).padStart(2, '0')}`;
    const offers = Array.from({ length: maxOrders + 1 }, (_, index) => ({
      offerId: `offer-${String(index + 1).padStart(2, '0')}`,
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE_ACCOUNT,
      accountId: ALICE_ACCOUNT,
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
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
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
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
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
      ownerId: MAKER_ENTITY,
      orderId: MAKER_ACCOUNT + ':maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;
    const pageKey = { priceTicks: 10_000n, pageSequence: 0 };
    const page = corruptedBook.askPages.get(pageKey);
    expect(page).toBeDefined();
    if (!page || !page.slots[0]) throw new Error('expected canonical ask page');
    const slots = [...page.slots];
    slots[0] = { ...page.slots[0], orderId: 'corrupt-page-order' };
    setBookPageTree(corruptedBook, 1, corruptedBook.askPages.updated(pageKey, { ...page, slots }));

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [
          MAKER_ACCOUNT,
          makeAccountMachine([makerOffer]),
        ],
        [TAKER_ACCOUNT, makeAccountMachine([])],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerOffer] as any)).toThrow(
      /ORDERBOOK_PAIR_COMMAND_FAILED/,
    );
  });

  test('processOrderbookCancels merges two same-frame cancels into one pair overlay', () => {
    const lot = SWAP_LOT_SCALE;
    const offer = {
      offerId: 'offer-cancel',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE_ACCOUNT,
      accountId: ALICE_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (1000n * lot) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    };
    const secondOffer = { ...offer, offerId: 'offer-cancel-2', priceTicks: 2000n };

    const aliceAccount = makeAccountMachine([offer as any, secondOffer as any]);
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: ALICE_ACCOUNT,
      orderId: ALICE_ACCOUNT + ':offer-cancel',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state);
    book = commitBookOverlay(applyCommand(book, {
      kind: 0,
      ownerId: ALICE_ACCOUNT,
      orderId: ALICE_ACCOUNT + ':offer-cancel-2',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2000n,
      qtyLots: 1n,
    }).state);

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE_ACCOUNT, aliceAccount]]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map([
          [ALICE_ACCOUNT + ':offer-cancel', ['1/2']],
          [ALICE_ACCOUNT + ':offer-cancel-2', ['1/2']],
        ]),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processOrderbookCancels(entityState, [
      { accountId: ALICE_ACCOUNT, offerId: 'offer-cancel' },
      { accountId: ALICE_ACCOUNT, offerId: 'offer-cancel-2' },
    ]);
    expect(result.accountTxs).toHaveLength(2);
    expect(result.accountTxs[0]!.accountId).toBe(ALICE_ACCOUNT);
    expect(result.accountTxs[0]!.tx.type).toBe('swap_resolve');
    expect(result.accountTxs[0]!.tx.data.offerId).toBe('offer-cancel');
    expect(result.accountTxs[0]!.tx.data.cancelRemainder).toBe(true);
    expect(result.bookUpdates).toHaveLength(1);
    expect(getBookOrder(result.bookUpdates[0]!.book, ALICE_ACCOUNT + ':offer-cancel')).toBeNull();
    expect(getBookOrder(result.bookUpdates[0]!.book, ALICE_ACCOUNT + ':offer-cancel-2')).toBeNull();
  });

  test('processOrderbookCancels does not duplicate account-level cancel already pending in frame', () => {
    const lot = SWAP_LOT_SCALE;
    const offer = {
      offerId: 'offer-cancel-pending',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE_ACCOUNT,
      accountId: ALICE_ACCOUNT,
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
      ownerId: ALICE_ACCOUNT,
      orderId: ALICE_ACCOUNT + ':offer-cancel-pending',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE_ACCOUNT, aliceAccount]]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processOrderbookCancels(entityState, [{ accountId: ALICE_ACCOUNT, offerId: 'offer-cancel-pending' }]);
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
      fromEntity: HUB_ENTITY,
      toEntity: 'taker',
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (lot * 10_000n) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 10_000n,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [TAKER_ACCOUNT, makeAccountMachine([])],
        [MAKER_ACCOUNT, makeAccountMachine([])],
      ]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
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
      fromEntity: HUB_ENTITY,
      toEntity: ALICE_ACCOUNT,
      accountId: ALICE_ACCOUNT,
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
        ownerId: ALICE_ACCOUNT,
        orderId: ALICE_ACCOUNT + ':dup',
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
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE_ACCOUNT, makeAccountMachine(offer as any)]]),
      orderbookExt: {
        hubProfile: {
          entityId: HUB_ENTITY,
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
        orderPairs: new Map([[ALICE_ACCOUNT + ':dup', ['1/2', '3/4']]]),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    expect(() => processOrderbookCancels(entityState, [{ accountId: ALICE_ACCOUNT, offerId: 'dup' }])).toThrow(
      /ORDERBOOK_DUPLICATE_BOOK_ORDER/,
    );
  });
});
