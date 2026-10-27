import { expect, test } from 'bun:test';
import { asTokenId, asTokenDecimals, type TokenId, type TokenDecimals } from '@xln/core/account/tx/units';
import { getTokenInfo } from '@xln/core/account/utils';
import {
  getTokenUsdMicros,
  hasTokenUsdRate,
  usdMicrosToTokenAmount,
  wholeUsdToTokenAmount,
} from '@xln/core/jurisdiction/machine/config/usd-reference-rate';
import {
  getHubOpeningCredit,
  getOpenAccountRebalancePolicyData,
} from '@xln/frontend/lib/utils/onboarding/onboardingPreferences';
import {
  formatAmount,
  formatLimit,
  formatMoney,
  formatSigned,
  parseAmount,
  amountInputText,
  splitAmountForDisplay,
} from './format';
import type { TokenCatalogEntry, TokenMeta } from './token-meta';

// Compiled by the wallet type gate. Never execute the deliberately invalid calls.
export function rejectConfusedTokenUnits(id: TokenId, decimals: TokenDecimals): void {
  // @ts-expect-error A decimal count cannot select a USD reference rate.
  getTokenUsdMicros(decimals);
  // @ts-expect-error A decimal count cannot select a catalog entry.
  hasTokenUsdRate(decimals);
  // @ts-expect-error The old decimals-taking signature must never return.
  wholeUsdToTokenAmount(decimals, 1n);
  // @ts-expect-error Same invariant for fractional USD amounts.
  usdMicrosToTokenAmount(decimals, 1n);
  // @ts-expect-error Regression: WETH decimals (18) are not WETH's token id (2).
  getHubOpeningCredit(getTokenInfo(2).decimals);
  // @ts-expect-error Rebalance policy takes an identity, not a decimal count.
  getOpenAccountRebalancePolicyData(decimals);
  // @ts-expect-error Unvalidated plain numbers cannot enter onboarding.
  getHubOpeningCredit(6);
  // @ts-expect-error Parsing must not interpret an identity as precision.
  parseAmount('1', id);
  // @ts-expect-error formatAmount takes precision, not identity.
  formatAmount(1n, id);
  // @ts-expect-error formatLimit takes precision, not identity.
  formatLimit(1n, id);
  // @ts-expect-error formatMoney takes precision, not identity.
  formatMoney(1n, id);
  // @ts-expect-error formatSigned takes precision, not identity.
  formatSigned(1n, id);
  // @ts-expect-error amountInputText takes precision, not identity.
  amountInputText(1n, id);
  // @ts-expect-error splitAmountForDisplay takes precision, not identity.
  splitAmountForDisplay(1n, id);
}

test('validated units retain number identity and exact catalog amounts', () => {
  const token: TokenCatalogEntry = {
    tokenId: asTokenId(2),
    decimals: getTokenInfo(2).decimals,
    symbol: 'WETH',
    name: 'Wrapped Ether',
  };
  const metadata: TokenMeta = { ...token, color: '#627eea' };
  expect(JSON.stringify({ tokenId: token.tokenId, decimals: metadata.decimals })).toBe('{"tokenId":2,"decimals":18}');
  expect(getHubOpeningCredit(token.tokenId)).toBe(4n * 10n ** 18n);
  expect(parseAmount('4', metadata.decimals)).toBe(getHubOpeningCredit(token.tokenId));
  expect(wholeUsdToTokenAmount(asTokenId(1), 10_000n)).toBe(10_000_000_000n);
});

test('unit boundaries reject invalid numbers without rounding', () => {
  for (const value of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => asTokenId(value)).toThrow('ACCOUNT_TX_TOKEN_ID_INVALID');
    expect(() => asTokenDecimals(value)).toThrow('TOKEN_DECIMALS_INVALID');
  }
  expect(Number(asTokenId(0))).toBe(0);
  expect(Number(asTokenId(65_535))).toBe(65_535);
  expect(() => asTokenId(65_536)).toThrow('ACCOUNT_TX_TOKEN_ID_INVALID');
  expect(Number(asTokenDecimals(0))).toBe(0);
  expect(Number(asTokenDecimals(255))).toBe(255);
  expect(() => asTokenDecimals(256)).toThrow('TOKEN_DECIMALS_INVALID');
});
