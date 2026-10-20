import { expect, test } from 'bun:test';
import type { RelayMarketSnapshotPayload } from '@xln/core/network/relay/market/aggregate';
import { selectRelaySnapshot } from './relay-book-snapshot';

const source = {
  hubEntityId: `0x${'11'.repeat(32)}`,
  jurisdictionRef: 'ethereum',
  entityHeight: 7,
  entityStateHash: null,
  hubUpdatedAt: 1,
  snapshotUpdatedAt: 1,
  minTradeSize: '10000000',
  tradeCount: 0,
  lastTradePrice: null,
};
const book: RelayMarketSnapshotPayload = {
  format: 'exact-price-levels',
  pairId: '1/2',
  jurisdictionRef: source.jurisdictionRef,
  depth: 12,
  displayDecimals: 4,
  priceScale: '10000',
  bids: [{ price: '24995000', size: '1000000', total: '1000000' }],
  asks: [{ price: '25005000', size: '1000000', total: '1000000' }],
  spread: '10000',
  spreadPercent: '0.04',
  lastTradePrice: null,
  lastTradeObservedAt: null,
  lastTradeHubEntityId: null,
  source: 'relayAggregate',
  sourceCount: 1,
  sources: [source],
  updatedAt: 1,
};

test('a changed pair or hub cannot reuse a retained book, minimum or trade hint', () => {
  expect(selectRelaySnapshot(book, source.hubEntityId, '1/2')).toBe(book);
  expect(selectRelaySnapshot(book, source.hubEntityId, '1/3')).toBeNull();
  expect(selectRelaySnapshot(book, `0x${'22'.repeat(32)}`, '1/2')).toBeNull();
  expect(selectRelaySnapshot(null, source.hubEntityId, '1/2')).toBeNull();
  const next = { ...book, pairId: '1/3', asks: [{ price: '10001', size: '1000000', total: '1000000' }] };
  expect(selectRelaySnapshot(next, source.hubEntityId, '1/3')).toBe(next);
});

test('single-hub selection does not accept a mixed or unidentified source book', () => {
  expect(selectRelaySnapshot({ ...book, sources: [] }, source.hubEntityId, '1/2')).toBeNull();
  expect(
    selectRelaySnapshot(
      { ...book, sources: [source, { ...source, hubEntityId: `0x${'22'.repeat(32)}` }], sourceCount: 2 },
      source.hubEntityId,
      '1/2',
    ),
  ).toBeNull();
});

test('Cross cannot reuse a numeric same-network snapshot or another stack venue', () => {
  const venue =
    'cross:stack:31338:0x1111111111111111111111111111111111111111:2/stack:31337:0x2222222222222222222222222222222222222222:1';
  expect(selectRelaySnapshot(book, source.hubEntityId, venue)).toBeNull();
  const cross = { ...book, pairId: venue };
  expect(selectRelaySnapshot(cross, source.hubEntityId, venue)).toBe(cross);
  expect(selectRelaySnapshot(cross, source.hubEntityId, venue.replace('31338', '31339'))).toBeNull();
});
