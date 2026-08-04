import { expect, test } from 'bun:test';

import {
  buildWalletActivityReadQuery,
  mergeWalletActivityEvents,
  parseWalletActivityPage,
} from '../../frontend/apps/wallet/src/features/history/activity-history-adapter';

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'r10:runtime_input:0:placeSwapOffer',
  height: 10,
  timestamp: 1_800_000_000,
  kind: 'offchain',
  type: 'swap',
  source: 'runtime_input',
  direction: 'out',
  title: 'Swap offer placed',
  subtitle: '100 token 1 → 200 token 2',
  status: 'created',
  entityId: '0xabc',
  tokenId: 1,
  amount: '100',
  rawType: 'placeSwapOffer',
  ...overrides,
});

const page = (events: unknown[]) => ({
  ok: true,
  latestHeight: 12,
  fromHeight: 1,
  toHeight: 12,
  scannedFrames: 12,
  returned: events.length,
  limit: 40,
  scanLimit: 100,
  nextBeforeHeight: null,
  filters: { entityId: '0xabc', kind: 'all' },
  events,
});

test('activity query preserves explicit filters and disk pagination cursor', () => {
  expect(buildWalletActivityReadQuery({
    entityId: ' 0xAbC ',
    kind: 'offchain',
    types: ['swap', 'payment'],
    search: ' order-7 ',
    limit: 40,
    beforeHeight: 81,
  })).toEqual({
    entityId: '0xabc',
    kind: 'offchain',
    limit: 40,
    scanLimit: 1000,
    types: ['swap', 'payment'],
    q: 'order-7',
    beforeHeight: 81,
  });
});

test('activity page uses a stable timestamp, height, and id ordering', () => {
  const parsed = parseWalletActivityPage(page([
    event({ id: 'a', height: 10, timestamp: 100 }),
    event({ id: 'b', height: 11, timestamp: 100 }),
    event({ id: 'c', height: 11, timestamp: 100 }),
    event({ id: 'd', height: 12, timestamp: 101 }),
  ]));
  expect(parsed.events.map(entry => entry.id)).toEqual(['d', 'c', 'b', 'a']);
});

test('activity page rejects malformed amounts and unknown canonical states loudly', () => {
  expect(() => parseWalletActivityPage(page([event({ amount: '1.5' })]))).toThrow('WALLET_ACTIVITY_AMOUNT_INVALID:0');
  expect(() => parseWalletActivityPage(page([event({ type: 'mystery' })]))).toThrow('WALLET_ACTIVITY_TYPE_UNKNOWN:mystery');
  expect(() => parseWalletActivityPage({ ...page([event()]), returned: 0 })).toThrow('WALLET_ACTIVITY_RETURNED_MISMATCH');
});

test('pagination deduplicates identical boundary events and rejects conflicting copies', () => {
  const first = parseWalletActivityPage(page([event({ id: 'same' })])).events;
  const second = parseWalletActivityPage(page([
    event({ id: 'same' }),
    event({ id: 'older', height: 9, timestamp: 99 }),
  ])).events;
  expect(mergeWalletActivityEvents(first, second).map(entry => entry.id)).toEqual(['same', 'older']);
  expect(() => mergeWalletActivityEvents(first, [event({ id: 'same', status: 'failed' })])).toThrow(
    'WALLET_ACTIVITY_EVENT_CONFLICT:same',
  );
});
