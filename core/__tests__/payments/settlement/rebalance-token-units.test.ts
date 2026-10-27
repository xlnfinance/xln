import { describe, expect, test } from 'bun:test';

import {
  assertNoTokenlessHubRawOverrides,
  getDefaultRebalanceBaseFeeForToken,
  getDefaultRebalancePolicyForToken,
} from '../../../account/config/defaults';
import { dai, eth, usd } from '../../../scenarios/harness/helpers';
import { getBootstrapTokenAmount } from '../../../jurisdiction/machine/config/bootstrap-economy';

describe('rebalance defaults are USD amounts in token raw units', () => {
  test('USDC token 1 uses six-decimal raw amounts', () => {
    expect(getDefaultRebalancePolicyForToken(1)).toEqual({
      r2cRequestSoftLimit: 500n * 10n ** 6n,
      hardLimit: 10_000n * 10n ** 6n,
      maxAcceptableFee: 15n * 10n ** 6n,
    });
    expect(getDefaultRebalanceBaseFeeForToken(1)).toBe(10n ** 5n);
  });

  test('WETH token 2 converts the same USD amounts at the $2,500 reference rate', () => {
    expect(getDefaultRebalancePolicyForToken(2)).toEqual({
      r2cRequestSoftLimit: 2n * 10n ** 17n,
      hardLimit: 4n * 10n ** 18n,
      maxAcceptableFee: 6n * 10n ** 15n,
    });
    expect(getDefaultRebalanceBaseFeeForToken(2)).toBe(4n * 10n ** 13n);
  });

  test('TRX base fee floors $0.10 at the $0.12 reference rate', () => {
    expect(getDefaultRebalanceBaseFeeForToken(4)).toBe(833_333n);
  });

  test('a token without a catalog rate fails instead of assuming a price', () => {
    expect(() => getDefaultRebalancePolicyForToken(999_999))
      .toThrow('TOKEN_USD_RATE_UNAVAILABLE:999999');
  });

  test('tokenless raw amount overrides are rejected', () => {
    expect(() => assertNoTokenlessHubRawOverrides({ rebalanceBaseFee: 1n }))
      .toThrow('HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:rebalanceBaseFee');
    expect(() => assertNoTokenlessHubRawOverrides({ c2rWithdrawSoftLimit: 1n }))
      .toThrow('HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:c2rWithdrawSoftLimit');
    expect(() => assertNoTokenlessHubRawOverrides({ rebalanceGasFee: 1n }))
      .toThrow('HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:rebalanceGasFee');
    expect(() => assertNoTokenlessHubRawOverrides({ rebalanceGasFee: 0n }))
      .toThrow('HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN:rebalanceGasFee');
  });

  test('scenario whole-token helpers use canonical token precision', () => {
    expect(usd(1)).toBe(10n ** 6n);
    expect(eth(1)).toBe(10n ** 18n);
    expect(dai(1)).toBe(10n ** 6n);
  });

  test('bootstrap amounts reject incomplete trusted token metadata', () => {
    expect(() => getBootstrapTokenAmount(Number.NaN, 6))
      .toThrow('BOOTSTRAP_TOKEN_ID_INVALID:NaN');
    expect(() => getBootstrapTokenAmount(1, Number.NaN))
      .toThrow('BOOTSTRAP_TOKEN_DECIMALS_INVALID:NaN');
  });
});
