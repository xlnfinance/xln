import { describe, expect, test } from 'bun:test';
import { aggregateExpectedCrossBookDepth } from '../utils/e2e-cross-book-depth';

describe('cross-j configured public book depth', () => {
  test('aggregates reciprocal directed health into the visible bid/ask book', () => {
    const depth = aggregateExpectedCrossBookDepth(
      [
        { pairId: 'cross:a/b', expectedOffers: 2, expectedBidOffers: 0, expectedAskOffers: 2 },
        { pairId: 'cross:b/a', expectedOffers: 2, expectedBidOffers: 2, expectedAskOffers: 0 },
      ],
      'cross:a/b',
    );

    expect(depth).toEqual({ expectedOffers: 4, expectedBidOffers: 2, expectedAskOffers: 2 });
  });

  test('fails loud when canonical health omits the selected pair', () => {
    expect(() => aggregateExpectedCrossBookDepth([], 'cross:a/b')).toThrow('CROSS_PAIR_HEALTH_MISSING:cross:a/b');
  });
});
