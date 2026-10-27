import { expect, test } from 'bun:test';
import { getSwapPairPolicyByBaseQuote } from '@xln/core/account/utils';
import { getAssetUsdMicros } from '@xln/frontend/lib/utils/assetPricing';

test('the WETH reference price is the market maker mid, so a swap never looks like it grew the balance', () => {
  // Pair 2/1 is WETH/USDC; ticks carry four decimals, USD micros six.
  const midTicks = getSwapPairPolicyByBaseQuote(2, 1).mmMidPriceTicks;
  expect(getAssetUsdMicros('WETH')).toBe(midTicks * 100n);
  expect(getAssetUsdMicros('ETH')).toBe(midTicks * 100n);
});
