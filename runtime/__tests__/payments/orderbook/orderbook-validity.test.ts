import { describe, expect, test } from 'bun:test';

import { applyCommand, createBook, type BookState } from '../../../orderbook/core';
import {
  createOrderbookExtState,
  getStaticSwapTokenDimensions,
  ORDERBOOK_PRICE_SCALE,
  replaceOrderbookPair,
  SWAP_LOT_SCALE,
} from '../../../orderbook/types';
import { validateBookAgainstOffers, validateBookStructure, validateEntityOrderbooks } from '../../../orderbook/validity';
import type { AccountReplica, SwapOffer } from '../../../types/account';
import type { EntityState } from '../../../entity/types';
import {
  addr,
  entity,
  makeAccount as makeTestAccount,
  makeJurisdiction,
  makeState as makeTestState,
} from '../../helpers/cross-j';

const aliceId = entity('aa');
const hubId = entity('bb');
const ghostId = entity('cc');
const wrongOwnerId = entity('dd');
const offerKey = `${aliceId}:offer-1`;
const ghostKey = `${ghostId}:offer-x`;

const makeOffer = (overrides: Partial<SwapOffer> = {}): SwapOffer => ({
  offerId: 'offer-1',
  giveTokenId: 2,
  ...getStaticSwapTokenDimensions(2, 1),
  giveAmount: SWAP_LOT_SCALE,
  wantTokenId: 1,
  wantAmount: (SWAP_LOT_SCALE * 1000n) / ORDERBOOK_PRICE_SCALE,
  priceTicks: 1000n,
  timeInForce: 0,
  makerIsLeft: false,
  createdHeight: 1,
  ...overrides,
});

const makeAccount = (offerId: string, offer: SwapOffer): AccountReplica => {
  const account = makeTestAccount(aliceId, hubId, {
    chainId: 31_337,
    depositoryAddress: addr('11'),
  });
  account.state.swapOffers = new Map([[offerId, offer]]);
  return account;
};

const makeState = (book: BookState, offerId = 'offer-1', offer = makeOffer()): EntityState => {
  const jurisdiction = makeJurisdiction('orderbook-validity', 31_337, '11', '12');
  const state = makeTestState(hubId, addr('13'), jurisdiction, aliceId);
  const orderbookExt = createOrderbookExtState({
    entityId: hubId,
    name: 'Hub',
    spreadDistribution: {
      makerBps: 0,
      takerBps: 10_000,
      hubBps: 0,
      makerReferrerBps: 0,
      takerReferrerBps: 0,
    },
    referenceTokenId: 2,
    usdQuoteAuthorityEntityId: aliceId,
    minTradeSize: 0n,
    supportedPairs: ['1/2'],
  });
  replaceOrderbookPair(orderbookExt, '1/2', book);
  state.timestamp = 0;
  state.profile = { name: 'Hub', isHub: true, avatar: '', bio: '', website: '' };
  state.accounts.set(aliceId, makeAccount(offerId, offer));
  state.orderbookExt = orderbookExt;
  return state;
};

describe('orderbook validity', () => {
  test('accepts structurally valid book and matching open offers', () => {
    const book = applyCommand(
      createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: hubId,
        orderId: offerKey,
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1000n,
        qtyLots: 1n,
      },
    ).state;

    const state = makeState(book);

    expect(validateBookStructure(book).ok).toBe(true);
    expect(validateBookAgainstOffers(state).ok).toBe(true);
    expect(validateEntityOrderbooks(state).ok).toBe(true);
  });

  test('reports missing, orphaned, and mismatched orders', () => {
    let book = createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: wrongOwnerId,
      orderId: offerKey,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1001n,
      qtyLots: 1n,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: ghostId,
      orderId: ghostKey,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 1005n,
      qtyLots: 1n,
    }).state;

    const report = validateBookAgainstOffers(makeState(book));
    expect(report.ok).toBe(false);
    expect(report.orphanedInBook).toContain(ghostKey);
    expect(report.mismatched.some((item) => item.swapKey === offerKey && item.field === 'priceTicks')).toBe(true);
    expect(report.mismatched.some((item) => item.swapKey === offerKey && item.field === 'ownerId')).toBe(true);
  });

  test('reports invalid open offers that cannot be represented in the book', () => {
    const book = createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 });
    const invalidOffer = makeOffer({ giveAmount: SWAP_LOT_SCALE - 1n });
    const report = validateBookAgainstOffers(makeState(book, 'offer-1', invalidOffer));
    expect(report.ok).toBe(false);
    expect(report.invalidOffers).toEqual([{ swapKey: offerKey, reason: 'lot-misaligned' }]);
  });

  test('accepts offers with priceTicks above qty-lot limits', () => {
    const hugePriceTicks = 5_000_000_000n;
    const book = applyCommand(
      createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: hubId,
        orderId: offerKey,
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: hugePriceTicks,
        qtyLots: 1n,
      },
    ).state;

    const report = validateBookAgainstOffers(makeState(book, 'offer-1', makeOffer({ priceTicks: hugePriceTicks })));
    expect(report.invalidOffers).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('accepts order quantities above the old uint32 lot ceiling', () => {
    const hugeQtyLots = 0x1_0000_0000n + 123n;
    const hugeBaseAmount = hugeQtyLots * SWAP_LOT_SCALE;
    const hugeQuoteAmount = (hugeBaseAmount * 1000n) / ORDERBOOK_PRICE_SCALE;
    const book = applyCommand(
      createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: hubId,
        orderId: offerKey,
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1000n,
        qtyLots: hugeQtyLots,
      },
    ).state;

    const report = validateBookAgainstOffers(makeState(
      book,
      'offer-1',
      makeOffer({
        giveAmount: hugeBaseAmount,
        wantAmount: hugeQuoteAmount,
      }),
    ));
    expect(report.invalidOffers).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('reports broken sparse orderbook pair index entries', () => {
    const book = applyCommand(
      createBook({ bucketWidthTicks: 100n, maxOrders: 32, stpPolicy: 1 }),
      {
        kind: 0,
        ownerId: hubId,
        orderId: offerKey,
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks: 1000n,
        qtyLots: 1n,
      },
    ).state;

    const state = makeState(book);
    state.orderbookExt!.orderPairs = new Map([
      [offerKey, ['9/9']],
      [ghostKey, ['4/6']],
    ]);

    const report = validateBookAgainstOffers(state);
    expect(report.ok).toBe(false);
    expect(
      report.mismatched.some((item) =>
        item.swapKey === offerKey
        && item.field === 'pairIndex'
        && item.expected === '1/2'
        && item.actual === '9/9',
      ),
    ).toBe(true);
    expect(
      report.mismatched.some((item) =>
        item.swapKey === ghostKey
        && item.field === 'pairIndex'
        && item.expected === ''
        && item.actual === '4/6',
      ),
    ).toBe(true);
  });
});
