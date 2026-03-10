const USD_PRICE_BY_SYMBOL: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  ETH: 3500,
  WETH: 3500,
};

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

export function getAssetUsdPrice(symbol: string): number {
  return USD_PRICE_BY_SYMBOL[normalizeSymbol(symbol)] ?? 0;
}

export function amountToUsd(amount: bigint, decimals: number, symbol: string): number {
  const priceUsd = getAssetUsdPrice(symbol);
  if (amount <= 0n || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  const normalizedDecimals = Math.max(0, Math.min(18, Math.floor(decimals)));
  const scale = 10n ** BigInt(normalizedDecimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  const wholeAsNumber = Number(whole);
  if (!Number.isFinite(wholeAsNumber)) return 0;
  const fractionMicros = Number((fraction * 1_000_000n) / scale) / 1_000_000;
  return (wholeAsNumber + fractionMicros) * priceUsd;
}
