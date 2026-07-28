/**
 * Shared default token catalog for dev/testnets.
 */

export const DEFAULT_TOKEN_SUPPLY_UNITS = 1_000_000_000_000n;
export const TOKEN_REGISTRATION_AMOUNT = 1n;

export type DefaultTokenDefinition = {
  symbol: string;
  name: string;
  decimals: number;
};

export const DEFAULT_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
] satisfies DefaultTokenDefinition[];

export const TRON_ONLY_DEFAULT_TOKENS = [
  { symbol: 'TRX', name: 'Tron Native', decimals: 6 },
  { symbol: 'SUN', name: 'Sun Token', decimals: 18 },
] satisfies DefaultTokenDefinition[];

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
