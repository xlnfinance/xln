import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { persistVerifiedJurisdictionStack } from '../../../core/jurisdiction/adapter/stack-manager/persistence';
import { networks } from './identities';
import type { inspectChain } from './chain';

export const prepareCatalog = async (directory: string, chains: Awaited<ReturnType<typeof inspectChain>>[]) => {
  const path = join(directory, 'jurisdictions.json');
  process.env['XLN_JURISDICTIONS_PATH'] = path;
  const existing = existsSync(path);
  for (const chain of chains) {
    const config = networks.find(value => value.chainId === chain.chainId);
    if (!config) throw new Error('USDC_PREFLIGHT_NETWORK_NOT_SELECTED');
    await persistVerifiedJurisdictionStack(
      {
        name: chain.name,
        key: config.path === '/rpc' ? 'ethereum-sepolia' : 'rpc2',
        expectedChainId: chain.chainId,
        rpcUrl: `http://localhost:8080${config.path}`,
        blockTimeMs: config.blockTimeMs,
        explorer: '',
        currency: 'ETH',
        signerId: chain.deployment.deployer,
        foundationRecipient: chain.deployment.foundationRecipient,
        stablecoin: { kind: 'existing', address: config.token },
        publication: 'local',
        confirmations: chain.verified.confirmations,
      },
      chain.deployment,
      undefined,
      undefined,
      existing,
    );
  }
  return path;
};
