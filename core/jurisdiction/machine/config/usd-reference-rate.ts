/**
 * Deterministic USD reference pricing for built-in catalog tokens.
 *
 * Everything priced "in dollars" (rebalance base fee and policy, the
 * credit-request cap, the MM policy mid, UI valuation) converts through the one
 * committed `usdMicros` rate in `CATALOG_TOKENS`. Both Account sides and the
 * Rust twin (`rscore/crates/protocol/src/tokens.rs`) floor identically, so the
 * raw amounts agree byte for byte. A live orderbook mid never enters here.
 */
import { CATALOG_TOKENS, type DefaultTokenDefinition } from './default-tokens';

const USD_MICROS_PER_DOLLAR = 1_000_000n;

const catalogToken = (tokenId: number): DefaultTokenDefinition | undefined =>
  Number.isSafeInteger(tokenId) && tokenId > 0 ? CATALOG_TOKENS[tokenId - 1] : undefined;

const requireCatalogToken = (tokenId: number): DefaultTokenDefinition => {
  const token = catalogToken(tokenId);
  if (!token) throw new Error(`TOKEN_USD_RATE_UNAVAILABLE:${String(tokenId)}`);
  return token;
};

export const hasTokenUsdRate = (tokenId: number): boolean => catalogToken(tokenId) !== undefined;

export const getTokenUsdMicros = (tokenId: number): bigint => requireCatalogToken(tokenId).usdMicros;

/** Floor of `usdMicros` worth of the token in raw units; a positive USD amount never becomes zero. */
export const usdMicrosToTokenAmount = (tokenId: number, usdMicros: bigint): bigint => {
  if (usdMicros < 0n) throw new Error(`USD_AMOUNT_NEGATIVE:token=${tokenId}:usdMicros=${usdMicros}`);
  const { decimals, usdMicros: rate } = requireCatalogToken(tokenId);
  const amount = (usdMicros * 10n ** BigInt(decimals)) / rate;
  if (usdMicros > 0n && amount === 0n) {
    throw new Error(`USD_AMOUNT_UNREPRESENTABLE:token=${tokenId}:usdMicros=${usdMicros}`);
  }
  return amount;
};

export const wholeUsdToTokenAmount = (tokenId: number, dollars: bigint): bigint =>
  usdMicrosToTokenAmount(tokenId, dollars * USD_MICROS_PER_DOLLAR);
