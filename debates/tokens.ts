export type DebateToken = {
  tokenId: number;
  symbol: string;
  name: string;
  decimals: number;
  accent: string;
};

export const TOKENS: DebateToken[] = [
  { tokenId: 1, symbol: 'USDC', name: 'USD Coin', decimals: 18, accent: '#15c47e' },
  { tokenId: 2, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, accent: '#2cc7ff' },
  { tokenId: 3, symbol: 'USDT', name: 'Tether USD', decimals: 18, accent: '#e7b84b' },
];

export const getToken = (tokenId: number): DebateToken =>
  TOKENS.find(token => token.tokenId === tokenId) || TOKENS[0]!;

export const parseTokenAmount = (tokenId: number, raw: string): bigint => {
  const token = getToken(tokenId);
  const value = String(raw || '').trim();
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Amount must be a positive decimal');
  const [whole = '0', frac = ''] = value.split('.');
  if (frac.length > token.decimals) throw new Error(`${token.symbol} supports ${token.decimals} decimals`);
  const padded = frac.padEnd(token.decimals, '0');
  return BigInt(whole) * 10n ** BigInt(token.decimals) + BigInt(padded || '0');
};

export const formatTokenAmount = (tokenId: number, amountMinor: bigint): string => {
  const token = getToken(tokenId);
  const scale = 10n ** BigInt(token.decimals);
  const whole = amountMinor / scale;
  const fraction = amountMinor % scale;
  if (fraction === 0n) return whole.toString();
  let frac = fraction.toString().padStart(token.decimals, '0');
  while (frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole}.${frac.slice(0, 6)}`;
};
