export const BOOTSTRAP_USD_NOTIONAL = 2_000_000n;
export const BOOTSTRAP_WETH_USD_RATE = 1_000n;

const bootstrapWholeTokens = (tokenId: number): bigint =>
  tokenId === 2
    ? BOOTSTRAP_USD_NOTIONAL / BOOTSTRAP_WETH_USD_RATE
    : BOOTSTRAP_USD_NOTIONAL;

export const getBootstrapTokenAmount = (tokenId: number, decimals: number): bigint => {
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new Error(`BOOTSTRAP_TOKEN_ID_INVALID:${String(tokenId)}`);
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`BOOTSTRAP_TOKEN_DECIMALS_INVALID:${String(decimals)}`);
  }
  return bootstrapWholeTokens(tokenId) * 10n ** BigInt(decimals);
};

export const getBootstrapTokenAmountBySymbol = (symbol: string, decimals: number): bigint =>
  getBootstrapTokenAmount(String(symbol || '').trim().toUpperCase() === 'WETH' ? 2 : 1, decimals);
