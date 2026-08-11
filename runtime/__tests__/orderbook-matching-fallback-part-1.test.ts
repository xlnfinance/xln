import { describe, expect, test } from 'bun:test';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';

import { createBook, applyCommand, getBestAsk, getBestBid, getBookOrder, getBookSideLevels } from '../orderbook/core';

import { getSwapLotScale, ORDERBOOK_PRICE_SCALE, quoteAmountAtPrice, SWAP_LOT_SCALE } from '../orderbook/types';

import { removeCrossJurisdictionBookOrderByRouteId } from '../orderbook/cross-j';

import { processOrderbookCancels, processOrderbookSwaps } from '../entity/tx/handlers/account';

import { applyCrossJurisdictionBookProgressToState } from '../entity/tx/handlers/cross-j-book-order';

import { handleSwapResolve } from '../account/tx/handlers/swap-resolve';

import { createEmptyEnv } from '../runtime';

import { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../extensions/cross-j/fill-ack';

import {
  deriveCanonicalSwapFillRatio,
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
} from '../orderbook/swap-execution';

import type { AccountReplica, AccountTx, SwapOffer } from '../types/account';

import { createDefaultDelta } from '../account/delta';

const TESTNET_STACK = `stack:31337:0x${'11'.repeat(20)}`;

const TRON_STACK = `stack:31338:0x${'22'.repeat(20)}`;

const CROSS_WETH_USDC_PAIR = `cross:${TESTNET_STACK}:2/${TRON_STACK}:1`;

const CROSS_USDC_USDC_PAIR = `cross:${TESTNET_STACK}:1/${TRON_STACK}:1`;

const withZeroFeeTestAuthorization = <T extends { wantAmount: bigint }>(offer: T): T & {
  maxFee: bigint;
  minNetReceive: bigint;
} => ({ maxFee: 0n, minNetReceive: offer.wantAmount, ...offer });

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
  const offers = (Array.isArray(input) ? input : [input]).map(withZeroFeeTestAuthorization);
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

  return {
    state: {
      leftEntity: firstOffer?.fromEntity ?? 'hub-entity',
      rightEntity: firstOffer?.toEntity ?? 'fixture-peer',
      domain: {
        chainId: 31337,
        depositoryAddress: '0x1111111111111111111111111111111111111111',
      },
      watchSeed: `0x${'11'.repeat(32)}`,
      deltas,
      locks: new Map(),
      swapOffers: new Map(offers.map((offer) => [offer.offerId, offer])),
      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
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
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: {
      fromEntity: firstOffer?.fromEntity ?? 'hub-entity',
      toEntity: firstOffer?.toEntity ?? 'fixture-peer',
      nextProofNonce: 0,
    },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
}

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
      fromEntity: 'hub-entity',
      toEntity: 'fixture-peer',
      accountId: 'fixture-peer',
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

describe('orderbook matching fallback execution mapping', () => {
  test('fails fast when matcher receives a raw unadmitted offer', () => {
    const rawOffer = {
      offerId: 'raw-offer',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 1,
      wantAmount: (1000n * SWAP_LOT_SCALE) / 10_000n,
      timeInForce: 0,
      priceTicks: 1000n,
    };
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', makeAccountMachine([])]]),
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
      ownerId: 'maker1',
      orderId: 'maker1:maker-ask-1',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker2',
      orderId: 'maker2:maker-ask-2',
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
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
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
      fromEntity: 'hub-entity',
      toEntity: 'maker1',
      accountId: 'maker1',
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
      fromEntity: 'hub-entity',
      toEntity: 'maker2',
      accountId: 'maker2',
      giveTokenId: 2,
      giveAmount: lot,
      wantTokenId: 5,
      wantAmount: (1100n * lot) / 10_000n,
      createdHeight: 1,
      timeInForce: 0,
      priceTicks: 1100n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker1', makeAccountMachine([makerOffer1])],
        ['maker2', makeAccountMachine([makerOffer2])],
        ['alice', makeAccountMachine([])],
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

    const result = processCommittedOrderbookSwaps(entityState, [swapOffer]);
    const op = result.accountTxs.find(item => item.accountId === 'alice' && item.tx.type === 'swap_resolve');

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
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: makerBaseQty,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine([makerOffer])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const makerResolve = result.accountTxs.find(
      item => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve',
    );
    const takerResolve = result.accountTxs.find(
      item => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve',
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
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: takerBaseQty,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const makerResolve = result.accountTxs.find(
      item => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve',
    );
    const takerResolve = result.accountTxs.find(
      item => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve',
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

    expect(getBookOrder(finalBook!, 'taker-account:taker-buy')).not.toBeNull();
  });

  test('allows a taker to sweep multiple resting price levels without requiring integral VWAP', () => {
    const lot = SWAP_LOT_SCALE;

    const makerAsk1 = {
      offerId: 'maker-ask-1',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-1',
      accountId: 'maker-account-1',
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
      fromEntity: 'hub-entity',
      toEntity: 'maker-2',
      accountId: 'maker-account-2',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: (3n * lot * 10_100n) / 10_000n,
      wantTokenId: 2,
      wantAmount: 3n * lot,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 10_100n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account-1', makeAccountMachine([])],
        ['maker-account-2', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerAsk1, makerAsk2, takerBuy] as any);
    const takerResolve = result.accountTxs.find(
      item => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve',
    );
    const makerResolve1 = result.accountTxs.find(
      item => item.accountId === 'maker-account-1' && item.tx.type === 'swap_resolve',
    );
    const makerResolve2 = result.accountTxs.find(
      item => item.accountId === 'maker-account-2' && item.tx.type === 'swap_resolve',
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
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'bob',
      accountId: 'bob-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice-taker-account',
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: takerBaseQty,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice-maker-account', makeAccountMachine([])],
        ['bob-maker-account', makeAccountMachine([])],
        ['alice-taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [selfMakerOffer, otherAskOffer, takerBuyOffer]);
    const takerResolve = result.accountTxs.find(
      item => item.accountId === 'alice-taker-account' && item.tx.type === 'swap_resolve',
    );
    const otherMakerResolve = result.accountTxs.find(
      item => item.accountId === 'bob-maker-account' && item.tx.type === 'swap_resolve',
    );
    const selfMakerResolve = result.accountTxs.find(
      item => item.accountId === 'alice-maker-account' && item.tx.type === 'swap_resolve',
    );

    expect(takerResolve).toBeDefined();
    expect(otherMakerResolve).toBeDefined();
    expect(selfMakerResolve).toBeUndefined();

    expect(takerResolve!.tx.data.cancelRemainder).toBe(true);
    expect(takerResolve!.tx.data.comment).toBe('STP:alice-maker-account:self-ask');
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
      fromEntity: 'hub-entity',
      toEntity: 'ask-maker',
      accountId: 'ask-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'bid-maker',
      accountId: 'bid-maker-account',
      giveTokenId: 5,
      giveAmount: (2n * lot * makerBidPriceTicks) / 10_000n,
      wantTokenId: 2,
      wantAmount: 2n * lot,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: makerBidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['ask-maker-account', makeAccountMachine([])],
        ['bid-maker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerAsk, restingBid]);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();

    expect(getBookOrder(finalBook!, 'bid-maker-account:resting-bid')?.priceTicks).toBe(makerBidPriceTicks);
  });

  test('uses midpoint band when both sides of the book exist for buys', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBid = {
      offerId: 'maker-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'bid-maker',
      accountId: 'bid-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'ask-maker',
      accountId: 'ask-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: (1400n * 2n * lot) / 10_000n,
      wantTokenId: 2,
      wantAmount: 2n * lot,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 1400n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['bid-maker-account', makeAccountMachine([])],
        ['ask-maker-account', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerBid, makerAsk, takerBuy]);
    const takerResolve = result.accountTxs.find(
      item =>
        item.accountId === 'taker-account' &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-buy-between-sides',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(false);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'taker-account:taker-buy-between-sides')).not.toBeNull();
  });

  test('uses midpoint band when both sides of the book exist for sells', () => {
    const lot = SWAP_LOT_SCALE;
    const makerBid = {
      offerId: 'maker-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'bid-maker',
      accountId: 'bid-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'ask-maker',
      accountId: 'ask-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 2,
      giveAmount: 2n * lot,
      wantTokenId: 5,
      wantAmount: (800n * 2n * lot) / 10_000n,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 800n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['bid-maker-account', makeAccountMachine([])],
        ['ask-maker-account', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerBid, makerAsk, takerSell]);
    const takerResolve = result.accountTxs.find(
      item =>
        item.accountId === 'taker-account' &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-sell-between-sides',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(false);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'taker-account:taker-sell-between-sides')).not.toBeNull();
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
      ownerId: 'maker',
      orderId: 'maker-account:maker-ask-historical',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1n,
    }).state;

    const takerOffer = {
      offerId: 'taker-buy-restored-book',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: (1250n * 2n * lot) / 10_000n,
      wantTokenId: 2,
      wantAmount: 2n * lot,
      createdHeight: 3,
      timeInForce: 0,
      priceTicks: 1250n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'maker-account',
          {
            ...makeAccountMachine([]),
            state: {
              ...makeAccountMachine([]).state,
              leftEntity: 'hub-entity',
              rightEntity: 'maker',
              swapOffers: new Map([
                [
                  'maker-ask-historical',
                  {
                    offerId: 'maker-ask-historical',
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
        ['taker-account', makeAccountMachine([])],
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
        books: new Map([['2/5', historicalBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [takerOffer]);
    const makerResolve = result.accountTxs.find(
      item =>
        item.accountId === 'maker-account' &&
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

    const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
    expect(resolveResult.success).toBe(false);
    expect(resolveResult.error).toContain('Resting swap terms mismatch');
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
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
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
      entityId: 'hub-entity',
      accounts: new Map([['alice', makeAccountMachine(hugePriceOffer)]]),
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [hugePriceOffer] as any);
    const book = result.bookUpdates.find(item => item.pairId === '2/5')?.book;

    expect(result.accountTxs.some((item: any) => item.tx?.type === 'swap_resolve')).toBe(false);
    expect(book).toBeDefined();
    expect(getBookOrder(book!, 'alice:maker-huge-price')?.priceTicks).toBe(hugePriceTicks);
  });

  test('charges 1bp taker fee in the taker received asset without changing gross execution', async () => {
    const lot = SWAP_LOT_SCALE;
    const makerBaseQty = lot;
    const makerPriceTicks = 1000n;
    const makerQuoteQty = (makerBaseQty * makerPriceTicks) / 10_000n;

    const takerOffer = {
      offerId: 'taker-buy-with-fee',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
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
      entityId: 'hub-entity',
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
        ['maker-account', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any);

    const makerOffer = {
      offerId: 'maker-ask-fee',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
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
      item => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve',
    )).toBe(false);
    expect(unauthorized.accountTxs).toContainEqual(expect.objectContaining({
      accountId: 'taker-account',
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
        item.accountId === 'taker-account' &&
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
      item => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve',
    );
    const improvedTakerResolve = improved.accountTxs.find(
      item =>
        item.accountId === 'taker-account' &&
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
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
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
      item => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve',
    );
    const improvedSellTakerResolve = improvedSell.accountTxs.find(
      item =>
        item.accountId === 'taker-account' &&
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
    const resolveResult = await handleSwapResolve(
      accountMachine,
      takerResolve!.tx as Extract<AccountTx, { type: 'swap_resolve' }>,
      true,
      1,
    );

    expect(resolveResult.success).toBe(true);
    const quoteDelta = accountMachine.state.deltas.get(5)!;
    const baseDelta = accountMachine.state.deltas.get(2)!;
    expect(quoteDelta.offdelta).toBe(makerQuoteQty);
    expect(baseDelta.offdelta).toBe(-(makerBaseQty - makerBaseQty / 10_000n));
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

    const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
    expect(resolveResult.success).toBe(true);

    const remaining = accountMachine.state.swapOffers.get('maker-partial');
    expect(remaining).toBeDefined();
    expect(remaining!.priceTicks).toBe(1000n);
    expect(remaining!.giveAmount).toBe(lot);
    expect(remaining!.wantAmount).toBe((1000n * lot) / 10_000n);
    expect(remaining!.quantizedGive).toBe(lot);
    expect(remaining!.quantizedWant).toBe((1000n * lot) / 10_000n);
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

      const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
      expect(resolveResult.success).toBe(false);
      expect(resolveResult.error).toContain('missing canonical price or quantized amounts');
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

    const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
    expect(resolveResult.success).toBe(false);
    expect(resolveResult.error).toContain('Resting swap terms mismatch live offer');
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
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 5,
      giveAmount: takerQuoteQty,
      wantTokenId: 2,
      wantAmount: takerBaseQty,
      createdHeight: 2,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const cancelOp = result.accountTxs.find(
      item =>
        item.accountId === 'taker-account' &&
        item.tx.type === 'swap_resolve' &&
        item.tx.data.offerId === 'taker-buy-too-high',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;

    expect(cancelOp).toBeDefined();
    expect(cancelOp!.tx.data.fillRatio).toBe(0);
    expect(cancelOp!.tx.data.cancelRemainder).toBe(true);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'taker-account:taker-buy-too-high')).toBeNull();
  });

  test('sweeps far resting orders outside the pair band before matching new flow', () => {
    const lot = SWAP_LOT_SCALE;
    const nearAskPriceTicks = 25_000_000n;
    const farAskPriceTicks = 40_000_000n;
    const bidPriceTicks = 24_900_000n;

    const nearAskOffer = {
      offerId: 'near-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'near-maker',
      accountId: 'near-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'far-maker',
      accountId: 'far-maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      createdHeight: 3,
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
        ['near-maker-account', makeAccountMachine([nearAskOffer])],
        ['far-maker-account', makeAccountMachine([farAskOffer])],
        ['taker-account', makeAccountMachine([])],
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
        books: new Map([
          [
            '1/2',
            (() => {
              let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
              book = applyCommand(book, {
                kind: 0,
                ownerId: 'near-maker',
                orderId: 'near-maker-account:near-ask',
                side: 1,
                tif: 0,
                postOnly: false,
                priceTicks: nearAskPriceTicks,
                qtyLots: 1n,
              }).state;
              book = applyCommand(book, {
                kind: 0,
                ownerId: 'far-maker',
                orderId: 'far-maker-account:far-ask',
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
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processCommittedOrderbookSwaps(entityState, [incomingBidOffer] as any);
    const farCancel = result.accountTxs.find(
      item =>
        item.accountId === 'far-maker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'far-ask',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;

    expect(farCancel).toBeDefined();
    expect(farCancel!.tx.data.fillRatio).toBe(0);
    expect(farCancel!.tx.data.cancelRemainder).toBe(true);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'far-maker-account:far-ask')).toBeNull();
    expect(getBookOrder(finalBook!, 'near-maker-account:near-ask')).not.toBeNull();
    expect(getBookOrder(finalBook!, 'taker-account:fresh-bid')).not.toBeNull();
  });

  test('does not enqueue duplicate fail-closed cancel when the same offer is already pending in mempool or pendingFrame', () => {
    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: true,
      fromEntity: 'maker-entity',
      toEntity: 'hub-entity',
      accountId: 'maker-account',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
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
    takerAccount.leftEntity = 'taker-entity';
    takerAccount.rightEntity = 'hub-entity';
    takerAccount.proofHeader = { fromEntity: 'taker-entity', toEntity: 'hub-entity', nextProofNonce: 0 };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine(makerOffer)],
        ['taker-account', takerAccount],
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
        books: new Map(),
        pairConfig: new Map(),
      },
    } as any;

    const firstPass = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(firstPass.accountTxs).toHaveLength(1);
    expect(firstPass.accountTxs[0]?.accountId).toBe('taker-account');
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
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', makeAccountIndex(['offer-a'])],
        ['bob', makeAccountIndex(['offer-b'])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const offers = [
      {
        offerId: 'offer-b',
        makerIsLeft: false,
        fromEntity: 'hub-entity',
        toEntity: 'bob',
        accountId: 'bob',
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
        fromEntity: 'hub-entity',
        toEntity: 'alice',
        accountId: 'alice',
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
    expect(getBookSideLevels(finalBook!, 1, 1)[0]?.orderIds[0]).toBe('alice:offer-a');
  });

  test('debug projection rebuild reports crossed offers without emitting swap_resolve side effects', () => {
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', makeAccountIndex(['offer-a'])],
        ['bob', makeAccountIndex(['offer-b'])],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const offers = [
      {
        offerId: 'offer-a',
        makerIsLeft: false,
        fromEntity: 'hub-entity',
        toEntity: 'alice',
        accountId: 'alice',
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
        fromEntity: 'hub-entity',
        toEntity: 'bob',
        accountId: 'bob',
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
    expect(result.debugProjectionRejects.map(offer => `${offer.accountId}:${offer.offerId}`)).toEqual(['bob:offer-b']);
    expect(result.debugProjectionRejects[0]?.reason).toBe('post-only-reject:postOnly would cross');
    expect(entityState.orderbookExt.books.size).toBe(0);
  });

  test('preserves exact aligned price when creating an exact book', () => {
    const priceTicks = 24_999_992n;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', makeAccountIndex(['offer-a'])]]),
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

    const offer = {
      offerId: 'offer-a',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
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

    expect(getBookOrder(finalBook!, 'alice:offer-a')?.priceTicks).toBe(priceTicks);
  });

  test('keeps wide exact prices in the pair book without widening or snapping', () => {
    const anchorPriceTicks = 25_015_002n;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        [
          'alice',
          makeAccountIndex(['offer-a', 'offer-b', 'offer-c']),
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
          supportedPairs: ['1/2'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const makeOffer = (offerId: string, priceTicks: bigint, size: bigint) => ({
      offerId,
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      createdHeight: 1,
      giveTokenId: 2,
      giveAmount: size,
      wantTokenId: 1,
      wantAmount: (size * priceTicks) / 10_000n,
      timeInForce: 0,
      priceTicks,
    });

    const offers = [
      makeOffer('offer-a', anchorPriceTicks, 210n * SWAP_LOT_SCALE),
      makeOffer('offer-b', 25_137_562n, 600n * SWAP_LOT_SCALE),
      makeOffer('offer-c', 25_262_625n, 960n * SWAP_LOT_SCALE),
    ];
    entityState.accounts.get('alice')!.swapOffers = new Map(offers.map(offer => [offer.offerId, offer]));

    const result = processCommittedOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(finalBook!.params.bucketWidthTicks).toBe(10_000n);
    expect(getBookOrder(finalBook!, 'alice:offer-a')?.priceTicks).toBe(anchorPriceTicks);
    expect(getBookOrder(finalBook!, 'alice:offer-b')?.priceTicks).toBe(25_137_562n);
    expect(getBookOrder(finalBook!, 'alice:offer-c')?.priceTicks).toBe(25_262_625n);
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
      ownerId: 'maker-entity',
      orderId: 'maker-account:maker-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 24_999_998n,
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
        ['maker-account', makeAccountMachine([makerOffer])],
        ['taker-account', makeAccountMachine([])],
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
      ownerId: 'maker-entity',
      orderId: 'maker-account:maker-cross',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;

    const route = {
      orderId: 'taker-cross',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'taker-entity',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
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
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
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
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine([])],
        ['taker-account', makeAccountMachine([takerOffer])],
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
    const namespacedOrderId = 'maker-account:maker-cross-partial';
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
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
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
      entityId: 'hub-entity',
      accounts: new Map([['maker-account', makeAccountMachine([offer])]]),
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
    const makerOrderId = 'maker-account:maker-cross-partial-live';
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
      qtyLots: 40_000n,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-partial-live',
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
    const takerRoute = {
      ...makerRoute,
      orderId: 'taker-cross-partial-live',
      makerEntityId: 'taker-entity',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: fillTarget,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: fillSource,
      },
    };
    const makerOffer = {
      offerId: 'maker-cross-partial-live',
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
    const takerOffer = {
      offerId: 'taker-cross-partial-live',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
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
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine([makerOffer])],
        ['taker-account', makeAccountMachine([takerOffer])],
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

    const result = processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    const makerAck = result.accountTxs.find(
      op => op.accountId === 'maker-account' && op.tx.type === 'cross_swap_fill_ack',
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
    const makerOrderId = 'maker-account:maker-cross-tiny-fill';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker-entity',
      orderId: makerOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: ORDERBOOK_PRICE_SCALE,
      qtyLots: makerQtyLots,
    }).state;

    const makerRoute = {
      orderId: 'maker-cross-tiny-fill',
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
      makerEntityId: 'taker-entity',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: fillTarget,
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'taker-entity',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: fillSource,
      },
      status: 'resting',
      cumulativeFillRatio: undefined,
    };
    const makerOffer = {
      offerId: 'maker-cross-tiny-fill',
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
      priceTicks: ORDERBOOK_PRICE_SCALE,
      crossJurisdiction: makerRoute,
    };
    const takerOffer = {
      offerId: 'taker-cross-tiny-fill',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
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
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', makeAccountMachine([makerOffer])],
        ['taker-account', makeAccountMachine([takerOffer])],
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

    expect(() => processCommittedOrderbookSwaps(entityState, [makerOffer, takerOffer] as any)).toThrow(
      'CROSS_J_EXACT_FILL_RATIO_REQUIRED',
    );
    expect(getBookOrder(book, makerOrderId)?.qtyLots).toBe(makerQtyLots);
  });

  test('removes non-working cross-j committed routes before matching new takers', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const staleOrderId = 'old-maker:old-cross';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'old-maker',
      orderId: staleOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 1n,
    }).state;

    const staleRoute = {
      orderId: 'old-cross',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'old-maker',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'old-maker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'old-maker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      status: 'clearing',
      createdAt: 1,
      updatedAt: 2,
    };
    const takerRoute = {
      ...staleRoute,
      orderId: 'new-taker',
      makerEntityId: 'new-taker',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'new-taker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'new-taker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: lot,
      },
      status: 'resting',
    };
    const takerOffer = {
      offerId: 'new-taker',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'new-taker',
      accountId: 'new-taker-account',
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
      entityId: 'hub-entity',
      accounts: new Map([['new-taker-account', makeAccountMachine([takerOffer])]]),
      crossJurisdictionSwaps: new Map([['old-cross', staleRoute]]),
      crossJurisdictionBookAdmissions: new Map([
        [
          'old-maker:old-cross',
          {
            orderId: 'old-cross',
            routeHash: 'hash',
            sourceEntityId: 'old-maker',
            bookOwnerEntityId: 'hub-entity',
            status: 'admitted',
            route: { ...staleRoute, status: 'resting' },
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

    expect(result.crossJurisdictionFills).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    expect(getBookOrder(book, staleOrderId)).toBeNull();
  });

  test('removes terminal admitted cross-j rows even when stale mirrors still look resting', () => {
    const lot = SWAP_LOT_SCALE;
    const pairId = CROSS_WETH_USDC_PAIR;
    const staleOrderId = 'old-maker:old-cross';
    let book = createBook({
      bucketWidthTicks: 10_000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'old-maker',
      orderId: staleOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 1n,
    }).state;

    const staleRoute = {
      orderId: 'old-cross',
      bookOwnerEntityId: 'hub-entity',
      venueId: pairId,
      makerEntityId: 'old-maker',
      hubEntityId: 'hub-entity',
      source: {
        jurisdiction: TESTNET_STACK,
        entityId: 'old-maker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: lot,
      },
      target: {
        jurisdiction: TRON_STACK,
        entityId: 'old-maker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      status: 'resting',
      createdAt: 1,
      updatedAt: 2,
    };
    const makerOffer = {
      offerId: 'old-cross',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'old-maker',
      accountId: 'old-maker',
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
      makerEntityId: 'new-taker',
      source: {
        jurisdiction: TRON_STACK,
        entityId: 'new-taker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 1,
        amount: quoteAmountAtPrice(2, 1, lot, 25_000_000n),
      },
      target: {
        jurisdiction: TESTNET_STACK,
        entityId: 'new-taker',
        counterpartyEntityId: 'hub-entity',
        tokenId: 2,
        amount: lot,
      },
    };
    const takerOffer = {
      offerId: 'new-taker',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'new-taker',
      accountId: 'new-taker-account',
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
      entityId: 'hub-entity',
      accounts: new Map([
        ['old-maker', makeAccountMachine([makerOffer])],
        ['new-taker-account', makeAccountMachine([takerOffer])],
      ]),
      crossJurisdictionSwaps: new Map([['old-cross', staleRoute]]),
      crossJurisdictionBookAdmissions: new Map([
        [
          'old-maker:old-cross',
          {
            orderId: 'old-cross',
            routeHash: 'hash',
            sourceEntityId: 'old-maker',
            bookOwnerEntityId: 'hub-entity',
            status: 'closed',
            route: staleRoute,
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
    expect(getBookOrder(book, staleOrderId)).toBeNull();
  });
});
