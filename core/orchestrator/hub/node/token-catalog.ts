import { getTokenIdsForJurisdiction } from '../../../account/utils';
import { DEV_CHAIN_IDS } from '../../../jurisdiction/adapter/chain-ids';
import type { JTokenInfo } from '../../../jurisdiction/adapter/types';
import { DEFAULT_ACCOUNT_TOKEN_IDS, HUB_REQUIRED_TOKEN_COUNT } from '../../mesh/mesh-common';
import type { HubBootstrapEntry } from './hub-node-types';

/** Real networks use their registered assets; development defaults are not a deployment requirement. */
export const requiredHubTokenCount = (chainId: number): number => DEV_CHAIN_IDS.has(chainId) ? 3 : 1;
export const canDeployHubDefaultTokens = (chainId: number): boolean => DEV_CHAIN_IDS.has(chainId);
export const selectHubTokenCatalog = (catalog: JTokenInfo[], chainId: number, desiredTokenIds: readonly number[]): JTokenInfo[] => {
  if (!DEV_CHAIN_IDS.has(chainId)) return catalog;
  const desired = new Set(desiredTokenIds);
  const selected = catalog.filter(token => desired.has(Number(token.tokenId)));
  return selected.length >= 3 ? selected : catalog.slice(0, 3);
};

const normalizePositiveTokenIds = (tokenIds: readonly number[]): number[] =>
  Array.from(new Set(tokenIds.filter(tokenId => Number.isFinite(tokenId) && tokenId > 0).map(tokenId => Math.floor(tokenId))))
    .sort((a, b) => a - b);

export const tokenIdsForHubJurisdiction = (
  hub: Pick<HubBootstrapEntry, 'jurisdictionName' | 'chainId'>,
): number[] => {
  const jurisdictionTokenIds = normalizePositiveTokenIds(getTokenIdsForJurisdiction({
    name: hub.jurisdictionName,
    chainId: hub.chainId ?? null,
  }));
  return jurisdictionTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT
    ? jurisdictionTokenIds
    : [...DEFAULT_ACCOUNT_TOKEN_IDS];
};

export const tokenCatalogForHubJurisdiction = (
  tokenCatalog: JTokenInfo[],
  hub: Pick<HubBootstrapEntry, 'jurisdictionName' | 'chainId'>,
): JTokenInfo[] => {
  if (!hub.chainId) throw new Error('HUB_TOKEN_CATALOG_CHAIN_ID_MISSING');
  return selectHubTokenCatalog(tokenCatalog, hub.chainId, tokenIdsForHubJurisdiction(hub));
};
