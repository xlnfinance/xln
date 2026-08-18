import { expect, test } from 'bun:test';

import { computeIntegrityDigest } from '../../../support/integrity-checksum';
import { PersistentRadixValueMap } from '../../../protocol/state/persistent-radix-value-map';

const keyBytes = (key: string): Uint8Array => Uint8Array.from(
  key.match(/../g)?.map(byte => Number.parseInt(byte, 16)) ?? [],
);

const options = {
  radix: 16 as const,
  ownKey: (key: string): string => key,
  keyBytes,
  valueHash: (value: string) => computeIntegrityDigest(new TextEncoder().encode(value)),
  ownValue: (value: string) => value,
};

test('prefix extrema walk only the selected Patricia subtree', () => {
  const map = PersistentRadixValueMap.fromMap([
    ['010000', 'price-1-page-0'],
    ['010001', 'price-1-page-1'],
    ['020000', 'price-2-page-0'],
    ['02ffff', 'price-2-page-max'],
    ['030000', 'price-3-page-0'],
  ], options);
  expect(map.firstEntryWithPrefix(Uint8Array.of(2))).toEqual(['020000', 'price-2-page-0']);
  expect(map.lastEntryWithPrefix(Uint8Array.of(2))).toEqual(['02ffff', 'price-2-page-max']);
  expect(map.firstEntryWithPrefix(Uint8Array.of(4))).toBeUndefined();
});

test('prefix extrema work when compressed branch starts below the prefix', () => {
  const map = PersistentRadixValueMap.fromMap([
    ['aabb00', 'first'],
    ['aabbff', 'last'],
  ], options);
  expect(map.firstEntryWithPrefix(Uint8Array.of(0xaa))).toEqual(['aabb00', 'first']);
  expect(map.lastEntryWithPrefix(Uint8Array.of(0xaa, 0xbb))).toEqual(['aabbff', 'last']);
});
