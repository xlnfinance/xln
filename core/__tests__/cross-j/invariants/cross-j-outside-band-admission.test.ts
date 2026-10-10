import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { safeParse } from '../../../protocol/serialization';
import { createOrderbookExtState } from '../../../orderbook';
import { markWorkingOrderbookOffer } from '../../../orderbook/swap-execution';
import { processOrderbookSwaps } from '../../../entity/tx/handlers/account/orderbook';
import { createEmptyEntityCollectionCandidate } from '../../../entity/state/persistent-collection-map';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import { makeJurisdiction, makeState } from '../../helpers/cross-j';

// The exact committed route that caused native H1 to emit forbidden swap_resolve.
const fixture = safeParse(readFileSync(new URL('../../../../rscore/fixtures/cross-j-entity-kinds/outside-band.json', import.meta.url), 'utf8')) as {
  route: CrossJurisdictionSwapRoute; baselineRoute: CrossJurisdictionSwapRoute; priceTicks: string;
};
test('cross-j quoted price uses cross admission, never same-j cancellation', () => {
  const { route } = fixture;
  const state = makeState(route.source.counterpartyEntityId, route.sourceHubSignerId!, makeJurisdiction('source', 31337, 'a1', 'a2'));
  state.timestamp = route.createdAt;
  state.crossJurisdictionBookAdmissions = createEmptyEntityCollectionCandidate();
  state.orderbookExt = createOrderbookExtState({ entityId: state.entityId, name: 'cross quote', minTradeSize: 0n,
    spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
    referenceTokenId: 1, supportedPairs: [],
  });
  for (const [index, route] of [fixture.baselineRoute, fixture.route].entries()) {
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    state.crossJurisdictionBookAdmissions.set(`${route.source.entityId}:${route.orderId}`, {
      orderId: route.orderId, routeHash: route.routeHash!, sourceEntityId: route.source.entityId,
      bookOwnerEntityId: state.entityId, status: 'admitted', route, updatedAt: state.timestamp,
    });
    const offer = markWorkingOrderbookOffer({ offerId: route.orderId, accountId: route.source.entityId,
      makerIsLeft: true, fromEntity: route.source.entityId, toEntity: state.entityId, createdHeight: 1,
      giveTokenId: 1, giveTokenDecimals: 6, giveAmount: route.source.amount,
      wantTokenId: 1, wantTokenDecimals: 6, wantAmount: route.target.amount,
      maxFee: 0n, minNetReceive: route.target.amount, priceTicks: index === 0 ? 10000n : BigInt(fixture.priceTicks), timeInForce: 0,
      crossJurisdiction: route,
    });
    const result = processOrderbookSwaps(state, [offer]);
    expect(result.accountTxs).toHaveLength(0);
    expect(result.bookUpdates).toHaveLength(1);
    expect(result.bookUpdates[0]!.book.orders.size).toBe(index + 1);
    expect(result.crossJurisdictionFills).toHaveLength(0);
    for (const update of result.bookUpdates) state.orderbookExt.books.set(update.pairId, update.book);
  }
});

test('a cross offer with 0 executable lots is cancelled through pull clearing, never a halt', () => {
  // A user's size and price can floor to 0 executable lots. That used to be a
  // live projection reject (ORDERBOOK_LIVE_PROJECTION_REJECT) that halted the
  // book-owner hub; Rust already cancels cross-dust-remainder.
  // 3·10^14 wei WETH for 750_001 µUSDC: the exact quote multiple at this
  // price is 5000 lots, so the 299-lot bound floors to 0 executable lots.
  const route = {
    ...fixture.baselineRoute,
    source: { ...fixture.baselineRoute.source, tokenId: 2, amount: 300_000_000_000_000n },
    target: { ...fixture.baselineRoute.target, tokenId: 1, amount: 750_001n },
  };
  const state = makeState(route.source.counterpartyEntityId, route.sourceHubSignerId!, makeJurisdiction('source', 31337, 'a1', 'a2'));
  state.timestamp = route.createdAt;
  state.crossJurisdictionBookAdmissions = createEmptyEntityCollectionCandidate();
  state.orderbookExt = createOrderbookExtState({ entityId: state.entityId, name: 'cross dust', minTradeSize: 0n,
    spreadDistribution: { makerBps: 0, takerBps: 10000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
    referenceTokenId: 1, supportedPairs: [],
  });
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  state.crossJurisdictionBookAdmissions.set(`${route.source.entityId}:${route.orderId}`, {
    orderId: route.orderId, routeHash: route.routeHash!, sourceEntityId: route.source.entityId,
    bookOwnerEntityId: state.entityId, status: 'admitted', route, updatedAt: state.timestamp,
  });
  const offer = markWorkingOrderbookOffer({ offerId: route.orderId, accountId: route.source.entityId,
    makerIsLeft: true, fromEntity: route.source.entityId, toEntity: state.entityId, createdHeight: 1,
    giveTokenId: 2, giveTokenDecimals: 18, giveAmount: route.source.amount,
    wantTokenId: 1, wantTokenDecimals: 6, wantAmount: route.target.amount,
    maxFee: 0n, minNetReceive: route.target.amount, timeInForce: 0,
    crossJurisdiction: route,
  });
  const result = processOrderbookSwaps(state, [offer]);
  expect(result.accountTxs).toHaveLength(0);
  expect(result.bookUpdates).toHaveLength(0);
  expect(result.crossJurisdictionFills).toHaveLength(1);
});
