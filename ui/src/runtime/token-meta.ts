import { useApp } from './store';
import { tokenCatalogMeta } from './financial/swap-assets/metadata';

export type TokenMeta = { symbol: string; name: string; decimals: number; color: string };
export type TokenCatalogEntry = Omit<TokenMeta, 'color'> & { tokenId: number };

/** Token ids belong to a Depository, so the active chain owns their metadata. */
function activeTokens() {
  return useApp.getState().tokenCatalog;
}

export function getTokenMeta(tokenId: number, catalog: readonly TokenCatalogEntry[] = activeTokens()): TokenMeta {
  return tokenCatalogMeta(catalog, tokenId);
}

export function knownTokenIds(catalog: readonly TokenCatalogEntry[] = activeTokens()): number[] {
  return catalog.map(token => Number(token.tokenId));
}
