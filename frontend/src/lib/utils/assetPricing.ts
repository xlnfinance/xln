const USD_MICROS_BY_SYMBOL: Record<string, bigint> = {
  USDC: 1_000_000n,
  USDT: 1_000_000n,
  ETH: 3_500_000_000n,
  WETH: 3_500_000_000n,
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
  const priceMicros = getAssetUsdMicros(symbol);
  if (amount <= 0n || priceMicros <= 0n) return 0n;
  const normalizedDecimals = Math.max(0, Math.min(18, Math.floor(decimals)));
  const scale = 10n ** BigInt(normalizedDecimals);
  return (amount * priceMicros) / scale;
}

export function amountToUsd(amount: bigint, decimals: number, symbol: string): number {
  const usdMicros = amountToUsdMicros(amount, decimals, symbol);
  return Number(usdMicros) / 1_000_000;
}
