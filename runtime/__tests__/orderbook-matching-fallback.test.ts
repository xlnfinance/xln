import { describe, expect, test } from 'bun:test';
import { createBook, applyCommand } from '../orderbook/core';
import { SWAP_LOT_SCALE } from '../orderbook/types';
import { processOrderbookSwaps } from '../entity-tx/handlers/account';

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
    expect(op!.tx.data.fillRatio).toBe(65_535);
    expect(op!.tx.data.executionGiveAmount).toBe(210_000_000_000n);
    expect(op!.tx.data.executionWantAmount).toBe(baseQty);
  });
});
