import { expect, test } from 'bun:test';

import {
  createMarketMakerServerState,
  getMarketMakerHealth,
} from '../server/market-maker-health';
import { buildDefaultEntitySwapPairs } from '../account-utils';
import { buildMarketSnapshotForReplica } from '../market-snapshot';
import { applyCommand, createBook } from '../orderbook';
import type { Env } from '../types';

test('market maker server health treats absent cross topology as neutral', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['hub'];
  state.tokenIds = [1, 2, 3];

  const health = getMarketMakerHealth({} as Env, state, () => null);

  expect(health.cross.applicable).toBe(false);
  expect(health.cross.ok).toBe(true);
  expect(health.cross.expectedRoutes).toBe(0);
  expect(health.cross.routes).toEqual([]);
});

test('market maker server health requires full quote depth', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['0x0000000000000000000000000000000000abcdef'];
  state.tokenIds = [1, 2, 3];

  const account = {
    swapOffers: new Map([
      ['mm-abcdef-2-1-ask-1', {}],
      ['mm-abcdef-1-3-ask-1', {}],
      ['mm-abcdef-2-3-ask-1', {}],
    ]),
    mempool: [],
    pendingFrame: null,
  };
  const health = getMarketMakerHealth({} as Env, state, () => account as any);

  expect(health.ok).toBe(false);
  expect(health.hubs[0]?.ready).toBe(true);
  expect(health.hubs[0]?.depthReady).toBe(false);
  expect(health.hubs[0]?.pairs.map(pair => ({
    pairId: pair.pairId,
    offers: pair.offers,
    ready: pair.ready,
    depthReady: pair.depthReady,
  }))).toEqual([
    { pairId: '1/2', offers: 1, ready: true, depthReady: false },
    { pairId: '1/3', offers: 1, ready: true, depthReady: false },
    { pairId: '2/3', offers: 1, ready: true, depthReady: false },
  ]);
});

test('market maker server health is green only at full configured depth', () => {
  const state = createMarketMakerServerState();
  state.entityId = 'mm';
  state.targetHubIds = ['0x0000000000000000000000000000000000abcdef'];
  state.tokenIds = [1, 2, 3];

  const offers = new Map<string, unknown>();
  for (const pair of buildDefaultEntitySwapPairs(state.tokenIds)) {
    const pairKey = `${pair.baseTokenId}-${pair.quoteTokenId}`;
    for (const side of ['ask', 'bid']) {
      for (let level = 1; level <= 10; level += 1) {
        offers.set(`mm-abcdef-${pairKey}-${side}-${level}`, {});
      }
    }
  }
  const health = getMarketMakerHealth({} as Env, state, () => ({
    swapOffers: offers,
    mempool: [],
    pendingFrame: null,
  } as any));

  expect(health.ok).toBe(true);
  expect(health.expectedOffersPerPair).toBe(20);
  expect(health.expectedOffersPerHub).toBe(60);
  expect(health.hubs[0]?.depthReady).toBe(true);
});

test('market snapshots expose order counts for aggregated price levels', () => {
  const book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 0 });
  applyCommand(book, {
    kind: 0,
    ownerId: 'maker-a',
    orderId: 'ask-a',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 4n,
    qtyLots: 10n,
  });
  applyCommand(book, {
    kind: 0,
    ownerId: 'maker-b',
    orderId: 'ask-b',
    side: 1,
    tif: 0,
    postOnly: true,
    priceTicks: 4n,
    qtyLots: 15n,
  });

  const snapshot = buildMarketSnapshotForReplica({
    state: {
      orderbookExt: { books: new Map([['cross:a/b', book]]) },
      height: 3,
      timestamp: 100,
    },
  } as any, `0x${'a'.repeat(64)}`, 'cross:a/b', 20);

  expect(snapshot.asks).toHaveLength(1);
  expect(snapshot.asks[0]).toMatchObject({ price: '4', size: '25', total: '25', orderCount: 2 });
});
