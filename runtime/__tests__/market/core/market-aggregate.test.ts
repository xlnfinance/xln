import { expect, test } from 'bun:test';

import { aggregateMarketSnapshots } from '../../../network/relay/market/aggregate';
import type { MarketSnapshotPayload } from '../../../network/relay/market/snapshot';

const hubId = (hex: string): string => `0x${hex.repeat(64)}`;

const snapshot = (
  hubEntityId: string,
  input: Readonly<{
    bid: string;
    ask: string;
    lastTradePrice: string | null;
    tradeCount: number;
  }>,
): MarketSnapshotPayload => ({
  format: 'exact-price-levels',
  hubEntityId,
  jurisdictionRef: `stack:1:0x${'c'.repeat(40)}`,
  pairId: '1/7',
  depth: 20,
  displayDecimals: 4,
  priceScale: '10000',
  bucketWidthTicks: '1',
  bids: [{ price: input.bid, size: '2', total: '2', orderCount: 1 }],
  asks: [{ price: input.ask, size: '3', total: '3', orderCount: 1 }],
  spread: (BigInt(input.ask) - BigInt(input.bid)).toString(),
  spreadPercent: '1.000',
  lastTradePrice: input.lastTradePrice,
  tradeCount: input.tradeCount,
  source: 'orderbookExt',
  entityHeight: 8,
  entityStateHash: `0x${'a'.repeat(64)}`,
  hubUpdatedAt: 10,
  updatedAt: 11,
});

test('relay merges every Hub level and exposes the newest observed committed trade', () => {
  const observations = new Map();
  const first = aggregateMarketSnapshots([
    snapshot(hubId('1'), { bid: '90', ask: '110', lastTradePrice: '100', tradeCount: 2 }),
    snapshot(hubId('2'), { bid: '95', ask: '105', lastTradePrice: '102', tradeCount: 4 }),
  ], 20, 1_000, observations);

  expect(first).toMatchObject({
    source: 'relayAggregate',
    sourceCount: 2,
    pairId: '1/7',
    jurisdictionRef: `stack:1:0x${'c'.repeat(40)}`,
    lastTradePrice: '100',
    lastTradeObservedAt: 1_000,
    lastTradeHubEntityId: hubId('1'),
    bids: [
      { price: '95', size: '2', total: '2' },
      { price: '90', size: '2', total: '4' },
    ],
    asks: [
      { price: '105', size: '3', total: '3' },
      { price: '110', size: '3', total: '6' },
    ],
  });

  const unchanged = aggregateMarketSnapshots([
    snapshot(hubId('1'), { bid: '90', ask: '110', lastTradePrice: '100', tradeCount: 2 }),
    snapshot(hubId('2'), { bid: '95', ask: '105', lastTradePrice: '102', tradeCount: 4 }),
  ], 20, 5_000, observations);
  expect(unchanged.lastTradeObservedAt).toBe(1_000);

  const nextTrade = aggregateMarketSnapshots([
    snapshot(hubId('1'), { bid: '90', ask: '110', lastTradePrice: '101', tradeCount: 3 }),
    snapshot(hubId('2'), { bid: '95', ask: '105', lastTradePrice: '102', tradeCount: 4 }),
  ], 20, 6_000, observations);
  expect(nextTrade.lastTradePrice).toBe('101');
  expect(nextTrade.lastTradeObservedAt).toBe(6_000);
  expect(nextTrade.lastTradeHubEntityId).toBe(hubId('1'));
});

test('relay rejects a Hub trade counter rollback', () => {
  const observations = new Map();
  aggregateMarketSnapshots([
    snapshot(hubId('1'), { bid: '90', ask: '110', lastTradePrice: '100', tradeCount: 2 }),
  ], 20, 1_000, observations);
  expect(() => aggregateMarketSnapshots([
    snapshot(hubId('1'), { bid: '90', ask: '110', lastTradePrice: '99', tradeCount: 1 }),
  ], 20, 2_000, observations)).toThrow('MARKET_TRADE_COUNT_ROLLBACK');
});
