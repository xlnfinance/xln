import { expect, test } from 'bun:test';
import {
  BASE_ACTIVITY_SCAN_LIMIT,
  FILTERED_ACTIVITY_SCAN_LIMIT,
  activityFiltersFromQuery,
  buildActivityHistoryReadQuery,
  isTransientActivityReadError,
  normalizeActivityHistoryPage,
} from '../../frontend/src/lib/components/Entity/activity-history-query';

const entityId = `0x${'ab'.repeat(32)}`;

const baseInput = {
  entityId,
  kind: 'offchain' as const,
  pageSize: 80,
  selectedTypes: [],
  search: '',
  mode: 'paged' as const,
  beforeHeight: null,
};

test('activity history uses compact scan window for unfiltered reads', () => {
  expect(buildActivityHistoryReadQuery(baseInput)).toEqual({
    entityId,
    kind: 'offchain',
    limit: 80,
    scanLimit: BASE_ACTIVITY_SCAN_LIMIT,
  });
});

test('activity history expands bounded scan window for typed filters', () => {
  expect(buildActivityHistoryReadQuery({
    ...baseInput,
    selectedTypes: ['payment'],
  })).toEqual({
    entityId,
    kind: 'offchain',
    limit: 80,
    scanLimit: FILTERED_ACTIVITY_SCAN_LIMIT,
    types: ['payment'],
  });
});

test('activity history expands bounded scan window for search and timeframe filters', () => {
  expect(buildActivityHistoryReadQuery({
    ...baseInput,
    search: ' payment ',
    beforeHeight: 50,
  })).toMatchObject({
    q: 'payment',
    beforeHeight: 50,
    scanLimit: FILTERED_ACTIVITY_SCAN_LIMIT,
  });

  expect(buildActivityHistoryReadQuery({
    ...baseInput,
    mode: 'timeframe',
    fromTimestamp: 1000,
    toTimestamp: 2000,
  })).toMatchObject({
    fromTimestamp: 1000,
    toTimestamp: 2000,
    scanLimit: FILTERED_ACTIVITY_SCAN_LIMIT,
  });
});

test('activity history derives filters from the typed adapter query', () => {
  const filters = activityFiltersFromQuery({
    entityId,
    kind: 'offchain',
    types: ['payment', 'htlc'],
    q: ' payment ',
    fromTimestamp: 1000,
    toTimestamp: 2000,
  });

  expect(filters).toEqual({
    entityId,
    kind: 'offchain',
    types: ['payment', 'htlc'],
    query: 'payment',
    fromTimestamp: 1000,
    toTimestamp: 2000,
  });
});

test('activity history normalizes the typed adapter page without alternate sources', () => {
  const query = buildActivityHistoryReadQuery(baseInput);
  const page = normalizeActivityHistoryPage({
    ok: true,
    latestHeight: 5,
    fromHeight: 1,
    toHeight: 5,
    scannedFrames: 5,
    events: [{
      id: 'adapter:1',
      height: 5,
      timestamp: 100,
      kind: 'offchain',
      type: 'payment',
      source: 'runtime_input',
      direction: 'out',
      title: 'Payment sent',
      subtitle: '7 token 1',
      status: 'committed',
      entityId,
      amount: '7000000000000000000',
      rawType: 'directPayment',
    }],
  }, query);

  expect(page.ok).toBe(true);
  expect(page.latestHeight).toBe(5);
  expect(page.scannedFrames).toBe(5);
  expect(page.failures).toBeUndefined();
  expect(page.events.map((event) => event.id)).toEqual(['adapter:1']);
});

test('activity history identifies transient browser storage read failures', () => {
  expect(isTransientActivityReadError(new Error('Database is not open'))).toBe(true);
  expect(isTransientActivityReadError(new Error('Iterator is not open'))).toBe(true);
  expect(isTransientActivityReadError(new Error('cannot call next() after close'))).toBe(true);
  expect(isTransientActivityReadError(new Error('ACTIVITY_HISTORY_READ_FAILED'))).toBe(false);
});
