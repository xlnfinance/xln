import { describe, expect, test } from 'bun:test';

import {
  ORDERBOOK_LOT_SCALE,
  formatSwapTokenAmount,
  formatSwapTokenAmountForInput,
  parseSwapDisplayPriceTicks,
  requantizeSwapOrderAtLimitPrice,
} from '../../frontend/src/lib/components/Entity/swap-order-math';

describe('swap order math', () => {
  test('formats token amounts for display and bounded inputs', () => {
    expect(formatSwapTokenAmount(1234500000n, 6)).toBe('1234.5');
    expect(formatSwapTokenAmount(1000000n, 6)).toBe('1');
    expect(formatSwapTokenAmountForInput(123456789n, 8)).toBe('1.234567');
    expect(formatSwapTokenAmountForInput(100000000n, 8)).toBe('1');
  });

  test('requantizes sell-base orders by base lot size', () => {
    expect(requantizeSwapOrderAtLimitPrice({
      remainingGiveAmount: 3n * ORDERBOOK_LOT_SCALE + 5n,
      priceTicks: 20_000n,
      orderMode: 'sell-base',
      tradeSide: 'buy-base',
    })).toEqual({
      side: 1,
      priceTicks: 20_000n,
      effectiveGive: 3n * ORDERBOOK_LOT_SCALE,
      effectiveWant: 6n * ORDERBOOK_LOT_SCALE,
      unspentGiveAmount: 5n,
    });
  });

  test('requantizes buy-base orders from quote amount to base lot size', () => {
    expect(requantizeSwapOrderAtLimitPrice({
      remainingGiveAmount: 7n * ORDERBOOK_LOT_SCALE,
      priceTicks: 20_000n,
      orderMode: 'buy-base',
      tradeSide: 'sell-base',
    })).toEqual({
      side: 0,
      priceTicks: 20_000n,
      effectiveGive: 6n * ORDERBOOK_LOT_SCALE,
      effectiveWant: 3n * ORDERBOOK_LOT_SCALE,
      unspentGiveAmount: 1n * ORDERBOOK_LOT_SCALE,
    });
  });

  test('parses display price ticks with fallback for invalid values', () => {
    expect(parseSwapDisplayPriceTicks('1.2345', 999n)).toBe(12_345n);
    expect(parseSwapDisplayPriceTicks('0', 999n)).toBe(999n);
    expect(parseSwapDisplayPriceTicks('bad', 999n)).toBe(999n);
  });
});
