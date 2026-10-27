import { expect, test } from 'bun:test';
import { quoteAtBestLevel, swapMinimumError, swapPriceBandError } from './orderbook-quote';
import type { BookView } from './orderbook';

const level = {
  size: 2n * 10n ** 18n,
  priceTicks: 25_000_000n,
  total: 2n * 10n ** 18n,
  orders: 1,
  ownerIds: [],
  own: false,
};
const usdc = { decimals: 6, symbol: 'USDC' };
const book: BookView = {
  baseTokenId: 2,
  quoteTokenId: 1,
  minTradeSize: 10_000_000n,
  pairId: '1/2',
  asks: [level],
  bids: [level],
  spreadTicks: 0n,
  lastTradeTicks: null,
  status: 'live',
  source: 'relay',
  updatedAt: 1,
  error: null,
};
test('best-level quote preserves USDC and WETH raw units in both directions', () => {
  expect(quoteAtBestLevel(book, 1, 2, 25_000_000n, 18, 6)).toEqual({
    want: 10_000_000_000_000_000n,
    availableGive: 5_000_000_000n,
  });
  expect(quoteAtBestLevel(book, 2, 1, 10_000_000_000_000_001n, 18, 6)).toEqual({
    want: 25_000_000n,
    availableGive: 2_000_000_000_000_000_000n,
  });
});
test('an empty, zero-valued or mismatched market never produces a payable quote', () => {
  expect(quoteAtBestLevel({ ...book, asks: [] }, 1, 2, 1n, 18, 6)).toBeNull();
  expect(quoteAtBestLevel({ ...book, asks: [{ ...level, size: 1n }] }, 1, 2, 1n, 18, 6)).toBeNull();
  expect(quoteAtBestLevel(book, 1, 3, 1n, 18, 6)).toBeNull();
  expect(quoteAtBestLevel(book, 1, 2, 0n, 18, 6)).toBeNull();
});

test('minimum checks the rounded quote amount on either side and fails closed without policy', () => {
  const roundedBuy = { effectiveGive: 9_996_999n, effectiveWant: 3_998_000_000_000_000n };
  expect(swapMinimumError(book, 1, roundedBuy, usdc)).toBe('Minimum swap is 10 USDC after lot rounding.');
  expect(
    swapMinimumError(book, 2, { effectiveGive: roundedBuy.effectiveWant, effectiveWant: roundedBuy.effectiveGive }, usdc),
  ).toBe('Minimum swap is 10 USDC after lot rounding.');
  expect(swapMinimumError(book, 1, { ...roundedBuy, effectiveGive: 10_000_000n }, usdc)).toBeNull();
  expect(swapMinimumError({ ...book, minTradeSize: null }, 1, roundedBuy, usdc)).toBe('Waiting for the market minimum.');
  expect(swapMinimumError({ ...book, minTradeSize: 0n }, 1, roundedBuy, usdc)).toBeNull();
});

test('price band uses the canonical midpoint and accepts exact boundaries, not one tick outside', () => {
  const wide = {
    ...book,
    bids: [{ ...level, priceTicks: 20_000_000n }],
    asks: [{ ...level, priceTicks: 30_000_000n }],
  };
  const rejected = 'Price must stay within 30% of the current orderbook.';
  expect(swapPriceBandError(wide, 17_500_000n)).toBeNull();
  expect(swapPriceBandError(wide, 32_500_000n)).toBeNull();
  expect(swapPriceBandError(wide, 17_499_999n)).toBe(rejected);
  expect(swapPriceBandError(wide, 32_500_001n)).toBe(rejected);
  expect(swapPriceBandError(wide, 25_000_000n)).toBeNull();
});

test('single-sided books use their available side; an empty remote book cannot invent Entity policy', () => {
  const askOnly = { ...book, bids: [] };
  const bidOnly = { ...book, asks: [] };
  for (const single of [askOnly, bidOnly]) {
    expect(swapPriceBandError(single, 17_500_000n)).toBeNull();
    expect(swapPriceBandError(single, 32_500_000n)).toBeNull();
    expect(swapPriceBandError(single, 17_499_999n)).toBe('Price must stay within 30% of the current orderbook.');
    expect(swapPriceBandError(single, 32_500_001n)).toBe('Price must stay within 30% of the current orderbook.');
  }
  expect(swapPriceBandError({ bids: [], asks: [] }, 1n)).toBeNull();
});
