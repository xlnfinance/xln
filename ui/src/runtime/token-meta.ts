import type { TokenId, TokenDecimals } from '@xln/core/account/tx/units';
import { useApp } from './store';
import { tokenCatalogMeta } from './financial/swap-assets/metadata';

export type TokenMeta = { symbol: string; name: string; decimals: TokenDecimals; color: string };
export type TokenCatalogEntry = Omit<TokenMeta, 'color'> & { tokenId: TokenId };

/** Token ids belong to a Depository, so the active chain owns their metadata. */
function activeTokens() {
  return useApp.getState().tokenCatalog;
}

export function getTokenMeta(tokenId: number, catalog: readonly TokenCatalogEntry[] = activeTokens()): TokenMeta {
  return tokenCatalogMeta(catalog, tokenId);
}

export function knownTokenIds(catalog: readonly TokenCatalogEntry[] = activeTokens()): TokenId[] {
  return catalog.map(token => token.tokenId);
}
