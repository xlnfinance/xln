import { useApp } from './store';

export type TokenMeta = { symbol: string; name: string; decimals: number; color: string };

const UNKNOWN_TOKEN: TokenMeta = { symbol: '?', name: 'Unknown', decimals: 18, color: '#888888' };

/** Token ids belong to a Depository, so the active chain owns their metadata. */
function activeTokens() {
  return useApp.getState().externalRows;
}

export function getTokenMeta(tokenId: number): TokenMeta {
  const token = activeTokens().find(token => Number(token.tokenId) === tokenId);
  return token ? { symbol: token.symbol, name: token.name, decimals: token.decimals, color: '#2775ca' } : UNKNOWN_TOKEN;
}

export function knownTokenIds(): number[] {
  return activeTokens().map(token => Number(token.tokenId));
}
