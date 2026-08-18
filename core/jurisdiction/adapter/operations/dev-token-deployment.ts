import { ethers } from 'ethers';

import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types/index.ts';
import { createStructuredLogger, shortId } from '../../../support/logger';
import { DEV_CHAIN_IDS } from '../index';
import type { JAdapter } from '../types';
import {
  TOKEN_REGISTRATION_AMOUNT,
  defaultTokensForJurisdiction,
  getDefaultTokenSupply,
} from '../../machine/config/default-tokens';

const log = createStructuredLogger('jurisdiction.dev-tokens');

/**
 * Deploy every missing canonical token on a development settlement chain.
 *
 * Provisioning must distinguish an empty registry from an unavailable RPC.
 * Callers therefore receive every read/deploy error; turning either into an
 * empty list could redeploy conflicting token identities after a restart.
 */
export const deployMissingDefaultTokens = async (
  adapter: JAdapter,
  jurisdictionName = '',
): Promise<void> => {
  if (adapter.mode === 'browservm') return;
  if (!DEV_CHAIN_IDS.has(adapter.chainId)) {
    throw new Error(`TOKEN_DEFAULT_DEPLOY_FORBIDDEN:${adapter.chainId}`);
  }
  const depositoryAddress = adapter.addresses?.depository;
  if (!depositoryAddress) throw new Error('TOKEN_DEPLOY_DEPOSITORY_MISSING');

  const existingSymbols = new Set(
    (await adapter.getTokenRegistry())
      .map(token => token.symbol.trim().toUpperCase())
      .filter(Boolean),
  );
  const tokens = defaultTokensForJurisdiction({
    name: jurisdictionName,
    chainId: adapter.chainId,
  });
  const factory = new ERC20Mock__factory(adapter.signer);
  log.info('deploy.start', { symbols: tokens.map(token => token.symbol) });

  for (const token of tokens) {
    if (existingSymbols.has(token.symbol.trim().toUpperCase())) continue;
    const contract = await factory.deploy(
      token.name,
      token.symbol,
      token.decimals,
      getDefaultTokenSupply(token.decimals),
    );
    await contract.waitForDeployment();
    const tokenAddress = await contract.getAddress();
    await (await contract.approve(
      depositoryAddress,
      TOKEN_REGISTRATION_AMOUNT,
    )).wait();
    await (await adapter.depository.connect(adapter.signer)
      .adminRegisterExternalToken({
        entity: ethers.ZeroHash,
        contractAddress: tokenAddress,
        externalTokenId: 0,
        tokenType: 0,
        internalTokenId: 0,
        amount: TOKEN_REGISTRATION_AMOUNT,
      })).wait();
    log.info('deploy.registered', {
      symbol: token.symbol,
      address: shortId(tokenAddress, 10),
    });
  }
};
