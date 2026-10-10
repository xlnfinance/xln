import { getTokenIdsForJurisdiction } from '../../../account/utils';
import { DEV_CHAIN_IDS } from '../../../jurisdiction/adapter/chain-ids';
import { deployMissingDefaultTokens } from '../../../jurisdiction/adapter/operations/dev-token-deployment';
import type { JAdapter, JTokenInfo } from '../../../jurisdiction/adapter/types';
import { defaultTokensForJurisdiction } from '../../../jurisdiction/machine/config/default-tokens';
import { DEFAULT_ACCOUNT_TOKEN_IDS, HUB_REQUIRED_TOKEN_COUNT, sleep } from '../../mesh/mesh-common';
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

export const ensureTokenCatalog = async (jadapter: JAdapter, allowDeploy: boolean, jurisdictionName = ''): Promise<JTokenInfo[]> => {
  const current = await jadapter.getTokenRegistry();
  if (!canDeployHubDefaultTokens(jadapter.chainId)) {
    if (current.length >= requiredHubTokenCount(jadapter.chainId)) return current;
    throw new Error(`TOKEN_CATALOG_EMPTY:chainId=${jadapter.chainId}`);
  }
  const desiredTokens = defaultTokensForJurisdiction({
    name: jurisdictionName,
    chainId: Number((jadapter as { chainId?: number }).chainId),
  });
  const existingSymbols = new Set(
    current
      .map(token => String(token.symbol || '').trim().toUpperCase())
      .filter(Boolean),
  );
  const hasDesiredTokens = desiredTokens.every(token => existingSymbols.has(token.symbol.trim().toUpperCase()));
  if (current.length >= HUB_REQUIRED_TOKEN_COUNT && hasDesiredTokens) return current;
  if (allowDeploy) {
    await deployMissingDefaultTokens(jadapter, jurisdictionName);
    return await waitForTokenCatalog(jadapter);
  }
  throw new Error(`TOKEN_CATALOG_INCOMPLETE required=${HUB_REQUIRED_TOKEN_COUNT} actual=${current.length}`);
};

export const waitForTokenCatalog = async (jadapter: JAdapter, rounds = 80): Promise<JTokenInfo[]> => {
  let lastReadError: unknown = null;
  for (let i = 0; i < rounds; i += 1) {
    try {
      const tokens = await jadapter.getTokenRegistry();
      if (tokens.length >= requiredHubTokenCount(jadapter.chainId)) return tokens;
      lastReadError = null;
    } catch (error) {
      lastReadError = error;
    }
    await sleep(250);
  }
  if (lastReadError) {
    const message = lastReadError instanceof Error ? lastReadError.message : String(lastReadError);
    throw new Error(`TOKEN_CATALOG_READ_FAILED:${message}`, { cause: lastReadError });
  }
  throw new Error(`TOKEN_CATALOG_INCOMPLETE required=${requiredHubTokenCount(jadapter.chainId)}`);
};
