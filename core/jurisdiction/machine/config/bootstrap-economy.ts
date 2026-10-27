import { asTokenId } from '../../../account/tx/units';
import { CATALOG_TOKENS } from './default-tokens';
import { wholeUsdToTokenAmount } from './usd-reference-rate';

const BOOTSTRAP_USD_NOTIONAL = 2_000_000n;

export const getBootstrapTokenAmount = (tokenId: number, decimals: number): bigint => {
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new Error(`BOOTSTRAP_TOKEN_ID_INVALID:${String(tokenId)}`);
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`BOOTSTRAP_TOKEN_DECIMALS_INVALID:${String(decimals)}`);
  }
  const token = CATALOG_TOKENS[tokenId - 1];
  if (token && decimals !== token.decimals) {
    throw new Error(`BOOTSTRAP_TOKEN_DECIMALS_MISMATCH:${tokenId}:${decimals}`);
  }
  return wholeUsdToTokenAmount(asTokenId(tokenId), BOOTSTRAP_USD_NOTIONAL);
};

export const getBootstrapTokenAmountBySymbol = (symbol: string, decimals: number): bigint => {
  const normalized = symbol.trim().toUpperCase();
  const index = CATALOG_TOKENS.findIndex(token => token.symbol === normalized);
  if (index < 0) throw new Error(`BOOTSTRAP_TOKEN_SYMBOL_UNKNOWN:${symbol}`);
  return getBootstrapTokenAmount(index + 1, decimals);
};
