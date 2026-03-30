import { describe, expect, test } from 'bun:test';
import { createBook, applyCommand, getBestAsk, getBestBid, getBookOrder, getBookSideLevels } from '../orderbook/core';
import { SWAP_LOT_SCALE } from '../orderbook/types';
import { processOrderbookCancels, processOrderbookSwaps } from '../entity-tx/handlers/account';
import { handleSwapResolve } from '../account-tx/handlers/swap-resolve';
import { deriveCanonicalSwapFillRatio } from '../swap-execution';
import type { AccountMachine, AccountTx, SwapOffer } from '../types';
import { createDefaultDelta } from '../validation-utils';

function makeAccountMachine(offer: SwapOffer): AccountMachine {
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
      tokenIds: [],
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
    proofHeader: { fromEntity: 'maker', toEntity: 'hub', nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
  };
}

describe('orderbook matching fallback execution mapping', () => {
  test('generates execution amounts even when account state does not contain the offer yet', () => {
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
      qtyLots: 1,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker2',
      orderId: 'maker2:maker-ask-2',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1100n,
      qtyLots: 1,
    }).state;

    const lot = SWAP_LOT_SCALE;
    const baseQty = 2n * lot;
    const quoteAmount = 1100n * baseQty / 10_000n;

    const swapOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice',
      giveTokenId: 6,
      giveAmount: quoteAmount,
      wantTokenId: 4,
      wantAmount: baseQty,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1100n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker1', { swapOffers: new Map() }],
        ['maker2', { swapOffers: new Map() }],
        ['alice', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map([['4/6', book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [swapOffer]);
    const op = result.mempoolOps.find((item) => item.accountId === 'alice' && item.tx.type === 'swap_resolve');

    expect(op).toBeDefined();
    expect(op!.tx.data.fillRatio).toBe(deriveCanonicalSwapFillRatio(quoteAmount, 210_000_000_000n));
    expect(op!.tx.data.executionGiveAmount).toBe(210_000_000_000n);
    expect(op!.tx.data.executionWantAmount).toBe(baseQty);
  });

  test('synthesizes missing maker execution from book-side state instead of reusing the taker offer', () => {
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
      giveTokenId: 4,
      giveAmount: makerBaseQty,
      wantTokenId: 6,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const takerOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: takerQuoteQty,
      wantTokenId: 4,
      wantAmount: makerBaseQty,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const makerResolve = result.mempoolOps.find((item) => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve');
    const takerResolve = result.mempoolOps.find((item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve');

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
      giveTokenId: 4,
      giveAmount: makerBaseQty,
      wantTokenId: 6,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const takerOffer = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: takerQuoteQty,
      wantTokenId: 4,
      wantAmount: takerBaseQty,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const makerResolve = result.mempoolOps.find((item) => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve');
    const takerResolve = result.mempoolOps.find((item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve');
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
      giveTokenId: 4,
      giveAmount: 2n * lot,
      wantTokenId: 6,
      wantAmount: (2n * lot * 10_000n) / 10_000n,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 10_000n,
    };

    const makerAsk2 = {
      offerId: 'maker-ask-2',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-2',
      accountId: 'maker-account-2',
      giveTokenId: 4,
      giveAmount: lot,
      wantTokenId: 6,
      wantAmount: (lot * 10_100n) / 10_000n,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 10_100n,
    };

    const takerBuy = {
      offerId: 'taker-buy',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: (3n * lot * 10_100n) / 10_000n,
      wantTokenId: 4,
      wantAmount: 3n * lot,
      createdHeight: 3,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 10_100n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account-1', { swapOffers: new Map() }],
        ['maker-account-2', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerAsk1, makerAsk2, takerBuy] as any);
    const takerResolve = result.mempoolOps.find((item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve');
    const makerResolve1 = result.mempoolOps.find((item) => item.accountId === 'maker-account-1' && item.tx.type === 'swap_resolve');
    const makerResolve2 = result.mempoolOps.find((item) => item.accountId === 'maker-account-2' && item.tx.type === 'swap_resolve');

    const executionQuoteWei = (30_100n * lot) / 10_000n;

    expect(takerResolve).toBeDefined();
    expect(makerResolve1).toBeDefined();
    expect(makerResolve2).toBeDefined();
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(executionQuoteWei);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(3n * lot);
    expect(takerResolve!.tx.data.fillRatio).toBe(
      deriveCanonicalSwapFillRatio(takerBuy.giveAmount, executionQuoteWei),
    );
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
      giveTokenId: 4,
      giveAmount: selfAskBaseQty,
      wantTokenId: 6,
      wantAmount: selfAskQuoteQty,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: selfAskPriceTicks,
    };

    const otherAskOffer = {
      offerId: 'other-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'bob',
      accountId: 'bob-maker-account',
      giveTokenId: 4,
      giveAmount: otherAskBaseQty,
      wantTokenId: 6,
      wantAmount: otherAskQuoteQty,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: otherAskPriceTicks,
    };

    const takerBuyOffer = {
      offerId: 'alice-buy',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'alice',
      accountId: 'alice-taker-account',
      giveTokenId: 6,
      giveAmount: takerQuoteQty,
      wantTokenId: 4,
      wantAmount: takerBaseQty,
      createdHeight: 3,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice-maker-account', { swapOffers: new Map() }],
        ['bob-maker-account', { swapOffers: new Map() }],
        ['alice-taker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [selfMakerOffer, otherAskOffer, takerBuyOffer]);
    const takerResolve = result.mempoolOps.find((item) => item.accountId === 'alice-taker-account' && item.tx.type === 'swap_resolve');
    const otherMakerResolve = result.mempoolOps.find((item) => item.accountId === 'bob-maker-account' && item.tx.type === 'swap_resolve');
    const selfMakerResolve = result.mempoolOps.find((item) => item.accountId === 'alice-maker-account' && item.tx.type === 'swap_resolve');

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
      giveTokenId: 4,
      giveAmount: 3n * lot,
      wantTokenId: 6,
      wantAmount: (3n * lot * makerAskPriceTicks) / 10_000n,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerAskPriceTicks,
    };

    const restingBid = {
      offerId: 'resting-bid',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'bid-maker',
      accountId: 'bid-maker-account',
      giveTokenId: 6,
      giveAmount: (2n * lot * makerBidPriceTicks) / 10_000n,
      wantTokenId: 4,
      wantAmount: 2n * lot,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerBidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['ask-maker-account', { swapOffers: new Map() }],
        ['bid-maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerAsk, restingBid]);
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
      giveTokenId: 6,
      giveAmount: 1000n * lot / 10_000n,
      wantTokenId: 4,
      wantAmount: lot,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const makerAsk = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'ask-maker',
      accountId: 'ask-maker-account',
      giveTokenId: 4,
      giveAmount: lot,
      wantTokenId: 6,
      wantAmount: 1200n * lot / 10_000n,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1200n,
    };

    const takerBuy = {
      offerId: 'taker-buy-between-sides',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: (1400n * 2n * lot) / 10_000n,
      wantTokenId: 4,
      wantAmount: 2n * lot,
      createdHeight: 3,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1400n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['bid-maker-account', { swapOffers: new Map() }],
        ['ask-maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerBid, makerAsk, takerBuy]);
    const takerResolve = result.mempoolOps.find(
      (item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'taker-buy-between-sides',
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
      giveTokenId: 6,
      giveAmount: 1000n * lot / 10_000n,
      wantTokenId: 4,
      wantAmount: lot,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const makerAsk = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'ask-maker',
      accountId: 'ask-maker-account',
      giveTokenId: 4,
      giveAmount: lot,
      wantTokenId: 6,
      wantAmount: 1200n * lot / 10_000n,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1200n,
    };

    const takerSell = {
      offerId: 'taker-sell-between-sides',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 4,
      giveAmount: 2n * lot,
      wantTokenId: 6,
      wantAmount: (800n * 2n * lot) / 10_000n,
      createdHeight: 3,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 800n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['bid-maker-account', { swapOffers: new Map() }],
        ['ask-maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerBid, makerAsk, takerSell]);
    const takerResolve = result.mempoolOps.find(
      (item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'taker-sell-between-sides',
    );
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(false);
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'taker-account:taker-sell-between-sides')).not.toBeNull();
  });

  test('rebuilds a cached pair from canonical live offers before matching historical resting orders', () => {
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
      qtyLots: 1,
    }).state;

    const takerOffer = {
      offerId: 'taker-buy-rebuild',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: (1250n * 2n * lot) / 10_000n,
      wantTokenId: 4,
      wantAmount: 2n * lot,
      createdHeight: 3,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1250n,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', {
          leftEntity: 'hub-entity',
          rightEntity: 'maker',
          swapOffers: new Map([[
            'maker-ask-historical',
            {
              offerId: 'maker-ask-historical',
              giveTokenId: 4,
              giveAmount: lot,
              wantTokenId: 6,
              wantAmount: 1000n * lot / 10_000n,
              makerIsLeft: false,
              minFillRatio: 0,
              createdHeight: 1,
              priceTicks: 1000n,
              quantizedGive: lot,
              quantizedWant: 1000n * lot / 10_000n,
            },
          ]]),
        }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map([['4/6', historicalBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [takerOffer]);
    const makerResolve = result.mempoolOps.find(
      (item) => item.accountId === 'maker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'maker-ask-historical',
    );

    expect(makerResolve).toBeDefined();
    expect(makerResolve!.tx.data.executionGiveAmount).toBe(lot);
    expect(makerResolve!.tx.data.executionWantAmount).toBe(1000n * lot / 10_000n);
  });

  test('passes canonical resting offer state into swap_resolve for snapped resting makers', async () => {
    const lot = SWAP_LOT_SCALE;
    const makerOffer = {
      offerId: 'maker-snapped',
      makerIsLeft: true,
      giveTokenId: 4,
      giveAmount: 2n * lot,
      wantTokenId: 6,
      wantAmount: (2006n * lot) / 10_000n,
      minFillRatio: 0,
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
        executionWantAmount: 1000n * lot / 10_000n,
        restingPriceTicks: 1000n,
        restingGiveAmount: 2n * lot,
        restingWantAmount: (2000n * lot) / 10_000n,
        restingQuantizedGive: 2n * lot,
        restingQuantizedWant: (2000n * lot) / 10_000n,
      },
    };

    const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
    expect(resolveResult.success).toBe(true);
    const remaining = accountMachine.swapOffers.get('maker-snapped');
    expect(remaining).toBeDefined();
    expect(remaining!.priceTicks).toBe(1000n);
    expect(remaining!.giveAmount).toBe(lot);
    expect(remaining!.wantAmount).toBe(1000n * lot / 10_000n);
    expect(remaining!.quantizedGive).toBe(lot);
    expect(remaining!.quantizedWant).toBe(1000n * lot / 10_000n);
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
      giveTokenId: 4,
      giveAmount: lot,
      wantTokenId: 6,
      wantAmount: hugePriceTicks * lot / 10_000n,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: hugePriceTicks,
      quantizedGive: lot,
      quantizedWant: hugePriceTicks * lot / 10_000n,
    } satisfies SwapOffer;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', makeAccountMachine(hugePriceOffer)],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [hugePriceOffer] as any);
    const book = result.bookUpdates.find((item) => item.pairId === '4/6')?.book;

    expect(result.mempoolOps.some((item: any) => item.tx?.type === 'swap_resolve')).toBe(false);
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
      giveTokenId: 6,
      giveAmount: makerQuoteQty,
      wantTokenId: 4,
      wantAmount: makerBaseQty,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      hubRebalanceConfig: {
        matchingStrategy: 'amount',
        policyVersion: 1,
        routingFeePPM: 1,
        baseFee: 0n,
        swapTakerFeeBps: 1,
        rebalanceBaseFee: 10n ** 17n,
        rebalanceLiquidityFeeBps: 1n,
        rebalanceGasFee: 0n,
        rebalanceTimeoutMs: 10 * 60 * 1000,
      },
      accounts: new Map([
        ['maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const makerOffer = {
      offerId: 'maker-ask-fee',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      giveTokenId: 4,
      giveAmount: makerBaseQty,
      wantTokenId: 6,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const result = processOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const takerResolve = result.mempoolOps.find(
      (item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'taker-buy-with-fee',
    );

    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.executionGiveAmount).toBe(makerQuoteQty);
    expect(takerResolve!.tx.data.executionWantAmount).toBe(makerBaseQty);
    expect(takerResolve!.tx.data.feeTokenId).toBe(4);
    expect(takerResolve!.tx.data.feeAmount).toBe(makerBaseQty / 10_000n);

    const accountMachine = makeAccountMachine({
      offerId: 'taker-buy-with-fee',
      makerIsLeft: false,
      giveTokenId: 6,
      giveAmount: makerQuoteQty,
      wantTokenId: 4,
      wantAmount: makerBaseQty,
      minFillRatio: 0,
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
    const quoteDelta = accountMachine.deltas.get(6)!;
    const baseDelta = accountMachine.deltas.get(4)!;
    expect(quoteDelta.offdelta).toBe(makerQuoteQty);
    expect(baseDelta.offdelta).toBe(-(makerBaseQty - (makerBaseQty / 10_000n)));
  });

  test('recomputes canonical priceTicks for partial fills when legacy offer price is missing', async () => {
    const lot = SWAP_LOT_SCALE;
    const accountMachine = makeAccountMachine({
      offerId: 'maker-legacy-no-price',
      makerIsLeft: true,
      giveTokenId: 4,
      giveAmount: 2n * lot,
      wantTokenId: 6,
      wantAmount: (2000n * lot) / 10_000n,
      minFillRatio: 0,
      createdHeight: 1,
      quantizedGive: 2n * lot,
      quantizedWant: (2000n * lot) / 10_000n,
    } satisfies SwapOffer);
    const accountTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'maker-legacy-no-price',
        fillRatio: 32768,
        cancelRemainder: false,
        executionGiveAmount: lot,
        executionWantAmount: (1000n * lot) / 10_000n,
      },
    };

    const resolveResult = await handleSwapResolve(accountMachine, accountTx, false, 1);
    expect(resolveResult.success).toBe(true);

    const remaining = accountMachine.swapOffers.get('maker-legacy-no-price');
    expect(remaining).toBeDefined();
    expect(remaining!.priceTicks).toBe(1000n);
    expect(remaining!.giveAmount).toBe(lot);
    expect(remaining!.wantAmount).toBe((1000n * lot) / 10_000n);
    expect(remaining!.quantizedGive).toBe(lot);
    expect(remaining!.quantizedWant).toBe((1000n * lot) / 10_000n);
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
      giveTokenId: 4,
      giveAmount: makerBaseQty,
      wantTokenId: 6,
      wantAmount: makerQuoteQty,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: makerPriceTicks,
    };

    const takerOffer = {
      offerId: 'taker-buy-too-high',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: takerQuoteQty,
      wantTokenId: 4,
      wantAmount: takerBaseQty,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: takerPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [makerOffer, takerOffer]);
    const cancelOp = result.mempoolOps.find(
      (item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'taker-buy-too-high',
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
      minFillRatio: 0,
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
      minFillRatio: 0,
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['near-maker-account', { swapOffers: new Map([['near-ask', nearAskOffer]]) }],
        ['far-maker-account', { swapOffers: new Map([['far-ask', farAskOffer]]) }],
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
        books: new Map(),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [incomingBidOffer] as any);
    const farCancel = result.mempoolOps.find(
      (item) => item.accountId === 'far-maker-account' && item.tx.type === 'swap_resolve' && item.tx.data.offerId === 'far-ask',
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
      giveTokenId: 4,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 6,
      wantAmount: 1000n * SWAP_LOT_SCALE / 10_000n,
      createdHeight: 1,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1000n,
      quantizedGive: SWAP_LOT_SCALE,
      quantizedWant: 1000n * SWAP_LOT_SCALE / 10_000n,
    } satisfies SwapOffer;

    const takerOffer = {
      offerId: 'taker-buy-too-high',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker-entity',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: 1400n * SWAP_LOT_SCALE / 10_000n,
      wantTokenId: 4,
      wantAmount: SWAP_LOT_SCALE,
      createdHeight: 2,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1400n,
      quantizedGive: 1400n * SWAP_LOT_SCALE / 10_000n,
      quantizedWant: SWAP_LOT_SCALE,
    } satisfies SwapOffer;

    const takerAccount = makeAccountMachine(takerOffer);
    takerAccount.leftEntity = 'taker-entity';
    takerAccount.rightEntity = 'hub-entity';
    takerAccount.proofHeader = { fromEntity: 'taker-entity', toEntity: 'hub-entity', nonce: 0 };

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
          supportedPairs: ['4/6'],
        },
        books: new Map(),
        pairConfig: new Map(),
      },
      pendingSwapFillRatios: new Map(),
    } as any;

    const firstPass = processOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(firstPass.mempoolOps).toHaveLength(1);
    expect(firstPass.mempoolOps[0]?.accountId).toBe('taker-account');
    expect(firstPass.mempoolOps[0]?.tx.type).toBe('swap_resolve');
    expect(firstPass.mempoolOps[0]?.tx.data.offerId).toBe('taker-buy-too-high');
    expect(firstPass.mempoolOps[0]?.tx.data.cancelRemainder).toBe(true);

    takerAccount.mempool.push(firstPass.mempoolOps[0]!.tx as AccountTx);
    const secondPass = processOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(secondPass.mempoolOps).toHaveLength(0);

    takerAccount.mempool = [];
    takerAccount.pendingFrame = {
      height: 1,
      timestamp: 1,
      jHeight: 0,
      accountTxs: [firstPass.mempoolOps[0]!.tx as AccountTx],
      prevFrameHash: '',
      tokenIds: [],
      deltas: [],
      stateHash: '',
      byLeft: true,
    };
    const thirdPass = processOrderbookSwaps(entityState, [makerOffer, takerOffer] as any);
    expect(thirdPass.mempoolOps).toHaveLength(0);
  });

  test('sorts live offers canonically before inserting into the book', () => {
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', { swapOffers: new Map([['offer-a', {}]]) }],
        ['bob', { swapOffers: new Map([['offer-b', {}]]) }],
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
          supportedPairs: ['4/6'],
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
        giveTokenId: 4,
        giveAmount: SWAP_LOT_SCALE,
        wantTokenId: 6,
        wantAmount: 1000n * SWAP_LOT_SCALE / 10_000n,
        minFillRatio: 0,
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
        giveTokenId: 4,
        giveAmount: SWAP_LOT_SCALE,
        wantTokenId: 6,
        wantAmount: 1000n * SWAP_LOT_SCALE / 10_000n,
        minFillRatio: 0,
        timeInForce: 0,
        priceTicks: 1000n,
      },
    ];

    const result = processOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBestAsk(finalBook!)).toBe(1000n);
    expect(getBookSideLevels(finalBook!, 1, 1)[0]?.orderIds[0]).toBe('alice:offer-a');
  });

  test('rehydrate inserts open offers into an exact pair book without emitting swap_resolve side effects', () => {
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', { swapOffers: new Map([['offer-a', {}]]) }],
        ['bob', { swapOffers: new Map([['offer-b', {}]]) }],
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
          supportedPairs: ['4/6'],
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
        giveTokenId: 4,
        giveAmount: SWAP_LOT_SCALE,
        wantTokenId: 6,
        wantAmount: 1000n * SWAP_LOT_SCALE / 10_000n,
        minFillRatio: 0,
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
        giveTokenId: 6,
        giveAmount: 1000n * SWAP_LOT_SCALE / 10_000n,
        wantTokenId: 4,
        wantAmount: SWAP_LOT_SCALE,
        minFillRatio: 0,
        timeInForce: 0,
        priceTicks: 1000n,
      },
    ];

    const result = processOrderbookSwaps(entityState, offers as any, { rehydrateOnly: true });
    expect(result.mempoolOps).toHaveLength(0);
    expect(result.bookUpdates.length).toBeGreaterThan(0);
  });

  test('preserves exact aligned price when creating an exact book', () => {
    const priceTicks = 24_999_992n;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', { swapOffers: new Map([['offer-a', {}]]) }],
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks,
    };

    const result = processOrderbookSwaps(entityState, [offer] as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();

    expect(getBookOrder(finalBook!, 'alice:offer-a')?.priceTicks).toBe(priceTicks);
  });

  test('keeps wide exact prices in the pair book without widening or snapping', () => {
    const anchorPriceTicks = 25_015_002n;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', { swapOffers: new Map([['offer-a', {}], ['offer-b', {}], ['offer-c', {}]]) }],
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks,
    });

    const offers = [
      makeOffer('offer-a', anchorPriceTicks, 210n * SWAP_LOT_SCALE),
      makeOffer('offer-b', 25_137_562n, 600n * SWAP_LOT_SCALE),
      makeOffer('offer-c', 25_262_625n, 960n * SWAP_LOT_SCALE),
    ];
    entityState.accounts.get('alice')!.swapOffers = new Map(offers.map((offer) => [offer.offerId, offer]));

    const result = processOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(finalBook!.params.bucketWidthTicks).toBe(10_000n);
    expect(getBookOrder(finalBook!, 'alice:offer-a')?.priceTicks).toBe(anchorPriceTicks);
    expect(getBookOrder(finalBook!, 'alice:offer-b')?.priceTicks).toBe(25_137_562n);
    expect(getBookOrder(finalBook!, 'alice:offer-c')?.priceTicks).toBe(25_262_625n);
  });

  test('rebuilds stale persisted pair books from canonical live offers before matching', () => {
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
      qtyLots: 1,
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
      minFillRatio: 0,
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map([['maker-ask', makerOffer]]) }],
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

    const result = processOrderbookSwaps(entityState, [takerOffer] as any);
    expect(result.mempoolOps).toHaveLength(0);

    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBestAsk(finalBook!)).toBe(askPriceTicks);
    expect(getBestBid(finalBook!)).toBe(bidPriceTicks);
    expect(getBookOrder(finalBook!, 'maker-account:maker-ask')).not.toBeNull();
    expect(getBookOrder(finalBook!, 'taker-account:taker-bid')).not.toBeNull();
  });

  test('repairs only the mismatched cached pair price while preserving other canonical resting orders', () => {
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
      qtyLots: 1,
    }).state;
    staleBook = applyCommand(staleBook, {
      kind: 0,
      ownerId: 'maker-b',
      orderId: 'maker-account:maker-ask-b',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: secondAskPriceTicks,
      qtyLots: 1,
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
      minFillRatio: 0,
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map([['maker-ask-a', makerOfferA], ['maker-ask-b', makerOfferB]]) }],
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

    const result = processOrderbookSwaps(entityState, [takerOffer] as any);
    expect(result.mempoolOps).toHaveLength(0);

    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBestAsk(finalBook!)).toBe(firstAskPriceTicks);
    expect(getBestBid(finalBook!)).toBe(bidPriceTicks);
    expect(getBookOrder(finalBook!, 'maker-account:maker-ask-a')?.priceTicks).toBe(firstAskPriceTicks);
    expect(getBookOrder(finalBook!, 'maker-account:maker-ask-b')?.priceTicks).toBe(secondAskPriceTicks);
  });

  test('repairs a cached pair by dropping offers that already have pending swap resolution', () => {
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
      qtyLots: 1,
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
      minFillRatio: 0,
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: bidPriceTicks,
    };

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', { swapOffers: new Map([['maker-ask', makerOffer]]) }],
        ['taker-account', { swapOffers: new Map() }],
      ]),
      pendingSwapFillRatios: new Map([['maker-account:maker-ask', 500_000]]),
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

    const result = processOrderbookSwaps(entityState, [takerOffer] as any);
    expect(result.mempoolOps).toHaveLength(0);

    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'maker-account:maker-ask')).toBeNull();
    expect(getBookOrder(finalBook!, 'taker-account:taker-bid')).not.toBeNull();
  });

  test('accepts wide-range resting orders without mutating the existing anchor order price', () => {
    const anchorPriceTicks = 25_015_002n;
    const overflowPriceTicks = 25_262_625n;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', { swapOffers: new Map() }],
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: anchorPriceTicks,
    };

    entityState.accounts.get('alice')!.swapOffers = new Map([['offer-a', anchorOffer]]);
    const firstPass = processOrderbookSwaps(entityState, [anchorOffer] as any);
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
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: overflowPriceTicks,
    };

    const overflowPass = processOrderbookSwaps(entityState, [overflowOffer] as any);
    const finalBook = overflowPass.bookUpdates.at(-1)?.book ?? entityState.orderbookExt.books.get('1/2');
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'alice:offer-a')?.priceTicks).toBe(anchorPriceTicks);
    expect(getBookOrder(finalBook!, 'alice:offer-b')?.priceTicks).toBe(overflowPriceTicks);
  });

  test('queues cancelRemainder instead of throwing when a pair book reaches its order cap', () => {
    const maxOrders = 3;
    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['alice', { swapOffers: new Map() }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map([['4/6', createBook({ bucketWidthTicks: 10_000n, maxOrders, stpPolicy: 1 })]]),
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
      giveTokenId: 4,
      giveAmount: SWAP_LOT_SCALE,
      wantTokenId: 6,
      wantAmount: 1000n * SWAP_LOT_SCALE / 10_000n,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1000n,
    }));

    const result = processOrderbookSwaps(entityState, offers as any);
    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(finalBook!.orders.size).toBe(maxOrders);

    const cancelOp = result.mempoolOps.find(
      (item) => item.tx.type === 'swap_resolve' && item.tx.data.offerId === rejectedOfferId,
    );
    expect(cancelOp).toBeDefined();
    expect(cancelOp!.tx.data.cancelRemainder).toBe(true);
    expect(cancelOp!.tx.data.fillRatio).toBe(0);
  });

  test('contains pair-local book corruption and cancels only the offending taker', () => {
    const lot = SWAP_LOT_SCALE;
    const makerOffer = {
      offerId: 'maker-ask',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'maker-entity',
      accountId: 'maker-account',
      createdHeight: 1,
      giveTokenId: 4,
      giveAmount: lot,
      wantTokenId: 6,
      wantAmount: (lot * 10_000n) / 10_000n,
      minFillRatio: 0,
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
      giveTokenId: 6,
      giveAmount: (lot * 10_000n) / 10_000n,
      wantTokenId: 4,
      wantAmount: lot,
      minFillRatio: 0,
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
      qtyLots: 1,
    }).state;
    const corruptedOrder = corruptedBook.orders.get('maker-account:maker-ask');
    expect(corruptedOrder).toBeDefined();
    corruptedOrder!.bucketId = 999_999n;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([
        ['maker-account', {
          leftEntity: 'hub-entity',
          rightEntity: 'maker-entity',
          swapOffers: new Map([['maker-ask', makerOffer]]),
        }],
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
          supportedPairs: ['4/6'],
        },
        books: new Map([['4/6', corruptedBook]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [takerOffer] as any);
    const takerResolve = result.mempoolOps.find((item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve');
    const repairedBook = result.bookUpdates.at(-1)?.book;

    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(true);
    expect(String(takerResolve!.tx.data.comment || '')).toContain('pair-error:');
    expect(repairedBook).toBeDefined();
    expect(getBookOrder(repairedBook!, 'maker-account:maker-ask')).not.toBeNull();
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
      wantAmount: 1000n * lot / 10_000n,
      minFillRatio: 0,
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
      qtyLots: 1,
    }).state;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', aliceAccount]]),
      pendingSwapFillRatios: new Map(),
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
    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps[0]!.accountId).toBe('alice');
    expect(result.mempoolOps[0]!.tx.type).toBe('swap_resolve');
    expect(result.mempoolOps[0]!.tx.data.offerId).toBe('offer-cancel');
    expect(result.mempoolOps[0]!.tx.data.cancelRemainder).toBe(true);
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
      wantAmount: 1000n * lot / 10_000n,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 1000n,
    };

    const aliceAccount = makeAccountMachine(offer as any);
    aliceAccount.pendingFrame = {
      height: 1,
      timestamp: 1,
      jHeight: 0,
      accountTxs: [{ type: 'swap_resolve', data: { offerId: 'offer-cancel-pending', fillRatio: 0, cancelRemainder: true } }],
      prevFrameHash: '',
      tokenIds: [],
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
      qtyLots: 1,
    }).state;

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', aliceAccount]]),
      pendingSwapFillRatios: new Map(),
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
    expect(result.mempoolOps).toHaveLength(0);
  });

  test('contains malformed maker order ids at pair scope instead of throwing the whole pass', () => {
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
      qtyLots: 1,
    }).state;

    const lot = SWAP_LOT_SCALE;
    const takerOffer = {
      offerId: 'taker-buy-malformed',
      makerIsLeft: false,
      fromEntity: 'hub-entity',
      toEntity: 'taker',
      accountId: 'taker-account',
      giveTokenId: 6,
      giveAmount: (lot * 10_000n) / 10_000n,
      wantTokenId: 4,
      wantAmount: lot,
      createdHeight: 1,
      minFillRatio: 0,
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
          supportedPairs: ['4/6'],
        },
        books: new Map([['4/6', book]]),
        pairConfig: new Map(),
      } as any,
    } as any;

    const result = processOrderbookSwaps(entityState, [takerOffer] as any);
    const takerResolve = result.mempoolOps.find((item) => item.accountId === 'taker-account' && item.tx.type === 'swap_resolve');
    const finalBook = result.bookUpdates.at(-1)?.book;

    expect(takerResolve).toBeDefined();
    expect(takerResolve!.tx.data.cancelRemainder).toBe(true);
    expect(String(takerResolve!.tx.data.comment || '')).toContain('pair-error:ORDERBOOK_FILL_LOOKUP_FAILED: malformed namespacedOrderId=malformed');
    expect(finalBook).toBeDefined();
    expect(getBookOrder(finalBook!, 'malformed')).toBeNull();
  });

  test('processOrderbookCancels removes duplicate stale copies across all pair books', () => {
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
      wantAmount: 1000n * lot / 10_000n,
      minFillRatio: 0,
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
        qtyLots: 1,
      }).state;
      if (bookRef === bookA) bookA = updated;
      else bookB = updated;
    }

    const entityState = {
      entityId: 'hub-entity',
      accounts: new Map([['alice', makeAccountMachine(offer as any)]]),
      pendingSwapFillRatios: new Map(),
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

    const result = processOrderbookCancels(entityState, [{ accountId: 'alice', offerId: 'dup' }]);

    expect(result.bookUpdates).toHaveLength(2);
    expect(getBookOrder(result.bookUpdates[0]!.book, 'alice:dup')).toBeNull();
    expect(getBookOrder(result.bookUpdates[1]!.book, 'alice:dup')).toBeNull();
    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps[0]!.tx.type).toBe('swap_resolve');
    expect(result.mempoolOps[0]!.tx.data.cancelRemainder).toBe(true);
  });
});
