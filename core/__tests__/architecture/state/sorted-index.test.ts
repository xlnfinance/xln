import { expect, test } from 'bun:test';

import { sortedStringMapKeys } from '../../../support/collections/sorted-map-index';

test('sorted string map index tracks delete plus insert without stale keys', () => {
  const map = new Map<string, number>([
    ['a', 1],
    ['c', 3],
  ]);

  expect(sortedStringMapKeys(map)).toEqual(['a', 'c']);

  expect(map.delete('a')).toBe(true);
  map.set('b', 2);

  expect(sortedStringMapKeys(map)).toEqual(['b', 'c']);
});

test('sorted string map index tracks live upserts after an earlier read', () => {
  const map = new Map<string, number>([['b', 2]]);

  expect(sortedStringMapKeys(map)).toEqual(['b']);
  map.set('a', 1);
  map.set('c', 3);
  map.set('b', 20);

  expect(sortedStringMapKeys(map)).toEqual(['a', 'b', 'c']);
  expect(map.get('b')).toBe(20);
});
