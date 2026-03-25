import { describe, expect, test } from 'bun:test';
import { createBook, applyCommand } from '../orderbook/core';
import { SWAP_LOT_SCALE } from '../orderbook/types';
import { processOrderbookSwaps } from '../entity-tx/handlers/account';
import { deriveCanonicalSwapFillRatio } from '../swap-execution';

describe('orderbook matching fallback execution mapping', () => {
  test('generates execution amounts even when account state does not contain the offer yet', () => {
    let book = createBook({
      tick: 1n,
      pmin: 900n,
      pmax: 3000n,
      maxOrders: 10_000,
      stpPolicy: 1,
    });

    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker1',
      orderId: 'maker-ask-1',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1000n,
      qtyLots: 1,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'maker2',
      orderId: 'maker-ask-2',
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
    const op = result.mempoolOps.find((item) => item.tx.type === 'swap_resolve');

    expect(op).toBeDefined();
    expect(op!.tx.data.fillRatio).toBe(deriveCanonicalSwapFillRatio(quoteAmount, 210_000_000_000n));
    expect(op!.tx.data.executionGiveAmount).toBe(210_000_000_000n);
    expect(op!.tx.data.executionWantAmount).toBe(baseQty);
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
    expect(finalBook!.bestAskIdx).toBeGreaterThanOrEqual(0);

    const headOrderIdx = finalBook!.levelHeadAsk[finalBook!.bestAskIdx];
    expect(finalBook!.orderIds[headOrderIdx]).toBe('alice:offer-a');
  });

  test('rehydrate rebuild inserts open offers without emitting swap_resolve side effects', () => {
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

  test('preserves exact aligned price when creating a bounded book window', () => {
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

    const orderIdx = finalBook!.orderIdToIdx.get('alice:offer-a');
    expect(typeof orderIdx).toBe('number');
    const levelIdx = finalBook!.orderPriceIdx[orderIdx!];
    const storedPrice = finalBook!.params.pmin + (BigInt(levelIdx) * finalBook!.params.tick);
    expect(storedPrice).toBe(priceTicks);
  });

  test('accepts wide volatile pair levels by widening the first book tick around the anchor price', () => {
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

    const result = processOrderbookSwaps(entityState, offers as any);
    expect(result.mempoolOps).toHaveLength(0);

    const finalBook = result.bookUpdates.at(-1)?.book;
    expect(finalBook).toBeDefined();
    expect(finalBook!.params.tick).toBeGreaterThan(1n);

    const anchorOrderIdx = finalBook!.orderIdToIdx.get('alice:offer-a');
    expect(typeof anchorOrderIdx).toBe('number');
    const anchorLevelIdx = finalBook!.orderPriceIdx[anchorOrderIdx!];
    const storedAnchorPrice = finalBook!.params.pmin + (BigInt(anchorLevelIdx) * finalBook!.params.tick);
    expect(storedAnchorPrice).toBe(anchorPriceTicks);

    expect(finalBook!.orderIdToIdx.has('alice:offer-b')).toBe(true);
    expect(finalBook!.orderIdToIdx.has('alice:offer-c')).toBe(true);
  });
});
