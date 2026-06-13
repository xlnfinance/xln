/**
 * Shared default token catalog for dev/testnets.
 */

export const DEFAULT_TOKEN_DECIMALS = 18;
export const DEFAULT_TOKEN_SUPPLY = 1_000_000_000_000n * 10n ** 18n; // 1T tokens
export const DEFAULT_SIGNER_FAUCET = 1_000_000_000n * 10n ** 18n; // 1B tokens
export const TOKEN_REGISTRATION_AMOUNT = 1n;

export type DefaultTokenDefinition = {
  symbol: string;
  name: string;
  decimals: number;
};

export const DEFAULT_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', decimals: DEFAULT_TOKEN_DECIMALS },
  { symbol: 'WETH', name: 'Wrapped Ether', decimals: DEFAULT_TOKEN_DECIMALS },
  { symbol: 'USDT', name: 'Tether USD', decimals: DEFAULT_TOKEN_DECIMALS },
] satisfies DefaultTokenDefinition[];

export const TRON_ONLY_DEFAULT_TOKENS = [
  { symbol: 'TRX', name: 'Tron Native', decimals: DEFAULT_TOKEN_DECIMALS },
  { symbol: 'SUN', name: 'Sun Token', decimals: DEFAULT_TOKEN_DECIMALS },
] satisfies DefaultTokenDefinition[];

export function defaultTokensForJurisdiction(input?: { name?: string | null; chainId?: number | null } | string | null): DefaultTokenDefinition[] {
  const name = typeof input === 'string' ? input : String(input?.name || '');
  const chainId = typeof input === 'string' ? null : Number(input?.chainId);
  const normalized = name.trim().toLowerCase();
  const hasExplicitName = normalized.length > 0;
  const isTron = normalized.includes('tron') || normalized === 'rpc2' || (!hasExplicitName && chainId === 31338);
  return isTron ? [...DEFAULT_TOKENS, ...TRON_ONLY_DEFAULT_TOKENS] : [...DEFAULT_TOKENS];
}
