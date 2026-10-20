import type { TokenCatalogEntry, TokenMeta } from '../../token-meta';

/** Metadata cannot be borrowed from another Depository when its local id is absent. */
export function tokenCatalogMeta(catalog: readonly TokenCatalogEntry[], tokenId: number): TokenMeta {
  const token = catalog.find(token => token.tokenId === tokenId);
  return token
    ? { symbol: token.symbol, name: token.name, decimals: token.decimals, color: '#2775ca' }
    : { symbol: '?', name: 'Unknown', decimals: 18, color: '#888888' };
}
