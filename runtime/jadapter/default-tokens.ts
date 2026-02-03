/**
 * Shared default token catalog for dev/testnets.
 */

export const DEFAULT_TOKEN_DECIMALS = 18;
export const DEFAULT_TOKEN_SUPPLY = 1_000_000_000_000n * 10n ** 18n; // 1T tokens
export const DEFAULT_SIGNER_FAUCET = 1_000_000_000n * 10n ** 18n; // 1B tokens
export const TOKEN_REGISTRATION_AMOUNT = 1n;

export const DEFAULT_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', decimals: DEFAULT_TOKEN_DECIMALS },
  { symbol: 'WETH', name: 'Wrapped Ether', decimals: DEFAULT_TOKEN_DECIMALS },
  { symbol: 'USDT', name: 'Tether USD', decimals: DEFAULT_TOKEN_DECIMALS },
];
