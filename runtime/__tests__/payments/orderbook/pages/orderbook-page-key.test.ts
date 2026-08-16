import { expect, test } from 'bun:test';

import {
  decodeBookPricePageKey,
  encodeBookPricePageKey,
  MAX_BOOK_PRICE_KEY_BYTES,
  MAX_BOOK_PRICE_PAGE_SEQUENCE,
  type BookPricePageKey,
} from '../../../../orderbook/pages/key';

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
};

test('price-page keys preserve numeric price then uint16 page order', () => {
  const keys: BookPricePageKey[] = [
    { priceTicks: 256n, pageSequence: 0 },
    { priceTicks: 1n, pageSequence: 1 },
    { priceTicks: 255n, pageSequence: MAX_BOOK_PRICE_PAGE_SEQUENCE },
    { priceTicks: 1n, pageSequence: 0 },
  ];
  const ordered = [...keys].sort((left, right) =>
    compareBytes(encodeBookPricePageKey(left), encodeBookPricePageKey(right)));
  expect(ordered).toEqual([
    { priceTicks: 1n, pageSequence: 0 },
    { priceTicks: 1n, pageSequence: 1 },
    { priceTicks: 255n, pageSequence: MAX_BOOK_PRICE_PAGE_SEQUENCE },
    { priceTicks: 256n, pageSequence: 0 },
  ]);
});

test('price-page key covers the full 255-byte positive price domain', () => {
  const maximum = (1n << BigInt(MAX_BOOK_PRICE_KEY_BYTES * 8)) - 1n;
  const key = { priceTicks: maximum, pageSequence: MAX_BOOK_PRICE_PAGE_SEQUENCE } as const;
  const encoded = encodeBookPricePageKey(key);
  expect(encoded).toHaveLength(258);
  expect(decodeBookPricePageKey(encoded)).toEqual(key);
  expect(() => encodeBookPricePageKey({
    priceTicks: maximum + 1n,
    pageSequence: 0,
  })).toThrow('BOOK_PAGE_PRICE_BYTES_EXCEEDED:256');
});

test('price-page key rejects zero price and page overflow', () => {
  expect(() => encodeBookPricePageKey({ priceTicks: 0n, pageSequence: 0 }))
    .toThrow('BOOK_PAGE_PRICE_INVALID:0');
  expect(() => encodeBookPricePageKey({
    priceTicks: 1n,
    pageSequence: MAX_BOOK_PRICE_PAGE_SEQUENCE + 1,
  })).toThrow('BOOK_PAGE_SEQUENCE_INVALID');
  expect(() => decodeBookPricePageKey(Uint8Array.of(2, 0, 1, 0, 0)))
    .toThrow('BOOK_PAGE_KEY_PRICE_NON_MINIMAL');
  expect(() => decodeBookPricePageKey(Uint8Array.of(1, 1, 0)))
    .toThrow('BOOK_PAGE_KEY_LENGTH_INVALID');
});
