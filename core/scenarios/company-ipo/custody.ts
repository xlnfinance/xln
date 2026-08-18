/**
 * Registers the company's two ERC1155 share classes in Depository and releases
 * them through the quorum-authenticated EntityProvider action. The resulting
 * ReserveUpdated events are the sole authority for Runtime custody balances.
 */

import type { RuntimeReplica } from '../../runtime/types';
import { syncChain } from '../harness/helpers';
import { executeCompanyAction } from './governance';
import {
  CONTROL_SUPPLY,
  DIVIDEND_SUPPLY,
  type CompanyActor,
  type CompanyScenarioActors,
  type CompanyShareTokens,
} from './model';

const DIVIDEND_CLASS_BIT = 1n << 255n;

const resolveCompanyShareTokens = async (
  actors: CompanyScenarioActors,
  company: CompanyActor,
): Promise<CompanyShareTokens> => {
  const entityNumber = BigInt(company.id);
  const controlExternalTokenId = entityNumber;
  const dividendExternalTokenId = entityNumber | DIVIDEND_CLASS_BIT;
  const registry = await actors.jadapter.getTokenRegistry();
  const entityProviderAddress = actors.jadapter.addresses.entityProvider.toLowerCase();
  const companyClasses = registry.filter(candidate =>
    candidate.tokenType === 2 &&
    candidate.address.toLowerCase() === entityProviderAddress &&
    (candidate.externalTokenId & ~DIVIDEND_CLASS_BIT) === entityNumber);
  if (companyClasses.length !== 2) {
    throw new Error(`COMPANY_SHARE_CLASS_COUNT_INVALID:${companyClasses.length}`);
  }
  const find = (externalTokenId: bigint): number => {
    const token = registry.find(candidate =>
      candidate.tokenType === 2 &&
      candidate.address.toLowerCase() === entityProviderAddress &&
      candidate.externalTokenId === externalTokenId);
    if (!token) throw new Error(`COMPANY_SHARE_TOKEN_METADATA_MISSING:${externalTokenId}`);
    if (token.decimals !== 0) throw new Error(`COMPANY_SHARE_DECIMALS_INVALID:${token.tokenId}:${token.decimals}`);
    return token.tokenId;
  };
  const controlTokenId = find(controlExternalTokenId);
  const dividendTokenId = find(dividendExternalTokenId);
  return { controlTokenId, dividendTokenId, controlExternalTokenId, dividendExternalTokenId };
};

export const releaseCompanySharesToCustody = async (
  env: RuntimeReplica,
  actors: CompanyScenarioActors,
  company: CompanyActor,
): Promise<CompanyShareTokens> => {
  await executeCompanyAction(env, company, [{
    type: 'entityProviderReleaseControlShares',
    data: {
      recipientAddress: actors.jadapter.addresses.depository,
      controlAmount: CONTROL_SUPPLY,
      dividendAmount: DIVIDEND_SUPPLY,
      purpose: 'company-ipo-treasury',
    },
  }]);
  await syncChain(env, 10);
  const tokens = await resolveCompanyShareTokens(actors, company);
  const [control, dividend] = await Promise.all([
    actors.jadapter.getReserves(company.id, tokens.controlTokenId),
    actors.jadapter.getReserves(company.id, tokens.dividendTokenId),
  ]);
  if (control !== CONTROL_SUPPLY || dividend !== DIVIDEND_SUPPLY) {
    throw new Error(`COMPANY_SHARE_CUSTODY_MISMATCH:${control}:${dividend}`);
  }
  return tokens;
};
