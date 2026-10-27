import { requireTokenDecimals } from '#lib/components/Entity/token-metadata.ts';

// ETH matches the WETH/USDC market maker mid (core/account/utils.ts, mmMidPriceTicks 2500.0000);
// a different figure here made a swap look like it grew the balance.
const USD_MICROS_BY_SYMBOL: Record<string, bigint> = {
  USDC: 1_000_000n,
  USDT: 1_000_000n,
  ETH: 2_500_000_000n,
  WETH: 2_500_000_000n,
};

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

export function getAssetUsdPrice(symbol: string): number {
  const micros = USD_MICROS_BY_SYMBOL[normalizeSymbol(symbol)] ?? 0n;
  return Number(micros) / 1_000_000;
}

export function getAssetUsdMicros(symbol: string): bigint {
  return USD_MICROS_BY_SYMBOL[normalizeSymbol(symbol)] ?? 0n;
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
