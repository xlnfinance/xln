import { describe, expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import { createBook, applyCommand, getBestAsk, getBestBid, getBookOrder, getBookSideLevels, resumeCrossedBook } from '../../../orderbook/core';

import { getStaticSwapTokenDimensions, getSwapExactQuoteLotMultipleAtPriceForDimensions, getSwapLotScale, getSwapPairDimensions, ORDERBOOK_PRICE_SCALE, quoteAmountAtPrice, SWAP_LOT_SCALE } from '../../../orderbook/types';

import { removeCrossJurisdictionBookOrderByRouteId } from '../../../orderbook/cross-j';

import { processOrderbookCancels, processOrderbookSwaps } from '../../../entity/tx/handlers/account/index';

import { applyCrossJurisdictionBookProgressToState } from '../../../entity/tx/handlers/cross-j/book-order';

import { handleSwapResolve } from '../../../account/tx/handlers/swap/resolve/index';

import { createEmptyEnv } from '../../../runtime';

import { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../../extensions/cross-j/fill-ack';

import {
  deriveCanonicalSwapFillRatio,
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
} from '../../../orderbook/swap-execution';

import type { AccountReplica, AccountTx, SwapOffer } from '../../../types/account';

import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  accountTransitionView,
  beginAccountTransition,
  discardAccountTransition,
  publishAccountTransition,
} from '../../../account/state/candidate-overlay';
import {
  accountTxFailureMessage,
} from '../../../account/tx/apply-result';
import type { EntityState } from '../../../entity/types';
import { initCrontab } from '../../../entity/scheduler';

const TESTNET_STACK = `stack:31337:0x${'11'.repeat(20)}`;

const TRON_STACK = `stack:31338:0x${'22'.repeat(20)}`;

const CROSS_WETH_USDC_PAIR = `cross:${TESTNET_STACK}:2/${TRON_STACK}:1`;

const CROSS_USDC_USDC_PAIR = `cross:${TESTNET_STACK}:1/${TRON_STACK}:1`;

const fixtureEntityId = (byte: string): string => `0x${byte.repeat(32)}`;
const HUB_ENTITY = fixtureEntityId('01');
const ALICE = fixtureEntityId('02');
const MAKER_ACCOUNT = fixtureEntityId('03');
const MAKER_ACCOUNT_ONE = fixtureEntityId('04');
const MAKER_ACCOUNT_TWO = fixtureEntityId('05');
const ALICE_MAKER_ACCOUNT = fixtureEntityId('06');
const ALICE_TAKER_ACCOUNT = fixtureEntityId('07');
const ASK_MAKER_ACCOUNT = fixtureEntityId('08');
const BID_MAKER_ACCOUNT = fixtureEntityId('09');
const BOB_MAKER_ACCOUNT = fixtureEntityId('0a');
const FAR_MAKER_ACCOUNT = fixtureEntityId('0b');
const NEAR_MAKER_ACCOUNT = fixtureEntityId('0c');
const NEW_TAKER_ACCOUNT = fixtureEntityId('0d');
const TAKER_ACCOUNT = fixtureEntityId('0e');
const MAKER_ENTITY = fixtureEntityId('0f');
const TAKER_ENTITY = fixtureEntityId('10');
const FIXTURE_PEER = fixtureEntityId('11');
const MAKER_ONE = fixtureEntityId('12');
const MAKER_TWO = fixtureEntityId('13');
const BOB = fixtureEntityId('14');
const orderKey = (entityId: string, offerId: string): string => `${entityId}:${offerId}`;
const exactWethBaseAmount = (priceTicks: bigint, minimumLots: bigint): bigint => {
  const multiple = getSwapExactQuoteLotMultipleAtPriceForDimensions(18, 6, priceTicks);
  return ((minimumLots + multiple - 1n) / multiple) * multiple * SWAP_LOT_SCALE;
};

const withZeroFeeTestAuthorization = <T extends { wantAmount: bigint }>(offer: T): T & {
  maxFee: bigint;
  minNetReceive: bigint;
} => ({
  maxFee: 0n,
  minNetReceive: offer.wantAmount,
  ...getStaticSwapTokenDimensions(
    Number(Reflect.get(offer, 'giveTokenId')),
    Number(Reflect.get(offer, 'wantTokenId')),
  ),
  ...offer,
});

const processCommittedOrderbookSwaps = (
  state: Parameters<typeof processOrderbookSwaps>[0],
  offers: NormalizedOrderbookOffer[],
  options?: Parameters<typeof processOrderbookSwaps>[2],
) => processOrderbookSwaps(
  state,
  offers.map(offer => markWorkingOrderbookOffer(withZeroFeeTestAuthorization(offer))),
  options,
);

function makeAccountMachine(input: SwapOffer | readonly SwapOffer[]): AccountReplica {
  const offers = (Array.isArray(input) ? input : [input]).map(withZeroFeeTestAuthorization).map(offer =>
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
      deltas: PersistentAccountStateMap.fromEntries('deltas', deltas),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.fromEntries(
        'swapOffers',
        offers.map((offer) => [offer.offerId, offer] as const),
      ),
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
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
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
  return account;
}

/** Exercise swap settlement through the same explicit Account overlay as production. */
const applyFixtureSwapResolve = async (
  account: AccountReplica,
  tx: Extract<AccountTx, { type: 'swap_resolve' }>,
  byLeft: boolean,
) => {
  const owner = beginAccountTransition(account);
  try {
    const result = await handleSwapResolve(accountTransitionView(owner), tx, byLeft, 1);
    if (!result.ok) {
      discardAccountTransition(owner);
      return result;
    }
    publishAccountTransition(account, owner);
    return result;
  } catch (error) {
    if (owner.lifecycle.status === 'active') discardAccountTransition(owner);
    throw error;
  }
};

/**
 * Builds a real Account replica when a projection test only needs admitted offer IDs.
 * Keeping the fixture structurally valid prevents projection tests from teaching readers
 * the old, impossible shape where EntityState.accounts contained partial AccountState data.
 */
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
  test('fails fast when matcher receives a raw unadmitted offer', () => {
    const rawOffer = {
      offerId: 'raw-offer',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 1,
      wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    };
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE, makeAccountMachine([])]]),
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

    expect(() => processOrderbookSwaps(entityState, [rawOffer] as any)).toThrow(/ORDERBOOK_UNADMITTED_OFFER/);
    expect(() =>
      processOrderbookSwaps(entityState, [{ ...rawOffer, orderbookKind: 'same-jurisdiction' }] as any),
    ).toThrow(/ORDERBOOK_UNADMITTED_OFFER/);
  });

  test('generates execution amounts from a persisted book backed by account offers', () => {
    let book = createBook({
      bucketWidthTicks: 100n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });

    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_ONE,
      orderId: orderKey(MAKER_ONE, 'maker-ask-1'),
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_TWO,
      orderId: orderKey(MAKER_TWO, 'maker-ask-2'),
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1100n,
      qtyLots: 1n,
    }).state;

    const lot = SWAP_LOT_SCALE;
    const baseQty = 2n * lot;
    const quoteAmount = (1100n * baseQty) / 10_000n;

    const swapOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE,
      giveTokenId: 5,
      giveAmount: quoteAmount,
      wantTokenId: 2,
      wantAmount: baseQty,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1100n,
    };
    const makerOffer1 = {
      offerId: 'maker-ask-1',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ONE,
      accountId: MAKER_ONE,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (1000n * lot) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1000n,
    };
    const makerOffer2 = {
      offerId: 'maker-ask-2',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_TWO,
      accountId: MAKER_TWO,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (1100n * lot) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1100n,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ONE, makeAccountMachine([makerOffer1])],
        [MAKER_TWO, makeAccountMachine([makerOffer2])],
        [ALICE, makeAccountMachine([])],
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

    const result = processCommittedOrderbookSwaps(entityState, [swapOffer]);
    const op = result.accountTxs.find(item => item.accountId === ALICE && item.tx.type === 'swap_resolve');

    expect(op).toBeDefined();
    expect(op!.tx.data.fillRatio).toBe(deriveCanonicalSwapFillRatio(quoteAmount, 210_000_000_000n));
    expect(op!.tx.data.executionGiveAmount).toBe(210_000_000_000n);
    expect(op!.tx.data.executionWantAmount).toBe(baseQty);
  });

  test('uses maker execution terms instead of reusing the taker offer', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBaseQty = lot;
    const makerPriceTicks = 1000n;
    const makerQuoteQty = (makerBaseQty * makerPriceTicks) / 10_000n;
    const takerPriceTicks = 1001n;
    const takerQuoteQty = (makerBaseQty * takerPriceTicks) / 10_000n;

    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: makerBaseQty,
      wantTokenId: 5,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const takerOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: makerBaseQty,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([makerOffer])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const makerResolve = result.accountTxs.find(
      item => item.accountId === MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const takerResolve = result.accountTxs.find(
      item => item.accountId === TAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );

    expect(makerResolve).toBeDefined();
    expect(takerResolve).toBeDefined();

    expect(makerResolve!.tx.data.fillRatio).toBe(65535);
    expect(makerResolve!.tx.data.executionGiveAmount).toBe(makerBaseQty);
    expect(makerResolve!.tx.data.executionWantAmount).toBe(makerQuoteQty);

    expect(takerResolve!.tx.data.fillRatio).toBe(deriveCanonicalSwapFillRatio(takerQuoteQty, makerQuoteQty));
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(makerQuoteQty);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(makerBaseQty);
  });

  test('allows within-band buy prices to match available asks and rest the remainder', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBaseQty = lot;
    const makerPriceTicks = 1000n;
    const makerQuoteQty = (makerBaseQty * makerPriceTicks) / 10_000n;

    const takerBaseQty = 2n * lot;
    const takerPriceTicks = 1250n;
    const takerQuoteQty = (takerBaseQty * takerPriceTicks) / 10_000n;

    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: makerBaseQty,
      wantTokenId: 5,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const takerOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: takerBaseQty,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const makerResolve = result.accountTxs.find(
      item => item.accountId === MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const takerResolve = result.accountTxs.find(
      item => item.accountId === TAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;

    expect(makerResolve).toBeDefined();
    expect(takerResolve).toBeDefined();
    expect(finalBook).toBeDefined();

    expect(makerResolve!.tx.data.fillRatio).toBe(65535);
    expect(makerResolve!.tx.data.executionGiveAmount).toBe(makerBaseQty);
    expect(makerResolve!.tx.data.executionWantAmount).toBe(makerQuoteQty);

    expect(takerResolve!.tx.data.cancelRemainder).toBe(false);
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(makerQuoteQty);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(makerBaseQty);

    expect(getBookOrder(finalBook!, orderKey(TAKER_ACCOUNT, 'taker-buy'))).not.toBeNull();
  });

  test('allows a taker to sweep multiple resting price levels without requiring integral VWAP', () => {
    const lot = SWAP_LOT_SCALE;

    const makerAsk1 = {
      offerId: 'maker-ask-1',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'maker-1',
      accountId: MAKER_ACCOUNT_ONE,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 5,
      wantAmount: (2n * lot * 10_000n) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 10_000n,
    };

    const makerAsk2 = {
      offerId: 'maker-ask-2',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'maker-2',
      accountId: MAKER_ACCOUNT_TWO,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (lot * 10_100n) / 10_000n,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: 10_100n,
    };

    const takerBuy = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (3n * lot * 10_100n) / 10_000n,
      wantTokenId: 2,
      wantAmount: 3n * lot,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 10_100n,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT_ONE, makeAccountMachine([])],
        [MAKER_ACCOUNT_TWO, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerAsk1, makerAsk2, takerBuy] as any);
    const takerResolve = result.accountTxs.find(
      item => item.accountId === TAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const makerResolve1 = result.accountTxs.find(
      item => item.accountId === MAKER_ACCOUNT_ONE && item.tx.type === 'swap_resolve',
    );
    const makerResolve2 = result.accountTxs.find(
      item => item.accountId === MAKER_ACCOUNT_TWO && item.tx.type === 'swap_resolve',
    );

    const executionQuoteWei = (30_100n * lot) / 10_000n;

    expect(takerResolve).toBeDefined();
    expect(makerResolve1).toBeDefined();
    expect(makerResolve2).toBeDefined();
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(executionQuoteWei);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(3n * lot);
    expect(takerResolve!.tx.data.fillRatio).toBe(deriveCanonicalSwapFillRatio(takerBuy.giveAmount, executionQuoteWei));
  });

  test('preserves partial fills and tags STP when taker later hits own resting order', () => {
    const lot = SWAP_LOT_SCALE;
    const otherAskBaseQty = lot;
    const otherAskPriceTicks = 1000n;
    const otherAskQuoteQty = (otherAskBaseQty * otherAskPriceTicks) / 10_000n;

    const selfAskBaseQty = lot;
    const selfAskPriceTicks = 1050n;
    const selfAskQuoteQty = (selfAskBaseQty * selfAskPriceTicks) / 10_000n;

    const takerBaseQty = 2n * lot;
    const takerPriceTicks = 1100n;
    const takerQuoteQty = (takerBaseQty * takerPriceTicks) / 10_000n;

    const selfMakerOffer = {
      offerId: 'self-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE_MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: selfAskBaseQty,
      wantTokenId: 5,
      wantAmount: selfAskQuoteQty,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: selfAskPriceTicks,
    };

    const otherAskOffer = {
      offerId: 'other-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: BOB,
      accountId: BOB_MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: otherAskBaseQty,
      wantTokenId: 5,
      wantAmount: otherAskQuoteQty,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: otherAskPriceTicks,
    };

    const takerBuyOffer = {
      offerId: 'alice-buy',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE_TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: takerBaseQty,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [ALICE_MAKER_ACCOUNT, makeAccountMachine([])],
        [BOB_MAKER_ACCOUNT, makeAccountMachine([])],
        [ALICE_TAKER_ACCOUNT, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [selfMakerOffer, otherAskOffer, takerBuyOffer]);
    const takerResolve = result.accountTxs.find(
      item => item.accountId === ALICE_TAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const otherMakerResolve = result.accountTxs.find(
      item => item.accountId === BOB_MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const selfMakerResolve = result.accountTxs.find(
      item => item.accountId === ALICE_MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );

    expect(takerResolve).toBeDefined();
    expect(otherMakerResolve).toBeDefined();
    expect(selfMakerResolve).toBeUndefined();

    expect(takerResolve!.tx.data.cancelRemainder).toBe(true);
    expect(takerResolve!.tx.data.comment).toBe(`STP:${ALICE_MAKER_ACCOUNT}:self-ask`);
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(otherAskQuoteQty);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(otherAskBaseQty);
  });

  test('preserves exact resting bid price when a lower-priced buy order expands the current book window', () => {
    const lot = SWAP_LOT_SCALE;
    const makerAskPriceTicks = 26_000_000n;
    const makerBidPriceTicks = 24_000_000n;
    const makerAsk = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'ask-maker',
      accountId: ASK_MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: 3n * lot,
      wantTokenId: 5,
      wantAmount: (3n * lot * makerAskPriceTicks) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: makerAskPriceTicks,
    };

    const restingBid = {
      offerId: 'resting-bid',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'bid-maker',
      accountId: BID_MAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (2n * lot * makerBidPriceTicks) / 10_000n,
      wantTokenId: 2,
      wantAmount: 2n * lot,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: makerBidPriceTicks,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [ASK_MAKER_ACCOUNT, makeAccountMachine([])],
        [BID_MAKER_ACCOUNT, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerAsk, restingBid]);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();

    expect(getBookOrder(finalBook!, orderKey(BID_MAKER_ACCOUNT, 'resting-bid'))?.priceTicks).toBe(makerBidPriceTicks);
  });

  test('uses midpoint band when both sides of the book exist for buys', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBid = {
      offerId: 'maker-bid',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'bid-maker',
      accountId: BID_MAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (1000n * lot) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const makerAsk = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'ask-maker',
      accountId: ASK_MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (1200n * lot) / 10_000n,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: 1200n,
    };

    const takerBuy = {
      offerId: 'taker-buy-between-sides',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'taker',
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (1400n * 2n * lot) / 10_000n,
      wantTokenId: 2,
      wantAmount: 2n * lot,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 1400n,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [BID_MAKER_ACCOUNT, makeAccountMachine([])],
        [ASK_MAKER_ACCOUNT, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerBid, makerAsk, takerBuy]);
    const takerResolve = result.accountTxs.find(
      item =>
        item.accountId === TAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-buy-between-sides',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(false);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, orderKey(TAKER_ACCOUNT, 'taker-buy-between-sides'))).not.toBeNull();
  });

  test('uses midpoint band when both sides of the book exist for sells', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBid = {
      offerId: 'maker-bid',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'bid-maker',
      accountId: BID_MAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (1000n * lot) / 10_000n,
      wantTokenId: 2,
      wantAmount: lot,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const makerAsk = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'ask-maker',
      accountId: ASK_MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (1200n * lot) / 10_000n,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: 1200n,
    };

    const takerSell = {
      offerId: 'taker-sell-between-sides',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'taker',
      accountId: TAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 5,
      wantAmount: (800n * 2n * lot) / 10_000n,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 800n,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [BID_MAKER_ACCOUNT, makeAccountMachine([])],
        [ASK_MAKER_ACCOUNT, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerBid, makerAsk, takerSell]);
    const takerResolve = result.accountTxs.find(
      item =>
        item.accountId === TAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-sell-between-sides',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(false);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, orderKey(TAKER_ACCOUNT, 'taker-sell-between-sides'))).not.toBeNull();
  });

  test('matches persisted book orders after snapshot restore without rebuilding the book', () => {
    const lot = SWAP_LOT_SCALE;
    let historicalBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });

    historicalBook = applyCommand(historicalBook, {
      kind: 0,
      ownerId: MAKER_ACCOUNT,
      orderId: orderKey(MAKER_ACCOUNT, 'maker-ask-historical'),
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;

    const takerOffer = {
      offerId: 'taker-buy-restored-book',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ACCOUNT,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (1250n * 2n * lot) / 10_000n,
      wantTokenId: 2,
      wantAmount: 2n * lot,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 1250n,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [
          MAKER_ACCOUNT,
          {
            ...makeAccountMachine([]),
            state: {
              ...makeAccountMachine([]).state,
              leftEntity: HUB_ENTITY,
              rightEntity: MAKER_ACCOUNT,
              swapOffers: new Map([
                [
                  'maker-ask-historical',
                  {
                    offerId: 'maker-ask-historical',
                    ...getStaticSwapTokenDimensions(2, 5),
                    giveTokenId: 2,
                    giveAmount: lot,
                    wantTokenId: 5,
                    wantAmount: (1000n * lot) / 10_000n,
                    maxFee: 0n,
                    minNetReceive: (1000n * lot) / 10_000n,
                    makerIsLeft: false,
                    createdHeight: 1,
                    priceTicks: 1000n,
                    quantizedGive: lot,
                    quantizedWant: (1000n * lot) / 10_000n,
                  },
                ],
              ]),
            },
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
          referenceTokenId: 2,
          supportedPairs: ['2/5'],
        },
        books: new Map([['2/5', historicalBook]]),
        orderPairs: new Map([[orderKey(MAKER_ACCOUNT, 'maker-ask-historical'), ['2/5']]]),
        pairDimensions: new Map([[
          '2/5',
          getSwapPairDimensions(1, getStaticSwapTokenDimensions(2, 5)),
        ]]),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer]);
    const makerResolve = result.accountTxs.find(
      item =>
        item.accountId === MAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'maker-ask-historical',
    );

    expect(makerResolve).toBeDefined();
    expect(makerResolve!.tx.data.executionGiveAmount).toBe(lot);
    expect(makerResolve!.tx.data.executionWantAmount).toBe((1000n * lot) / 10_000n);
  });

  test('swap_resolve rejects caller-supplied resting terms that differ from the live offer', async () => {
    const lot = SWAP_LOT_SCALE;
    const makerOffer = {
      offerId: 'maker-snapped',
      makerIsLeft: true,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 5,
      wantAmount: (2006n * lot) / 10_000n,
      createdHeight: 1,
      priceTicks: 1003n,
      quantizedGive: 2n * lot,
      quantizedWant: (2006n * lot) / 10_000n,
    } satisfies SwapOffer;
    const accountMachine = makeAccountMachine({ ...makerOffer });
    const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'maker-snapped',
        fillRatio: 32768,
        cancelRemainder: false,
        executionGiveAmount: lot,
        executionWantAmount: (1000n * lot) / 10_000n,
        restingPriceTicks: 1000n,
        restingGiveAmount: 2n * lot,
        restingWantAmount: (2000n * lot) / 10_000n,
        restingQuantizedGive: 2n * lot,
        restingQuantizedWant: (2000n * lot) / 10_000n,
      },
    };

    const resolveResult = await applyFixtureSwapResolve(accountMachine, accountTx, false);
    expect(resolveResult.ok).toBe(false);
    expect(accountTxFailureMessage(resolveResult)).toContain('Resting swap terms mismatch');
    const remaining = accountMachine.state.swapOffers.get('maker-snapped');
    expect(remaining).toBeDefined();
    expect(remaining!.priceTicks).toBe(1003n);
    expect(remaining!.giveAmount).toBe(2n * lot);
    expect(remaining!.wantAmount).toBe((2006n * lot) / 10_000n);
  });

  test('accepts resting offers with priceTicks above qty-lot limits', () => {
    const lot = SWAP_LOT_SCALE;
    const hugePriceTicks = 5_000_000_000n;
    const hugePriceOffer = {
      offerId: 'maker-huge-price',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (hugePriceTicks * lot) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: hugePriceTicks,
      quantizedGive: lot,
      quantizedWant: (hugePriceTicks * lot) / 10_000n,
    } satisfies SwapOffer;

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE, makeAccountMachine(hugePriceOffer)]]),
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [hugePriceOffer] as any);
    const book = result.bookUpdates.find(item => item.pairId === '2/5')?.book;

    expect(result.accountTxs.some((item: any) => item.tx?.type === 'swap_resolve')).toBe(false);
    expect(book).toBeDefined();
    expect(getBookOrder(book!, orderKey(ALICE, 'maker-huge-price'))?.priceTicks).toBe(hugePriceTicks);
  });

  test('charges 1bp taker fee in the taker received asset without changing gross execution', async () => {
    const lot = SWAP_LOT_SCALE;
    const makerBaseQty = lot;
    const makerPriceTicks = 1000n;
    const makerQuoteQty = (makerBaseQty * makerPriceTicks) / 10_000n;

    const takerOffer = {
      offerId: 'taker-buy-with-fee',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: makerQuoteQty,
      wantTokenId: 2,
      wantAmount: makerBaseQty,
      maxFee: makerBaseQty / 10_000n,
      minNetReceive: makerBaseQty - makerBaseQty / 10_000n,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const makeFeeEntityState = () => ({
      entityId: HUB_ENTITY,
      hubRebalanceConfig: {
        matchingStrategy: 'amount',
        policyVersion: 1,
        routingFeePPM: 1,
        baseFee: 0n,
        swapTakerFeeBps: 1,
        rebalanceLiquidityFeeBps: 1n,
        rebalanceGasFee: 0n,
        rebalanceTimeoutMs: 10 * 60 * 1000,
      },
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([])],
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
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any);

    const makerOffer = {
      offerId: 'maker-ask-fee',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: makerBaseQty,
      wantTokenId: 5,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const unauthorized = processCommittedOrderbookSwaps(makeFeeEntityState(), [makerOffer, {
      ...takerOffer,
      maxFee: 0n,
      minNetReceive: makerBaseQty,
    }]);
    expect(unauthorized.accountTxs.some(
      item => item.accountId === MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    )).toBe(false);
    expect(unauthorized.accountTxs).toContainEqual(expect.objectContaining({
      accountId: TAKER_ACCOUNT,
      tx: expect.objectContaining({
        type: 'swap_resolve',
        data: expect.objectContaining({
          offerId: 'taker-buy-with-fee',
          fillRatio: 0,
          cancelRemainder: true,
          comment: 'fee-authorization-exceeded',
        }),
      }),
    }));

    const result = processCommittedOrderbookSwaps(makeFeeEntityState(), [makerOffer, takerOffer]);
    const takerResolve = result.accountTxs.find(
      item =>
        item.accountId === TAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-buy-with-fee',
    );

    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(makerQuoteQty);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(makerBaseQty);
    expect(takerResolve!.tx.data.feeTokenId).toBe(2);
    expect(takerResolve!.tx.data.feeAmount).toBe(makerBaseQty / 10_000n);

    const improvedQuoteLimit = (makerQuoteQty * 11n) / 10n;
    const improvedTakerOffer = {
      ...takerOffer,
      offerId: 'taker-buy-with-price-improvement',
      giveAmount: improvedQuoteLimit,
      priceTicks: 1100n,
    };
    const improved = processCommittedOrderbookSwaps(
      makeFeeEntityState(),
      [makerOffer, improvedTakerOffer],
    );
    const improvedMakerResolve = improved.accountTxs.find(
      item => item.accountId === MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const improvedTakerResolve = improved.accountTxs.find(
      item =>
        item.accountId === TAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === improvedTakerOffer.offerId,
    );
    expect(improvedMakerResolve).toBeDefined();
    expect(improvedTakerResolve).toBeDefined();
    expect(improvedTakerResolve!.tx.data).toMatchObject({
      executionGiveAmount: makerQuoteQty,
      executionWantAmount: makerBaseQty,
      feeAmount: makerBaseQty / 10_000n,
      cancelRemainder: true,
    });

    const betterBidPriceTicks = 1100n;
    const betterBidQuoteQty = (makerBaseQty * betterBidPriceTicks) / 10_000n;
    const sellLimitQuoteQty = makerQuoteQty;
    const makerBid = {
      offerId: 'maker-bid-price-improvement',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: betterBidQuoteQty,
      wantTokenId: 2,
      wantAmount: makerBaseQty,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: betterBidPriceTicks,
    };
    const improvedSellTaker = {
      offerId: 'taker-sell-with-price-improvement',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: makerBaseQty,
      wantTokenId: 5,
      wantAmount: sellLimitQuoteQty,
      maxFee: sellLimitQuoteQty / 10_000n,
      minNetReceive: sellLimitQuoteQty - sellLimitQuoteQty / 10_000n,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };
    const improvedSell = processCommittedOrderbookSwaps(
      makeFeeEntityState(),
      [makerBid, improvedSellTaker],
    );
    const improvedSellMakerResolve = improvedSell.accountTxs.find(
      item => item.accountId === MAKER_ACCOUNT && item.tx.type === 'swap_resolve',
    );
    const improvedSellTakerResolve = improvedSell.accountTxs.find(
      item =>
        item.accountId === TAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === improvedSellTaker.offerId,
    );
    expect(improvedSellMakerResolve).toBeDefined();
    expect(improvedSellTakerResolve).toBeDefined();
    expect(improvedSellTakerResolve!.tx.data).toMatchObject({
      executionGiveAmount: makerBaseQty,
      executionWantAmount: betterBidQuoteQty,
      feeAmount: sellLimitQuoteQty / 10_000n,
      cancelRemainder: true,
    });

    const accountMachine = makeAccountMachine({
      offerId: 'taker-buy-with-fee',
      makerIsLeft: false,
      giveTokenId: 5,
      giveAmount: makerQuoteQty,
      wantTokenId: 2,
      wantAmount: makerBaseQty,
      maxFee: makerBaseQty / 10_000n,
      minNetReceive: makerBaseQty - makerBaseQty / 10_000n,
      createdHeight: 2,
      priceTicks: makerPriceTicks,
      quantizedGive: makerQuoteQty,
      quantizedWant: makerBaseQty,
    } satisfies SwapOffer);
    const resolveResult = await applyFixtureSwapResolve(
      accountMachine,
      takerResolve!.tx as Extract<AccountTx, { type: 'swap_resolve' }>,
      true,
    );

    expect(resolveResult.ok).toBe(true);
    const quoteDelta = accountMachine.state.deltas.get(5)!;
    const baseDelta = accountMachine.state.deltas.get(2)!;
    expect(quoteDelta.offdelta).toBe(makerQuoteQty);
    expect(baseDelta.offdelta).toBe(-(makerBaseQty - makerBaseQty / 10_000n));
  });

  test('never rematches a resting order after its same-pass fee rejection queued cancellation', () => {
    const pairId = '2/5';
    const priceTicks = 10_000n;
    const makerOrderId = orderKey(MAKER_ACCOUNT, 'maker-fee-resume');
    const restingBidOrderId = orderKey(TAKER_ACCOUNT, 'resting-bid-fee-reject');
    const makerAsk = {
      offerId: 'maker-fee-resume',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: 2n * SWAP_LOT_SCALE,
      wantTokenId: 5,
      wantAmount: 2n * SWAP_LOT_SCALE,
      timeInForce: 0,
      priceTicks,
    };
    const restingBid = {
      offerId: 'resting-bid-fee-reject',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 5,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 2,
      wantAmount: SWAP_LOT_SCALE,
      timeInForce: 0,
      priceTicks,
    };
    const laterAsk = {
      offerId: 'later-ask-after-fee-reject',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE_MAKER_ACCOUNT,
      createdHeight: 3,
      giveTokenId: 2,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 5,
      wantAmount: SWAP_LOT_SCALE,
      timeInForce: 0,
      priceTicks,
    };

    let crossedBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    crossedBook = applyCommand(crossedBook, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks,
      qtyLots: 2n,
    }).state;
    crossedBook = applyCommand(crossedBook, {
      kind: 0,
      ownerId: TAKER_ENTITY,
      orderId: restingBidOrderId,
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks,
      qtyLots: 1n,
    }, {
      suspendedOrderIds: new Set([makerOrderId]),
    }).state;

    const entityState = {
      entityId: HUB_ENTITY,
      entityEncryptionPublicKey: `0x${'55'.repeat(32)}`,
      height: 1,
      timestamp: 1,
      nonces: new Map(),
      proposals: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: ['1'],
        shares: { '1': 1n },
      },
      reserves: new Map(),
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([makerAsk])],
        [TAKER_ACCOUNT, makeAccountMachine([restingBid])],
        [ALICE_MAKER_ACCOUNT, makeAccountMachine([laterAsk])],
      ]),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: 0,
      profile: {
        name: 'Hub',
        isHub: true,
        avatar: '',
        bio: '',
        website: '',
      },
      paybook: { entries: new Map(), feesEarned: 0n },
      swapTradingPairs: [],
      crontabState: initCrontab(),
      hubRebalanceConfig: {
        matchingStrategy: 'amount',
        policyVersion: 1,
        routingFeePPM: 1,
        baseFee: 0n,
        swapTakerFeeBps: 1,
        rebalanceLiquidityFeeBps: 1n,
        rebalanceGasFee: 0n,
        rebalanceTimeoutMs: 10 * 60 * 1000,
      },
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
          usdQuoteAuthorityEntityId: HUB_ENTITY,
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, crossedBook]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      },
    } satisfies EntityState;

    const result = processCommittedOrderbookSwaps(entityState, [makerAsk, laterAsk]);
    const resolves = result.accountTxs.filter(item => item.tx.type === 'swap_resolve');
    const finalBook = result.bookUpdates.at(-1)?.book ?? crossedBook;

    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({
      accountId: TAKER_ACCOUNT,
      tx: {
        type: 'swap_resolve',
        data: {
          offerId: restingBid.offerId,
          fillRatio: 0,
          cancelRemainder: true,
          comment: 'fee-authorization-exceeded',
        },
      },
    });
    expect(finalBook.tradeCount).toBe(0);
    expect(getBookOrder(finalBook, restingBidOrderId)?.qtyLots).toBe(1n);
    expect(getBookOrder(finalBook, orderKey(ALICE_MAKER_ACCOUNT, laterAsk.offerId))?.qtyLots).toBe(1n);
    expect(resolves.some(item => item.accountId === ALICE_MAKER_ACCOUNT)).toBe(false);
  });
});
