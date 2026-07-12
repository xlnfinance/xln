export const BOOTSTRAP_USD_NOTIONAL = 1_000_000n;
export const BOOTSTRAP_WETH_USD_RATE = 1_000n;

const bootstrapWholeTokens = (tokenId: number): bigint =>
  tokenId === 2
    ? BOOTSTRAP_USD_NOTIONAL / BOOTSTRAP_WETH_USD_RATE
    : BOOTSTRAP_USD_NOTIONAL;

export const getBootstrapTokenAmount = (tokenId: number, decimals = 18): bigint => {
  const normalizedDecimals = Math.max(0, Math.floor(Number(decimals)));
  if (!Number.isFinite(normalizedDecimals)) throw new Error('BOOTSTRAP_TOKEN_DECIMALS_INVALID');
  return bootstrapWholeTokens(tokenId) * 10n ** BigInt(normalizedDecimals);
};

export const getBootstrapTokenAmountBySymbol = (symbol: string, decimals = 18): bigint =>
  getBootstrapTokenAmount(String(symbol || '').trim().toUpperCase() === 'WETH' ? 2 : 1, decimals);
