import { expect, test } from 'bun:test';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { createDefaultDelta } from '../../account/state/delta';
import { requirePersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { handleSwapResolve } from '../../account/tx/handlers/swap/resolve';
import { accountTransitionView, beginAccountTransition, publishAccountTransition } from '../../account/state/candidate-overlay';
import { processOrderbookSwaps } from '../../entity/tx/handlers/account/orderbook';
import { computeBookCommitmentHash, createOrderbookExtState, getStaticSwapTokenDimensions } from '../../swapbook';
import { markWorkingOrderbookOffer, normalizeSwapOfferForOrderbook } from '../../swapbook/swap-execution';
import { addr, entity, makeState, makeJurisdiction, makeAccount, openWritableEntityAccounts } from '../helpers/cross-j';
import vector from '../../../rscore/fixtures/entity-kernel/capacity-amendments.json';

const hub = entity('11');
const jurisdiction = makeJurisdiction('Testnet', 31337, 'dd', 'ee');

test.each(vector.cases)('TS/Rust capacity amendment: $name', async row => {
  const state = makeState(hub, addr('11'), jurisdiction);
  state.orderbookExt = createOrderbookExtState({ entityId: hub, name: 'Hub', minTradeSize: 0n,
    referenceTokenId: 1, usdQuoteAuthorityEntityId: hub, supportedPairs: ['1/2'],
    spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 } });
  const rows = [...row.asks.map(ask => ({ ...ask, ask: true, tif: 0 })),
    { id: 'bid', account: '33', units: row.takerUnits, ask: false, tif: row.tif }];
  const accounts = openWritableEntityAccounts(state);
  const offers = rows.map((input, index) => {
    const remote = entity(input.account);
    const base = BigInt(input.units) * 10n ** 18n;
    const quote = BigInt(input.units) * 2500_000000n;
    if (input.tif !== 0 && input.tif !== 1 && input.tif !== 2) throw new Error('invalid tif');
    const offer = markWorkingOrderbookOffer(normalizeSwapOfferForOrderbook({
      offerId: input.id, fromEntity: hub, toEntity: remote, makerIsLeft: false, createdHeight: index + 1,
      giveTokenId: input.ask ? 2 : 1, wantTokenId: input.ask ? 1 : 2,
      ...getStaticSwapTokenDimensions(input.ask ? 2 : 1, input.ask ? 1 : 2),
      giveAmount: input.ask ? base : quote, wantAmount: input.ask ? quote : base,
      minNetReceive: input.ask ? quote : base, maxFee: 0n, priceTicks: 25000000n, timeInForce: input.tif,
    }, remote));
    let account = accounts.get(remote);
    if (!account) {
      account = makeAccount(hub, remote, { chainId: 31337, depositoryAddress: addr('dd') });
      for (const tokenId of [1, 2]) {
        const delta = createDefaultDelta(tokenId);
        delta.leftCreditLimit = remote === entity('22') && tokenId === 1 ? BigInt(row.makerCapacity)
          : remote === entity('33') && tokenId === 2 ? BigInt(row.takerCapacity) : 10n ** 30n;
        delta.rightCreditLimit = 10n ** 30n;
        account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas').updated(tokenId, delta);
      }
      accounts.set(remote, account);
    }
    const delta = account.state.deltas.get(offer.giveTokenId)!;
    account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas').updated(offer.giveTokenId, { ...delta, rightHold: delta.rightHold + offer.giveAmount });
    account.state.swapOffers = requirePersistentAccountStateMap(account.state.swapOffers, 'swapOffers').updated(offer.offerId, { ...offer, quantizedGive: offer.giveAmount, quantizedWant: offer.wantAmount });
    return offer;
  });
  const result = processOrderbookSwaps(state, offers);
  // Compare every field and its position: comments and optional execution evidence
  // are signed Account-frame inputs, not diagnostic-only metadata.
  const bigintFields = new Set(['fillNumerator', 'fillDenominator', 'executionGiveAmount',
    'executionWantAmount', 'restingPriceTicks', 'restingGiveAmount', 'restingWantAmount',
    'restingQuantizedGive', 'restingQuantizedWant']);
  const expectedResolves = row.resolves.map(({ accountId, tx }) => ({ accountId, tx: {
    type: tx.type,
    data: Object.fromEntries(Object.entries(tx.data).map(([key, value]) =>
      [key, typeof value === 'string' && bigintFields.has(key) ? BigInt(value) : value])),
  } }));
  expect(result.accountTxs).toStrictEqual(expectedResolves);
  // Hold the other signed preimage fields fixed to isolate output-payload parity.
  for (const frame of row.frames) {
    expect(computeFrameHash({ height: 3, timestamp: 1700000000000, jHeight: 7,
      prevFrameHash: 'genesis', accountStateRoot: `0x${'cd'.repeat(32)}`, stateHash: '',
      accountTxs: result.accountTxs.filter(target => target.accountId === frame.accountId).map(target => target.tx),
    })).toBe(frame.hash);
  }
  const book = result.bookUpdates.at(-1)!.book;
  expect(book.tradeCount).toBe(row.tradeCount);
  expect([...book.orders.values()].map(order => order.orderId.split(':').at(-1))).toEqual(row.resting);
  // Shared TS book oracle complements the independently specified resolve payloads.
  expect(computeBookCommitmentHash(book)).toBe(row.bookCommitmentHash);
  for (const { accountId, tx } of result.accountTxs) {
    if (tx.type !== 'swap_resolve') throw new Error('unexpected tx');
    const account = accounts.get(accountId)!;
    const transition = beginAccountTransition(account);
    expect((await handleSwapResolve(accountTransitionView(transition), tx, true, 2)).ok).toBe(true);
    publishAccountTransition(account, transition);
  }
  for (const [remote, account] of accounts) {
    const resting = offers.filter(offer => offer.accountId === remote && row.resting.includes(offer.offerId));
    expect([...account.state.swapOffers.keys()]).toEqual(resting.map(offer => offer.offerId));
    for (const token of [1, 2]) expect(account.state.deltas.get(token)?.rightHold).toBe(
      resting.filter(offer => offer.giveTokenId === token).reduce((sum, offer) => sum + offer.giveAmount, 0n));
  }
});
