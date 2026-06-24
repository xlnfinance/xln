import { describe, expect, test } from 'bun:test';

import type { AccountMachine } from '../../runtime/types/account';
import type { FrontendXlnFunctions } from '../../frontend/src/lib/stores/xlnStore';
import {
  buildAccountPortfolioData,
  calculatePortfolioValueUsd,
  formatApproxUsd,
  formatCompactUsd,
  formatTokenAmount,
  formatTokenInputAmount,
  formatUsdExact,
  getAssetPriceUsd,
  getAssetValueUsd,
  getExternalTokenValueUsd,
  normalizeTokenPrecision,
  parsePositiveAssetAmount,
  parseTokenAmountInput,
} from '../../frontend/src/lib/components/Entity/entity-asset-values';

describe('entity asset value helpers', () => {
  test('normalizes token precision and formats token amounts', () => {
    expect(normalizeTokenPrecision(undefined)).toBe(4);
    expect(normalizeTokenPrecision(-1)).toBe(0);
    expect(normalizeTokenPrecision(99)).toBe(18);
    expect(formatTokenAmount(123456789n, 6, 4)).toBe('123.4567');
    expect(formatTokenAmount(-1200000n, 6, 4)).toBe('-1.2');
    expect(formatTokenAmount(1000000n, 6, 4)).toBe('1');
  });

  test('parses positive asset input and formats input values', () => {
    expect(parseTokenAmountInput('1.23456789', 6)).toBe(1_234_567n);
    expect(parseTokenAmountInput('.5', 6)).toBe(500_000n);
    expect(formatTokenInputAmount(1_230_000n, 6)).toBe('1.23');
    expect(formatTokenInputAmount(0n, 6)).toBe('');
    expect(parsePositiveAssetAmount(' 1.5 ', { decimals: 6 }, 2_000_000n)).toBe(1_500_000n);
    expect(() => parsePositiveAssetAmount('', { decimals: 6 })).toThrow('Amount is required');
    expect(() => parsePositiveAssetAmount('abc', { decimals: 6 })).toThrow('Invalid amount format');
    expect(() => parsePositiveAssetAmount('0', { decimals: 6 })).toThrow('Amount must be greater than zero');
    expect(() => parsePositiveAssetAmount('3', { decimals: 6 }, 2_000_000n)).toThrow('Amount exceeds available balance');
  });

  test('formats compact and exact USD labels', () => {
    expect(formatCompactUsd(1234.56, true)).toBe('$1.23K');
    expect(formatCompactUsd(1234.56, false)).toBe('$1,234.56');
    expect(formatApproxUsd(12, true)).toBe('~$12.00');
    expect(formatUsdExact(12)).toBe('$12.00');
  });

  test('computes reserve and external asset values', () => {
    expect(getAssetPriceUsd('USDC')).toBe(1);
    expect(getAssetValueUsd(2_500_000n, { symbol: 'USDC', decimals: 6 })).toBe(2.5);
    expect(getExternalTokenValueUsd({ symbol: 'USDT', decimals: 6, balance: 3_000_000n })).toBe(3);
    expect(calculatePortfolioValueUsd(new Map([[1, 2_000_000n]]), () => ({ symbol: 'USDC', decimals: 6 }))).toBe(2);
  });

  test('builds account portfolio totals from derived deltas', () => {
    const accounts = new Map<string, AccountMachine>([
      ['0xbb', { deltas: new Map([[1, Symbol('delta')]]) } as unknown as AccountMachine],
    ]);
    const deriveDelta = (() => ({
      outCapacity: 5_000_000n,
      inCapacity: 2_000_000n,
      outCollateral: 3_000_000n,
      outOwnCredit: 1_000_000n,
    })) as FrontendXlnFunctions['deriveDelta'];

    expect(buildAccountPortfolioData({
      accounts,
      localEntityId: '0xaa',
      deriveDelta,
      getTokenInfo: () => ({ symbol: 'USDC', decimals: 6 }),
    })).toEqual({
      outbound: 5,
      inbound: 2,
      outCollateral: 3,
      outOurCredit: 1,
      count: 1,
      total: 5,
    });
  });
});
