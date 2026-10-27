/**
 * Shared default token catalog for dev/testnets.
 */

const DEFAULT_TOKEN_SUPPLY_UNITS = 1_000_000_000_000n;
export const TOKEN_REGISTRATION_AMOUNT = 1n;

export type DefaultTokenDefinition = {
  symbol: string;
  name: string;
  decimals: number;
  /**
   * Committed reference rate: integer USD micros per one whole token. Every
   * protocol USD amount (rebalance fee/policy, credit-request cap, MM mid) and
   * UI valuation derives from this one value. Rust twin:
   * `rscore/crates/protocol/src/tokens.rs`. Never read from env or a feed.
   */
  usdMicros: bigint;
};

export const DEFAULT_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', decimals: 6, usdMicros: 1_000_000n },
  { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, usdMicros: 2_500_000_000n },
  { symbol: 'USDT', name: 'Tether USD', decimals: 6, usdMicros: 1_000_000n },
] satisfies DefaultTokenDefinition[];

const TRON_ONLY_DEFAULT_TOKENS = [
  { symbol: 'TRX', name: 'Tron Native', decimals: 6, usdMicros: 120_000n },
  { symbol: 'SUN', name: 'Sun Token', decimals: 18, usdMicros: 20_000n },
] satisfies DefaultTokenDefinition[];

/** Built-in token id N is `CATALOG_TOKENS[N - 1]`. */
export const CATALOG_TOKENS: readonly DefaultTokenDefinition[] = [...DEFAULT_TOKENS, ...TRON_ONLY_DEFAULT_TOKENS];

export function getDefaultTokenSupply(decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`TOKEN_DECIMALS_INVALID:${String(decimals)}`);
  }
  return DEFAULT_TOKEN_SUPPLY_UNITS * 10n ** BigInt(decimals);
}

export function defaultTokensForJurisdiction(input?: { name?: string | null; chainId?: number | null } | string | null): DefaultTokenDefinition[] {
  const name = typeof input === 'string' ? input : String(input?.name || '');
  const chainId = typeof input === 'string' ? null : Number(input?.chainId);
  const normalized = name.trim().toLowerCase();
  const hasExplicitName = normalized.length > 0;
  const isTron = normalized.includes('tron') || normalized === 'rpc2' || (!hasExplicitName && chainId === 31338);
  return isTron ? [...DEFAULT_TOKENS, ...TRON_ONLY_DEFAULT_TOKENS] : [...DEFAULT_TOKENS];
}
