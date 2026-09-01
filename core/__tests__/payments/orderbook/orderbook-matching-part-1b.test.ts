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
import { createEntityFrameCandidateState } from '../../../entity/state-clone';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../../entity/state/persistent-collection-map';

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

/** Direct matcher tests that mutate Entity projections must own a real frame overlay. */
const createOrderbookFrameCandidate = (source: EntityState): EntityState =>
  createEntityFrameCandidateState({
    ...source,
    accounts: PersistentEntityAccountMap.fromMap(
      source.accounts,
      source.entityId,
      computeEntityAccountValueHash,
    ),
    htlcRoutes: PersistentEntityCollectionMap.from(source.htlcRoutes ?? new Map()),
    lockBook: PersistentEntityCollectionMap.from(source.lockBook ?? new Map()),
  });

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

const makeCrossLifecycleOffer = (
  offerId: string,
  accountId: string,
  makerEntityId: string,
  side: 0 | 1,
  lots: bigint,
  timeInForce: 0 | 1 | 2,
  createdHeight: number,
) => {
  const sourceJurisdiction = side === 1 ? TESTNET_STACK : TRON_STACK;
  const targetJurisdiction = side === 1 ? TRON_STACK : TESTNET_STACK;
  const route = {
    orderId: offerId,
    bookOwnerEntityId: HUB_ENTITY,
    venueId: CROSS_USDC_USDC_PAIR,
    makerEntityId,
    hubEntityId: HUB_ENTITY,
    source: {
      jurisdiction: sourceJurisdiction,
      entityId: makerEntityId,
      counterpartyEntityId: HUB_ENTITY,
      tokenId: 1,
      amount: lots * SWAP_LOT_SCALE,
    },
    target: {
      jurisdiction: targetJurisdiction,
      entityId: makerEntityId,
      counterpartyEntityId: HUB_ENTITY,
      tokenId: 1,
      amount: lots * SWAP_LOT_SCALE,
    },
    status: 'resting' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    offerId,
    accountId,
    makerIsLeft: false,
    fromEntity: HUB_ENTITY,
    toEntity: makerEntityId,
    createdHeight,
    giveTokenId: 1,
    giveAmount: lots * SWAP_LOT_SCALE,
    quantizedGive: lots * SWAP_LOT_SCALE,
    wantTokenId: 1,
    wantAmount: lots * SWAP_LOT_SCALE,
    quantizedWant: lots * SWAP_LOT_SCALE,
    timeInForce,
    priceTicks: ORDERBOOK_PRICE_SCALE,
    crossJurisdiction: route,
  };
};

const makeCrossLifecycleState = (offers: ReturnType<typeof makeCrossLifecycleOffer>[]) => ({
  entityId: HUB_ENTITY,
  accounts: new Map(offers.map(offer => [offer.accountId, makeAccountMachine([offer])])),
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
      supportedPairs: [CROSS_USDC_USDC_PAIR],
    },
    books: new Map(),
    orderPairs: new Map(),
    pairDimensions: new Map(),
    referrals: new Map(),
  },
});

describe('orderbook matching execution mapping', () => {
  test('cross-j zero-fill IOC and FOK terminate with cancel ACK instead of halting', () => {
    for (const timeInForce of [1, 2] as const) {
      const offer = makeCrossLifecycleOffer(
        `unfilled-${timeInForce}`,
        TAKER_ACCOUNT,
        TAKER_ENTITY,
        0,
        1n,
        timeInForce,
        1,
      );
      const result = processCommittedOrderbookSwaps(
        makeCrossLifecycleState([offer]) as any,
        [offer] as any,
      );
      expect(result.debugProjectionRejects).toEqual([]);
      expect(result.bookUpdates).toEqual([]);
      expect(result.accountTxs).toEqual([{
        accountId: TAKER_ACCOUNT,
        tx: expect.objectContaining({
          type: 'cross_swap_fill_ack',
          data: expect.objectContaining({
            offerId: offer.offerId,
            ackKind: 'cancel',
            cancelRemainder: true,
          }),
        }),
      }]);
    }
  });

  test('cross-j partial IOC cancels only the taker remainder', () => {
    const maker = makeCrossLifecycleOffer(
      'partial-ioc-maker',
      MAKER_ACCOUNT,
      MAKER_ENTITY,
      1,
      1n,
      0,
      1,
    );
    const taker = makeCrossLifecycleOffer(
      'partial-ioc-taker',
      TAKER_ACCOUNT,
      TAKER_ENTITY,
      0,
      2n,
      1,
      2,
    );
    const result = processCommittedOrderbookSwaps(
      makeCrossLifecycleState([maker, taker]) as any,
      [maker, taker] as any,
    );
    const makerAck = result.accountTxs.find(op => op.accountId === MAKER_ACCOUNT);
    const takerAck = result.accountTxs.find(op => op.accountId === TAKER_ACCOUNT);
    expect(makerAck?.tx.type).toBe('cross_swap_fill_ack');
    expect(makerAck?.tx.data.cancelRemainder).toBe(true);
    expect(takerAck?.tx.type).toBe('cross_swap_fill_ack');
    expect(takerAck?.tx.data.cancelRemainder).toBe(true);
    expect(takerAck?.tx.data.ackKind).toBe('fill');
    expect(takerAck?.tx.data.cumulativeFillRatio).toBeLessThan(65_535);
    expect(result.debugProjectionRejects).toEqual([]);
  });

  test('cross-j STP after a partial fill cancels the taker remainder', () => {
    const externalMaker = makeCrossLifecycleOffer(
      'stp-external-maker',
      MAKER_ACCOUNT_ONE,
      MAKER_ONE,
      1,
      1n,
      0,
      1,
    );
    const selfMaker = makeCrossLifecycleOffer(
      'stp-self-maker',
      MAKER_ACCOUNT_TWO,
      TAKER_ENTITY,
      1,
      1n,
      0,
      2,
    );
    const taker = makeCrossLifecycleOffer(
      'stp-taker',
      TAKER_ACCOUNT,
      TAKER_ENTITY,
      0,
      2n,
      0,
      3,
    );
    const result = processCommittedOrderbookSwaps(
      makeCrossLifecycleState([externalMaker, selfMaker, taker]) as any,
      [externalMaker, selfMaker, taker] as any,
    );
    const takerAck = result.accountTxs.find(op => op.accountId === TAKER_ACCOUNT);
    expect(takerAck?.tx.type).toBe('cross_swap_fill_ack');
    expect(takerAck?.tx.data.cancelRemainder).toBe(true);
    expect(takerAck?.tx.data.cumulativeFillRatio).toBeLessThan(65_535);
    expect(result.debugProjectionRejects).toEqual([]);
  });

  test('requantizes a partial fill at the committed price', async () => {
    const lot = SWAP_LOT_SCALE;
    const accountMachine = makeAccountMachine({
      offerId: 'maker-partial',
      makerIsLeft: true,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 5,
      wantAmount: (2000n * lot) / 10_000n,
      createdHeight: 1,
      priceTicks: 1000n,
      quantizedGive: 2n * lot,
      quantizedWant: (2000n * lot) / 10_000n,
    } satisfies SwapOffer);
    const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'maker-partial',
        fillRatio: 32768,
        cancelRemainder: false,
        executionGiveAmount: lot,
        executionWantAmount: (1000n * lot) / 10_000n,
      },
    };
    const committedOffer = accountMachine.state.swapOffers.get('maker-partial');
    expect(Object.isFrozen(committedOffer)).toBe(true);

    const resolveResult = await applyFixtureSwapResolve(accountMachine, accountTx, false);
    expect(resolveResult.ok).toBe(true);

    const remaining = accountMachine.state.swapOffers.get('maker-partial');
    expect(remaining).toBeDefined();
    expect(remaining).not.toBe(committedOffer);
    expect(committedOffer?.giveAmount).toBe(2n * lot);
    expect(remaining!.priceTicks).toBe(1000n);
    expect(remaining!.giveAmount).toBe(lot);
    expect(remaining!.wantAmount).toBe((1000n * lot) / 10_000n);
    expect(remaining!.quantizedGive).toBe(lot);
    expect(remaining!.quantizedWant).toBe((1000n * lot) / 10_000n);
  });

  test('price improvement releases savings without enlarging a GTC buy remainder', async () => {
    const lot = SWAP_LOT_SCALE;
    const accountMachine = makeAccountMachine({
      offerId: 'buyer-price-improvement-partial',
      makerIsLeft: true,
      giveTokenId: 5,
      giveAmount: 22n * lot,
      wantTokenId: 2,
      wantAmount: 200n * lot,
      createdHeight: 1,
      priceTicks: 1100n,
      quantizedGive: 22n * lot,
      quantizedWant: 200n * lot,
    } satisfies SwapOffer);
    const result = await applyFixtureSwapResolve(accountMachine, {
      type: 'swap_resolve',
      data: {
        offerId: 'buyer-price-improvement-partial',
        fillRatio: deriveCanonicalSwapFillRatio(22n * lot, 10n * lot),
        cancelRemainder: false,
        executionGiveAmount: 10n * lot,
        executionWantAmount: 100n * lot,
      },
    }, false);

    expect(result.ok ? undefined : accountTxFailureMessage(result)).toBeUndefined();
    expect(result.ok).toBe(true);
    const remaining = accountMachine.state.swapOffers.get('buyer-price-improvement-partial');
    expect(remaining).toMatchObject({
      giveAmount: 11n * lot,
      wantAmount: 100n * lot,
      quantizedGive: 11n * lot,
      quantizedWant: 100n * lot,
    });
    expect(accountMachine.state.deltas.get(5)!.leftHold).toBe(11n * lot);
  });

  test.each([
    ['priceTicks', { priceTicks: undefined }],
    ['quantizedGive', { quantizedGive: undefined }],
    ['quantizedWant', { quantizedWant: undefined }],
  ])(
    'rejects swap_resolve against a committed offer missing %s instead of reconstructing it',
    async (_field, override) => {
      const lot = SWAP_LOT_SCALE;
      const accountMachine = makeAccountMachine({
        offerId: 'maker-incomplete',
        makerIsLeft: true,
        giveTokenId: 2,
        giveAmount: 2n * lot,
        wantTokenId: 5,
        wantAmount: (2000n * lot) / 10_000n,
        createdHeight: 1,
        priceTicks: 1000n,
        quantizedGive: 2n * lot,
        quantizedWant: (2000n * lot) / 10_000n,
        ...override,
      } as SwapOffer);
      const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
        type: 'swap_resolve',
        data: {
          offerId: 'maker-incomplete',
          fillRatio: 32768,
          cancelRemainder: false,
          executionGiveAmount: lot,
          executionWantAmount: (1000n * lot) / 10_000n,
        },
      };

      const resolveResult = await applyFixtureSwapResolve(accountMachine, accountTx, false);
      expect(resolveResult.ok).toBe(false);
      expect(accountTxFailureMessage(resolveResult)).toContain('missing canonical price or quantized amounts');
    },
  );

  test('rejects a resolve whose claimed resting price differs from the committed price', async () => {
    const lot = SWAP_LOT_SCALE;
    const accountMachine = makeAccountMachine({
      offerId: 'maker-price-claim',
      makerIsLeft: true,
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 5,
      wantAmount: (2000n * lot) / 10_000n,
      createdHeight: 1,
      priceTicks: 1000n,
      quantizedGive: 2n * lot,
      quantizedWant: (2000n * lot) / 10_000n,
    } satisfies SwapOffer);
    const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'maker-price-claim',
        fillRatio: 32768,
        cancelRemainder: false,
        executionGiveAmount: lot,
        executionWantAmount: (1000n * lot) / 10_000n,
        restingPriceTicks: 900n,
      },
    };

    const resolveResult = await applyFixtureSwapResolve(accountMachine, accountTx, false);
    expect(resolveResult.ok).toBe(false);
    expect(accountTxFailureMessage(resolveResult)).toContain('Resting swap terms mismatch live offer');
  });

  test('auto-cancels prices outside the 30% anchor band instead of resting them', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBaseQty = lot;
    const makerPriceTicks = 1000n;
    const makerQuoteQty = (makerBaseQty * makerPriceTicks) / 10_000n;

    const takerBaseQty = 2n * lot;
    const takerPriceTicks = 1400n;
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
      offerId: 'taker-buy-too-high',
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
    const cancelOp = result.accountTxs.find(
      item =>
        item.accountId === TAKER_ACCOUNT &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-buy-too-high',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;

    expect(cancelOp).toBeDefined();
    expect(cancelOp!.tx.data.fillRatio).toBe(0);
    expect(cancelOp!.tx.data.cancelRemainder).toBe(true);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, orderKey(TAKER_ACCOUNT, 'taker-buy-too-high'))).toBeNull();
  });

  test('sweeps far resting orders outside the pair band before matching new flow', () => {
    const lot = SWAP_LOT_SCALE;
    const nearAskPriceTicks = 25_000_000n;
    const farAskPriceTicks = 40_000_000n;
    const bidPriceTicks = 24_900_000n;

    const nearAskOffer = {
      offerId: 'near-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'near-maker',
      accountId: NEAR_MAKER_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (lot * nearAskPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: nearAskPriceTicks,
    };
    const farAskOffer = {
      offerId: 'far-ask',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'far-maker',
      accountId: FAR_MAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: (lot * farAskPriceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks: farAskPriceTicks,
    };
    const incomingBidOffer = {
      offerId: 'fresh-bid',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: 'taker',
      accountId: TAKER_ACCOUNT,
      createdHeight: 3,
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
        [NEAR_MAKER_ACCOUNT, makeAccountMachine([nearAskOffer])],
        [FAR_MAKER_ACCOUNT, makeAccountMachine([farAskOffer])],
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
        books: new Map([
          [
            '1/2',
            (() => {
              let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
              book = applyCommand(book, {
                kind: 0,
                ownerId: 'near-maker',
                orderId: orderKey(NEAR_MAKER_ACCOUNT, 'near-ask'),
                side: 1,
                tif: 0,
                postOnly: false,
                priceTicks: nearAskPriceTicks,
                qtyLots: 1n,
              }).state;
              book = applyCommand(book, {
                kind: 0,
                ownerId: 'far-maker',
                orderId: orderKey(FAR_MAKER_ACCOUNT, 'far-ask'),
                side: 1,
                tif: 0,
                postOnly: false,
                priceTicks: farAskPriceTicks,
                qtyLots: 1n,
              }).state;
              return book;
            })(),
          ],
        ]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [incomingBidOffer] as any);
    const farCancel = result.accountTxs.find(
      item =>
        item.accountId === FAR_MAKER_ACCOUNT && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'far-ask',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;

    expect(farCancel).toBeDefined();
    expect(farCancel!.tx.data.fillRatio).toBe(0);
    expect(farCancel!.tx.data.cancelRemainder).toBe(true);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, orderKey(FAR_MAKER_ACCOUNT, 'far-ask'))).toBeNull();
    expect(getBookOrder(finalBook!, orderKey(NEAR_MAKER_ACCOUNT, 'near-ask'))).not.toBeNull();
    expect(getBookOrder(finalBook!, orderKey(TAKER_ACCOUNT, 'fresh-bid'))).not.toBeNull();
  });

  test('does not enqueue duplicate fail-closed cancel when the same offer is already pending in mempool or pendingFrame', () => {
    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: true,
      fromEntity: MAKER_ENTITY,
      toEntity: HUB_ENTITY,
      accountId: MAKER_ACCOUNT,
      giveTokenId: 2,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 5,
      wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1000n,
      quantizedGive: SWAP_LOT_SCALE,
      quantizedWant: (1000n * SWAP_LOT_SCALE) / 10_000n,
    } satisfies SwapOffer;

    const takerOffer = {
      offerId: 'taker-buy-too-high',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      giveTokenId: 5,
      giveAmount: (1400n * SWAP_LOT_SCALE) / 10_000n,
      wantTokenId: 2,
      wantAmount: SWAP_LOT_SCALE,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: 1400n,
      quantizedGive: (1400n * SWAP_LOT_SCALE) / 10_000n,
      quantizedWant: SWAP_LOT_SCALE,
    } satisfies SwapOffer;

    const takerAccount = makeAccountMachine(takerOffer);
    takerAccount.leftEntity = TAKER_ENTITY;
    takerAccount.rightEntity = HUB_ENTITY;
    takerAccount.proofHeader = { fromEntity: TAKER_ENTITY, toEntity: HUB_ENTITY, nextProofNonce: 0 };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine(makerOffer)],
        [TAKER_ACCOUNT, takerAccount],
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
      },
    } as any;

    const firstPass = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(firstPass.accountTxs).toHaveLength(1);
    expect(firstPass.accountTxs[0]?.accountId).toBe(TAKER_ACCOUNT);
    expect(firstPass.accountTxs[0]?.tx.type).toBe('swap_resolve');
    expect(firstPass.accountTxs[0]?.tx.data.offerId).toBe('taker-buy-too-high');
    expect(firstPass.accountTxs[0]?.tx.data.cancelRemainder).toBe(true);

    takerAccount.mempool.push(firstPass.accountTxs[0]!.tx as AccountTx);
    const secondPass = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(secondPass.accountTxs).toHaveLength(0);

    takerAccount.mempool = [];
    takerAccount.pendingFrame = {
      height: 1,
      timestamp: 1,
      jHeight: 0,
      accountTxs: [firstPass.accountTxs[0]!.tx as AccountTx],
      prevFrameHash: '',
      deltas: [],
      stateHash: '',
      byLeft: true,
    };
    const thirdPass = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(thirdPass.accountTxs).toHaveLength(0);
  });

  test('sorts live offers canonically before inserting into the book', () => {
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [ALICE, makeAccountIndex(['offer-a'])],
        [BOB, makeAccountIndex(['offer-b'])],
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

    const offers = [
      {
        offerId: 'offer-b',
        makerIsLeft: false,
        fromEntity: HUB_ENTITY,
        toEntity: BOB,
        accountId: BOB,
        createdHeight: 7,
        giveTokenId: 2,
        giveAmount: SWAP_LOT_SCALE,
        wantTokenId: 5,
        wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
        timeInForce: 0,
        priceTicks: 1000n,
      },
      {
        offerId: 'offer-a',
        makerIsLeft: false,
        fromEntity: HUB_ENTITY,
        toEntity: ALICE,
        accountId: ALICE,
        createdHeight: 3,
        giveTokenId: 2,
        giveAmount: SWAP_LOT_SCALE,
        wantTokenId: 5,
        wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
        timeInForce: 0,
        priceTicks: 1000n,
      },
    ];

    const result = processCommittedOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBestAsk(finalBook!)).toBe(1000n);
    expect(getBookSideLevels(finalBook!, 1, 1)[0]?.orderIds[0]).toBe(orderKey(ALICE, 'offer-a'));
  });

  test('debug projection rebuild reports crossed offers without emitting swap_resolve side effects', () => {
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [ALICE, makeAccountIndex(['offer-a'])],
        [BOB, makeAccountIndex(['offer-b'])],
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

    const offers = [
      {
        offerId: 'offer-a',
        makerIsLeft: false,
        fromEntity: HUB_ENTITY,
        toEntity: ALICE,
        accountId: ALICE,
        createdHeight: 1,
        giveTokenId: 2,
        giveAmount: SWAP_LOT_SCALE,
        wantTokenId: 5,
        wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
        timeInForce: 0,
        priceTicks: 1000n,
      },
      {
        offerId: 'offer-b',
        makerIsLeft: false,
        fromEntity: HUB_ENTITY,
        toEntity: BOB,
        accountId: BOB,
        createdHeight: 2,
        giveTokenId: 5,
        giveAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
        wantTokenId: 2,
        wantAmount: SWAP_LOT_SCALE,
        timeInForce: 0,
        priceTicks: 1000n,
      },
    ];

    const result = processCommittedOrderbookSwaps(entityState, offers as any, { debugRebuildProjectionOnly: true });
    expect(result.accountTxs).toHaveLength(0);
    expect(result.bookUpdates).toEqual([]);
    expect(result.debugProjectionRejects.map(offer => `${offer.accountId}:${offer.offerId}`)).toEqual([orderKey(BOB, 'offer-b')]);
    expect(result.debugProjectionRejects[0]?.reason).toBe('post-only-reject:postOnly would cross');
    expect(entityState.orderbookExt.books.size).toBe(0);
  });

  test('resumes a crossed resting bid after the partially filled maker remainder commits', () => {
    const pairId = '2/5';
    const priceTicks = 10_000n;
    const makerOrderId = orderKey(MAKER_ACCOUNT, 'maker-remainder');
    const takerOrderId = orderKey(TAKER_ACCOUNT, 'crossed-resting-bid');
    const makerOffer = {
      offerId: 'maker-remainder',
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
    const crossedBid = {
      offerId: 'crossed-resting-bid',
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
      orderId: takerOrderId,
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks,
      qtyLots: 1n,
    }, {
      suspendedOrderIds: new Set([makerOrderId]),
    }).state;
    expect(getBestBid(crossedBook)).toBe(priceTicks);
    expect(getBestAsk(crossedBook)).toBe(priceTicks);

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([makerOffer])],
        [TAKER_ACCOUNT, makeAccountMachine([crossedBid])],
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
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, crossedBook]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer] as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook?.tradeCount).toBe(1);
    expect(result.accountTxs.filter(item => item.tx.type === 'swap_resolve')).toHaveLength(2);
    expect(getBookOrder(finalBook!, takerOrderId)).toBeNull();
    expect(getBookOrder(finalBook!, makerOrderId)?.qtyLots).toBe(1n);
  });

  test('drains every eligible crossing after a committed removal exposes the pair', () => {
    const pairId = '2/5';
    const priceTicks = 10_000n;
    const rows = [
      [MAKER_ACCOUNT, MAKER_ENTITY, 'pending-ask', 1],
      [MAKER_ACCOUNT_ONE, MAKER_ONE, 'eligible-ask-1', 1],
      [MAKER_ACCOUNT_TWO, MAKER_TWO, 'eligible-ask-2', 1],
      [ALICE_MAKER_ACCOUNT, ALICE, 'pending-bid', 0],
      [ALICE_TAKER_ACCOUNT, TAKER_ENTITY, 'eligible-bid-1', 0],
      [ASK_MAKER_ACCOUNT, BOB, 'eligible-bid-2', 0],
    ] as const;
    const offers = rows.map(([accountId, ownerId, offerId, side], createdHeight) => ({
      offerId,
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ownerId,
      accountId,
      createdHeight,
      giveTokenId: side === 1 ? 2 : 5,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: side === 1 ? 5 : 2,
      wantAmount: SWAP_LOT_SCALE,
      timeInForce: 0 as const,
      priceTicks,
    }));
    const askOrderIds = offers.slice(0, 3).map(offer => orderKey(offer.accountId, offer.offerId));
    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    for (const [index, offer] of offers.entries()) {
      book = applyCommand(book, {
        kind: 0,
        ownerId: offer.toEntity,
        orderId: orderKey(offer.accountId, offer.offerId),
        side: index < 3 ? 1 : 0,
        tif: 0,
        postOnly: false,
        priceTicks,
        qtyLots: 1n,
      }, index < 3 ? undefined : { suspendedOrderIds: new Set(askOrderIds) }).state;
    }
    const accounts = new Map(offers.map(offer => [offer.accountId, makeAccountMachine([offer])]));
    for (const pendingOffer of [offers[0]!, offers[3]!]) {
      accounts.get(pendingOffer.accountId)!.mempool.push({
        type: 'swap_resolve',
        data: { offerId: pendingOffer.offerId, fillRatio: 0, cancelRemainder: true },
      });
    }
    const entityState = {
      entityId: HUB_ENTITY,
      accounts,
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
          supportedPairs: [pairId],
        },
        books: new Map([[pairId, book]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      },
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [], {
      resumeSamePairIds: [pairId],
    } as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook?.tradeCount).toBe(2);
    expect(result.accountTxs.map(item => item.tx.type === 'swap_resolve' && item.tx.data.offerId))
      .toEqual(['eligible-ask-1', 'eligible-bid-1', 'eligible-ask-2', 'eligible-bid-2']);
    for (const offer of offers.slice(1, 3).concat(offers.slice(4))) {
      expect(getBookOrder(finalBook!, orderKey(offer.accountId, offer.offerId))).toBeNull();
    }
    expect(getBookOrder(finalBook!, orderKey(offers[0]!.accountId, offers[0]!.offerId))).not.toBeNull();
    expect(getBookOrder(finalBook!, orderKey(offers[3]!.accountId, offers[3]!.offerId))).not.toBeNull();
  });

  test('uncrosses with the older maker price and preserves the taker level position', () => {
    const askId = 'maker-ask';
    const firstBidId = 'first-crossed-bid';
    const laterBidId = 'later-crossed-bid';
    let book = createBook({ bucketWidthTicks: 100n, maxOrders: 100, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: askId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;
    const suspendedMaker = { suspendedOrderIds: new Set([askId]) };
    book = applyCommand(book, {
      kind: 0,
      ownerId: TAKER_ENTITY,
      orderId: firstBidId,
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 10_100n,
      qtyLots: 2n,
    }, suspendedMaker).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: BOB,
      orderId: laterBidId,
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 10_100n,
      qtyLots: 1n,
    }, suspendedMaker).state;
    const originalSeq = getBookOrder(book, firstBidId)?.seq;

    const resumed = resumeCrossedBook(book);
    const trade = resumed?.events.find(event => event.type === 'TRADE');
    expect(trade?.makerOrderId).toBe(askId);
    expect(trade?.takerOrderId).toBe(firstBidId);
    expect(trade?.price).toBe(10_000n);
    expect(getBookOrder(book, firstBidId)?.seq).toBe(originalSeq);
    expect(getBookSideLevels(book, 0, 1)[0]?.orderIds).toEqual([firstBidId, laterBidId]);
  });

  test('preserves exact aligned price when creating an exact book', () => {
    const priceTicks = 24_999_992n;
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[ALICE, makeAccountIndex(['offer-a'])]]),
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

    const offer = {
      offerId: 'offer-a',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: 30_000n * SWAP_LOT_SCALE,
      wantTokenId: 1,
      wantAmount: (30_000n * SWAP_LOT_SCALE * priceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks,
    };

    const result = processCommittedOrderbookSwaps(entityState, [offer] as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();

    expect(getBookOrder(finalBook!, orderKey(ALICE, 'offer-a'))?.priceTicks).toBe(priceTicks);
  });

  test('keeps wide exact prices in the pair book without widening or snapping', () => {
    const anchorPriceTicks = 25_015_002n;
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [
          ALICE,
          makeAccountIndex(['offer-a', 'offer-b', 'offer-c']),
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
          supportedPairs: ['1/2'],
        },
        books: new Map(),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const makeOffer = (offerId: string, priceTicks: bigint, size: bigint) => ({
      offerId,
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: ALICE,
      accountId: ALICE,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: size,
      wantTokenId: 1,
      wantAmount: (size * priceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks,
    });

    const offers = [
      makeOffer('offer-a', anchorPriceTicks, exactWethBaseAmount(anchorPriceTicks, 210n)),
      makeOffer('offer-b', 25_137_562n, exactWethBaseAmount(25_137_562n, 600n)),
      makeOffer('offer-c', 25_262_625n, exactWethBaseAmount(25_262_625n, 960n)),
    ];
    entityState.accounts.get(ALICE)!.swapOffers = new Map(offers.map(offer => [offer.offerId, offer]));

    const result = processCommittedOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(finalBook!.params.bucketWidthTicks).toBe(10_000n);
    expect(getBookOrder(finalBook!, orderKey(ALICE, 'offer-a'))?.priceTicks).toBe(anchorPriceTicks);
    expect(getBookOrder(finalBook!, orderKey(ALICE, 'offer-b'))?.priceTicks).toBe(25_137_562n);
    expect(getBookOrder(finalBook!, orderKey(ALICE, 'offer-c'))?.priceTicks).toBe(25_262_625n);
  });

  test('fails fast when a stale persisted pair book diverges from account offers', () => {
    const askPriceTicks = 25_000_002n;
    const bidPriceTicks = 24_999_998n;
    const lot = SWAP_LOT_SCALE;
    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: orderKey(MAKER_ACCOUNT, 'maker-ask'),
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 24_999_998n,
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

  test('fails fast when a persisted cross-j book order has no swapOffer or admitted route', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_USDC_USDC_PAIR;
    let staleBook = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: orderKey(MAKER_ACCOUNT, 'maker-cross'),
      side: 0,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;

    const route = {
      orderId: 'taker-cross',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: TAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: lot,
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };

    const takerOffer = {
      offerId: 'taker-cross',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: lot,
      wantTokenId: 1,
      wantAmount: lot,
      timeInForce: 0,
      priceTicks: 10_000n,
      crossJurisdiction: route,
    };

    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([])],
        [TAKER_ACCOUNT, makeAccountMachine([takerOffer])],
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
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [takerOffer] as any)).toThrow(
      /ORDERBOOK_CROSS_J_SNAPSHOT_MISSING/,
    );
  });

  test('keeps a canonical cross-j book order after a committed partial fill ack without refreshing it', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const filledSourceAmount = 10_000n * lot;
    const filledTargetAmount = quoteAmountAtPrice(2, 1, filledSourceAmount, 25_000_000n);
    const remainingSource = sourceTotal - filledSourceAmount;
    const remainingTarget = targetTotal - filledTargetAmount;
    const pairId = CROSS_WETH_USDC_PAIR;
    const namespacedOrderId = orderKey(MAKER_ACCOUNT, 'maker-cross-partial');
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
    const offer = {
      offerId: 'maker-cross-partial',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 2,
      giveAmount: remainingSource,
      quantizedGive: remainingSource,
      wantTokenId: 1,
      wantAmount: remainingTarget,
      quantizedWant: remainingTarget,
      timeInForce: 0,
      priceTicks: 25_000_000n,
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
        books: new Map([[pairId, staleBook]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [offer] as any);

    expect(result.bookUpdates).toEqual([]);
    expect(getBookOrder(staleBook, namespacedOrderId)?.qtyLots).toBe(30_000n);
  });

  test('does not persist speculative cross-j post-trade book before fill ack commits', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 40_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, 25_000_000n);
    const fillSource = 10_000n * lot;
    const fillTarget = quoteAmountAtPrice(2, 1, fillSource, 25_000_000n);
    const pairId = CROSS_WETH_USDC_PAIR;
    const makerOrderId = orderKey(MAKER_ACCOUNT, 'maker-cross-partial-live');
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 40_000n,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-partial-live',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: MAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
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
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
    };
    const takerRoute = {
      ...makerRoute,
      orderId: 'taker-cross-partial-live',
      makerEntityId: TAKER_ENTITY,
      source: {
        jurisdiction: TRON_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: fillTarget,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: fillSource,
      },
    };
    const makerOffer = {
      offerId: 'maker-cross-partial-live',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
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
    const takerOffer = {
      offerId: 'taker-cross-partial-live',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: fillTarget,
      quantizedGive: fillTarget,
      wantTokenId: 2,
      wantAmount: fillSource,
      quantizedWant: fillSource,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([makerOffer])],
        [TAKER_ACCOUNT, makeAccountMachine([takerOffer])],
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
        books: new Map([[pairId, book]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    const makerAck = result.accountTxs.find(
      op => op.accountId === MAKER_ACCOUNT && op.tx.type === 'cross_swap_fill_ack',
    );

    expect(makerAck?.tx.data.cancelRemainder).toBe(false);
    expect((makerAck?.tx.data.incrementalSourceAmount ?? 0n) > 0n).toBe(true);
    expect((makerAck?.tx.data.incrementalSourceAmount ?? sourceTotal) < sourceTotal).toBe(true);
    expect(getBookOrder(book, makerOrderId)?.qtyLots).toBe(40_000n);
    expect(result.bookUpdates.find(update => update.pairId === pairId)).toBeUndefined();
  });

  test('fails fast when prior cross-j progress lacks an exact ratio', () => {
    const lot = SWAP_LOT_SCALE;
    const sourceTotal = 1_000_000n * lot;
    const targetTotal = quoteAmountAtPrice(2, 1, sourceTotal, ORDERBOOK_PRICE_SCALE);
    const previousRatio = 1_000n;
    const makerQtyLots = sourceTotal / lot;
    const fillSource = lot;
    const fillTarget = quoteAmountAtPrice(2, 1, fillSource, ORDERBOOK_PRICE_SCALE);
    const pairId = CROSS_WETH_USDC_PAIR;
    const makerOrderId = orderKey(MAKER_ACCOUNT, 'maker-cross-tiny-fill');
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: ORDERBOOK_PRICE_SCALE,
      qtyLots: makerQtyLots,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-tiny-fill',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: MAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
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
      status: 'partially_filled',
      cumulativeFillRatio: Number(previousRatio),
      filledSourceAmount: 0n,
      filledTargetAmount: 0n,
      createdAt: 1,
      updatedAt: 1,
    };
    const takerRoute = {
      ...makerRoute,
      orderId: 'taker-cross-tiny-fill',
      makerEntityId: TAKER_ENTITY,
      source: {
        jurisdiction: TRON_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: fillTarget,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: fillSource,
      },
      status: 'resting',
      cumulativeFillRatio: undefined,
    };
    const makerOffer = {
      offerId: 'maker-cross-tiny-fill',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: sourceTotal,
      quantizedGive: sourceTotal,
      wantTokenId: 1,
      wantAmount: targetTotal,
      quantizedWant: targetTotal,
      timeInForce: 0,
      priceTicks: ORDERBOOK_PRICE_SCALE,
      crossJurisdiction: makerRoute,
    };
    const takerOffer = {
      offerId: 'taker-cross-tiny-fill',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: TAKER_ACCOUNT,
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: fillTarget,
      quantizedGive: fillTarget,
      wantTokenId: 2,
      wantAmount: fillSource,
      quantizedWant: fillSource,
      timeInForce: 0,
      priceTicks: ORDERBOOK_PRICE_SCALE,
      crossJurisdiction: takerRoute,
    };
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ACCOUNT, makeAccountMachine([makerOffer])],
        [TAKER_ACCOUNT, makeAccountMachine([takerOffer])],
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
        books: new Map([[pairId, book]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    expect(() => processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any)).toThrow(
      'CROSS_J_EXACT_FILL_RATIO_REQUIRED',
    );
    expect(getBookOrder(book, makerOrderId)?.qtyLots).toBe(makerQtyLots);
  });

  test('removes non-working cross-j committed routes before matching new takers', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const staleOrderId = `${MAKER_ENTITY}:old-cross`;
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: staleOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 1n,
    }).state;

    const staleRoute = {
      orderId: 'old-cross',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: MAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      status: 'clearing',
      createdAt: 1,
      updatedAt: 2,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    };
    const takerRoute = {
      ...staleRoute,
      orderId: 'new-taker',
      makerEntityId: TAKER_ENTITY,
      source: {
        jurisdiction: TRON_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: lot,
      },
      status: 'resting',
    };
    const takerOffer = {
      offerId: 'new-taker',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: NEW_TAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      quantizedGive: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      wantTokenId: 2,
      wantAmount: lot,
      quantizedWant: lot,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([[NEW_TAKER_ACCOUNT, makeAccountMachine([takerOffer])]]),
      crossJurisdictionSwaps: new Map([['old-cross', staleRoute]]),
      crossJurisdictionBookAdmissions: new Map([
        [
          staleOrderId,
          {
            orderId: 'old-cross',
            routeHash: 'hash',
            sourceEntityId: MAKER_ENTITY,
            bookOwnerEntityId: HUB_ENTITY,
            status: 'admitted',
            route: { ...staleRoute, status: 'resting' },
            updatedAt: 1,
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
        books: new Map([[pairId, book]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(
      createOrderbookFrameCandidate(entityState),
      [takerOffer] as any,
    );

    expect(result.crossJurisdictionFills).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, staleOrderId)).toBeNull();
    expect(getBookOrder(book, staleOrderId)).not.toBeNull();
  });

  test('removes terminal admitted cross-j rows even when stale mirrors still look resting', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const staleOrderId = `${MAKER_ENTITY}:old-cross`;
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: MAKER_ENTITY,
      orderId: staleOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 1n,
    }).state;

    const staleRoute = {
      orderId: 'old-cross',
      bookOwnerEntityId: HUB_ENTITY,
      venueId: pairId,
      makerEntityId: MAKER_ENTITY,
      hubEntityId: HUB_ENTITY,
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: MAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 2,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    };
    const makerOffer = {
      offerId: 'old-cross',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: MAKER_ENTITY,
      accountId: MAKER_ENTITY,
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: lot,
      quantizedGive: lot,
      wantTokenId: 1,
      wantAmount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      quantizedWant: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: staleRoute,
    };
    const takerRoute = {
      ...staleRoute,
      orderId: 'new-taker',
      makerEntityId: TAKER_ENTITY,
      source: {
        jurisdiction: TRON_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: TAKER_ENTITY,
        counterpartyEntityId: HUB_ENTITY,
        tokenId: 2,
        amount: lot,
      },
    };
    const takerOffer = {
      offerId: 'new-taker',
      makerIsLeft: false,
      fromEntity: HUB_ENTITY,
      toEntity: TAKER_ENTITY,
      accountId: NEW_TAKER_ACCOUNT,
      createdHeight: 2,
      giveTokenId: 1,
      giveAmount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      quantizedGive: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      wantTokenId: 2,
      wantAmount: lot,
      quantizedWant: lot,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    };
    const entityState = {
      entityId: HUB_ENTITY,
      accounts: new Map([
        [MAKER_ENTITY, makeAccountMachine([makerOffer])],
        [NEW_TAKER_ACCOUNT, makeAccountMachine([takerOffer])],
      ]),
      crossJurisdictionSwaps: new Map([['old-cross', staleRoute]]),
      crossJurisdictionBookAdmissions: new Map([
        [
          staleOrderId,
          {
            orderId: 'old-cross',
            routeHash: 'hash',
            sourceEntityId: MAKER_ENTITY,
            bookOwnerEntityId: HUB_ENTITY,
            status: 'closed',
            route: staleRoute,
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
        books: new Map([[pairId, book]]),
        orderPairs: new Map(),
        pairDimensions: new Map(),
        referrals: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(
      createOrderbookFrameCandidate(entityState),
      [takerOffer] as any,
    );

    expect(result.crossJurisdictionFills).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, staleOrderId)).toBeNull();
    expect(getBookOrder(book, staleOrderId)).not.toBeNull();
  });
});
