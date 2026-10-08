import { DEV_CHAIN_IDS } from '../../../jurisdiction/adapter/chain-ids';
import type { JTokenInfo } from '../../../jurisdiction/adapter/types';

/** Real networks use their registered assets; development defaults are not a deployment requirement. */
export const requiredHubTokenCount = (chainId: number): number => DEV_CHAIN_IDS.has(chainId) ? 3 : 1;
export const canDeployHubDefaultTokens = (chainId: number): boolean => DEV_CHAIN_IDS.has(chainId);
export const selectHubTokenCatalog = (catalog: JTokenInfo[], chainId: number, desiredTokenIds: readonly number[]): JTokenInfo[] => {
  if (!DEV_CHAIN_IDS.has(chainId)) return catalog;
  const desired = new Set(desiredTokenIds);
  const selected = catalog.filter(token => desired.has(Number(token.tokenId)));
  return selected.length >= 3 ? selected : catalog.slice(0, 3);
};
