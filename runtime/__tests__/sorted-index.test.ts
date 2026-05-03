import { expect, test } from 'bun:test';

import { sortedStringMapKeys, upsertSortedStringMapEntry } from '../sorted-index';

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

test('sorted string map index tracks helper upserts after cache warmup', () => {
  const map = new Map<string, number>([['b', 2]]);

  expect(sortedStringMapKeys(map)).toEqual(['b']);
  upsertSortedStringMapEntry(map, 'a', 1);
  upsertSortedStringMapEntry(map, 'c', 3);
  upsertSortedStringMapEntry(map, 'b', 20);

  expect(sortedStringMapKeys(map)).toEqual(['a', 'b', 'c']);
  expect(map.get('b')).toBe(20);
});
