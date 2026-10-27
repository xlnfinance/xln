import { requireTokenDecimals } from '#lib/components/Entity/token-metadata.ts';
import { CATALOG_TOKENS } from '@xln/core/jurisdiction/machine/config/default-tokens';

// Valuation reads the committed catalog reference rate, the same one the
// protocol and the market maker mid derive from; a second table here made a
// swap look like it grew the balance. Native ETH is valued as WETH.
export function getAssetUsdMicros(symbol: string): bigint {
  const normalized = String(symbol || '').trim().toUpperCase();
  const lookup = normalized === 'ETH' ? 'WETH' : normalized;
  return CATALOG_TOKENS.find(token => token.symbol === lookup)?.usdMicros ?? 0n;
}

export function getAssetUsdPrice(symbol: string): number {
  return Number(getAssetUsdMicros(symbol)) / 1_000_000;
}

export function amountToUsdMicros(amount: bigint, decimals: number, symbol: string): bigint {
  const exactDecimals = requireTokenDecimals(decimals, `asset:${symbol}`);
  const priceMicros = getAssetUsdMicros(symbol);
  if (amount <= 0n || priceMicros <= 0n) return 0n;
  const scale = 10n ** BigInt(exactDecimals);
  return (amount * priceMicros) / scale;
}

export function amountToUsd(amount: bigint, decimals: number, symbol: string): number {
  const usdMicros = amountToUsdMicros(amount, decimals, symbol);
  return Number(usdMicros) / 1_000_000;
}
