import { expect, test } from 'bun:test';
import { getSwapPairPolicyByBaseQuote } from '@xln/core/account/utils';
import { getAssetUsdMicros } from '@xln/frontend/lib/utils/assetPricing';

test('UI valuation and the market maker mid read the one committed reference rate', () => {
  // Pair 2/1 is WETH/USDC; ticks carry four decimals, USD micros six.
  const midTicks = getSwapPairPolicyByBaseQuote(2, 1).mmMidPriceTicks;
  expect(getAssetUsdMicros('WETH')).toBe(midTicks * 100n);
  expect(getAssetUsdMicros('ETH')).toBe(midTicks * 100n);
  expect(getAssetUsdMicros('TRX')).toBe(getSwapPairPolicyByBaseQuote(4, 1).mmMidPriceTicks * 100n);
  expect(getAssetUsdMicros('USDC')).toBe(1_000_000n);
  expect(getAssetUsdMicros('UNKNOWN')).toBe(0n);
});
