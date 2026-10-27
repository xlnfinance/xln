import { expect, test } from 'bun:test';
import { createDefaultDelta } from '../../account/state/delta';
import { processOrderbookSwaps } from '../../entity/tx/handlers/account/orderbook';
import { createOrderbookExtState, getStaticSwapTokenDimensions } from '../../swapbook/types';
import { markWorkingOrderbookOffer, normalizeSwapOfferForOrderbook } from '../../swapbook/swap-execution';
import { addr, entity, makeState, makeJurisdiction, makeAccount, openWritableEntityAccounts } from '../helpers/cross-j';

const hub = entity('11');
const maker = entity('22');
const jurisdiction = makeJurisdiction('Testnet', 31337, 'dd', 'ee');
const setup = () => {
  const state = makeState(hub, addr('11'), jurisdiction);
  state.orderbookExt = createOrderbookExtState({ entityId: hub, name: 'Hub', minTradeSize: 0n,
    referenceTokenId: 1, usdQuoteAuthorityEntityId: hub, supportedPairs: ['1/2'],
    spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 } });
  return state;
};
const offer = (giveDecimals = 18, tif: 0 | 2 = 0) => markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({
  offerId: 'ask', fromEntity: hub, toEntity: maker, makerIsLeft: false, createdHeight: 1,
  giveTokenId: 2, wantTokenId: 1, ...getStaticSwapTokenDimensions(2, 1), giveTokenDecimals: giveDecimals,
  giveAmount: 10n ** BigInt(giveDecimals), wantAmount: 2500_000000n, priceTicks: 25000000n,
  maxFee: 0n, minNetReceive: 2500_000000n, timeInForce: tif,
}, maker));

test('wrong first offer decimals cannot commit pair dimensions or block the correct offer', () => {
  const state = setup();
  const wrong = processOrderbookSwaps(state, [offer(6)]);
  expect(state.orderbookExt?.pairDimensions.size).toBe(0);
  expect(wrong.bookUpdates).toHaveLength(0);
  expect(wrong.accountTxs).toHaveLength(1);
  const valid = processOrderbookSwaps(state, [offer()]);
  expect(valid.bookUpdates.at(-1)?.book.orders.size).toBe(1);
});

test('rejected first FOK cannot commit pair dimensions', () => {
  const state = setup();
  const rejected = processOrderbookSwaps(state, [offer(18, 2)]);
  expect(rejected.accountTxs).toHaveLength(1);
  expect(state.orderbookExt?.pairDimensions.size).toBe(0);
  expect(rejected.bookUpdates).toHaveLength(0);
});

test.each([{ name: 'zero', capacity: 0n, tif: 0 as const }, { name: 'one unit short', capacity: 2499999999n, tif: 0 as const }, { name: 'FOK', capacity: 0n, tif: 2 as const }])('insufficient hub capacity cancels the maker without partial fill: $name', ({ capacity, tif }) => {
  const state = setup();
  const ask = offer();
  const taker = entity('33');
  const bid = markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({
    ...ask, offerId: 'bid', fromEntity: hub, toEntity: taker,
    giveTokenId: 1, wantTokenId: 2, ...getStaticSwapTokenDimensions(1, 2),
    giveAmount: ask.wantAmount, wantAmount: ask.giveAmount,
    minNetReceive: ask.giveAmount, createdHeight: 2, timeInForce: tif,
  }, taker));
  for (const row of [ask, bid]) {
    const account = makeAccount(hub, row.accountId, jurisdiction);
    for (const tokenId of [1, 2]) {
      const delta = createDefaultDelta(tokenId);
      delta.leftCreditLimit = row === ask && tokenId === 1 ? capacity : 10n ** 30n;
      delta.rightCreditLimit = 10n ** 30n;
      delta.rightHold = tokenId === row.giveTokenId ? row.giveAmount : 0n;
      account.state.deltas = account.state.deltas.updated(tokenId, delta);
    }
    account.state.swapOffers = account.state.swapOffers.updated(row.offerId, {
      ...row, quantizedGive: row.giveAmount, quantizedWant: row.wantAmount,
    });
    openWritableEntityAccounts(state).set(row.accountId, account);
  }
  const result = processOrderbookSwaps(state, [ask, bid]);
  expect(result.accountTxs.map(({ tx }) => tx.type === 'swap_resolve' ? tx.data.fillRatio : -1)).toEqual(tif === 2 ? [0, 0] : [0]);
  expect(result.bookUpdates.every(update => update.book.tradeCount === 0)).toBe(true);
});

test('unknown token metadata is canceled rather than halting admission', () => {
  const state = setup();
  const unknown = { ...offer(), giveTokenId: 9999 };
  const result = processOrderbookSwaps(state, [unknown]);
  expect(result.accountTxs).toHaveLength(1);
  expect(result.bookUpdates).toHaveLength(0);
});

import { computeBookCommitmentHash } from '../../swapbook';
import capacityVector from '../../../rscore/fixtures/entity-kernel/capacity.json';
import { handleSwapResolve } from '../../account/tx/handlers/swap/resolve';
import { accountTransitionView, beginAccountTransition, publishAccountTransition, discardAccountTransition } from '../../account/state/candidate-overlay';

test('TS/Rust capacity parity: consume once, cancel unfunded maker, continue next level and settle every leg', async () => {
  const state = setup();
  const rows = capacityVector.offers.map((row, index) => {
    const base = BigInt(row.units) * 10n ** 18n;
    const quote = BigInt(row.units) * BigInt(row.price) * 100n;
    return markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({
      ...offer(), offerId: row.id, toEntity: entity(row.account), createdHeight: index + 1,
      giveTokenId: row.ask ? 2 : 1, wantTokenId: row.ask ? 1 : 2,
      ...getStaticSwapTokenDimensions(row.ask ? 2 : 1, row.ask ? 1 : 2),
      giveAmount: row.ask ? base : quote, wantAmount: row.ask ? quote : base,
      minNetReceive: row.ask ? quote : base, priceTicks: BigInt(row.price),
    }, entity(row.account)));
  });
  const accounts = openWritableEntityAccounts(state);
  for (const row of rows) {
    let account = accounts.get(row.accountId);
    if (!account) {
      account = makeAccount(hub, row.accountId, jurisdiction);
      for (const tokenId of [1, 2]) {
        const delta = createDefaultDelta(tokenId);
        delta.leftCreditLimit = row.accountId === maker && tokenId === 1 ? BigInt(capacityVector.makerCapacity) : 10n ** 30n;
        delta.rightCreditLimit = 10n ** 30n;
        account.state.deltas = account.state.deltas.updated(tokenId, delta);
      }
      accounts.set(row.accountId, account);
    }
    const delta = account.state.deltas.get(row.giveTokenId)!;
    account.state.deltas = account.state.deltas.updated(row.giveTokenId, { ...delta, rightHold: delta.rightHold + row.giveAmount });
    account.state.swapOffers = account.state.swapOffers.updated(row.offerId, { ...row, quantizedGive: row.giveAmount, quantizedWant: row.wantAmount });
  }
  const result = processOrderbookSwaps(state, rows);
  expect(result.accountTxs.map(({ tx }) => {
    if (tx.type !== 'swap_resolve') throw new Error('unexpected tx');
    return { id: tx.data.offerId, fill: tx.data.fillRatio, give: String(tx.data.executionGiveAmount ?? 0n), want: String(tx.data.executionWantAmount ?? 0n) };
  })).toEqual(capacityVector.resolves);
  expect(computeBookCommitmentHash(result.bookUpdates.at(-1)!.book)).toBe(capacityVector.bookCommitmentHash);
  expect(result.bookUpdates.at(-1)?.book.tradeCount).toBe(capacityVector.tradeCount);
  expect(result.bookUpdates.at(-1)?.book.orders.size).toBe(0);
  for (const { accountId, tx } of result.accountTxs) {
    if (tx.type !== 'swap_resolve') throw new Error('unexpected tx');
    if (tx.data.offerId === 'unfunded') expect(tx.data.comment).toBe('counterparty-capacity');
    const account = accounts.get(accountId)!;
    const transition = beginAccountTransition(account);
    const settled = await handleSwapResolve(accountTransitionView(transition), tx, true, 2);
    if (!settled.ok) discardAccountTransition(transition);
    expect(settled.ok).toBe(true);
    if (settled.ok) publishAccountTransition(account, transition);
  }
  for (const account of accounts.values()) {
    expect(account.state.swapOffers.size).toBe(0);
    expect(account.state.deltas.get(1)?.rightHold).toBe(0n);
    expect(account.state.deltas.get(2)?.rightHold).toBe(0n);
  }
});
