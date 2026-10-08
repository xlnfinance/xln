import type { JurisdictionsData } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { isActiveJurisdictionStatus } from '../../jurisdiction/adapter/kernel/config';
import type { JAdapterConfig } from '../../jurisdiction/adapter/types';

/** Server startup selects configured transport explicitly; native TVM must never use an EVM signer. */
export function configuredNativeServerJurisdiction(data: JurisdictionsData, key: string) {
  const active = Object.entries(data.jurisdictions).filter(([, config]) => isActiveJurisdictionStatus(config.status));
  const candidates = key ? active.filter(([name]) => name === key)
    : active.some(([, config]) => config.primary) ? active.filter(([, config]) => config.primary) : active;
  if (candidates.length !== 1) throw new Error('SERVER_JURISDICTION_SELECTION_REQUIRED');
  const selected = candidates[0];
  if (!selected) throw new Error('SERVER_JURISDICTION_SELECTION_REQUIRED');
  const [name, config] = selected;
  if (config.mode !== 'tron') throw new Error('JADAPTER_MODE_REQUIRED:set_USE_ANVIL_or_XLN_LOCAL_SIMULATION');
  if (!config.entityProviderDeploymentBlock) throw new Error('SERVER_JURISDICTION_DEPLOYMENT_BLOCK_REQUIRED');
  const adapterConfig: JAdapterConfig = {
    mode: 'tron', chainId: config.chainId, rpcUrl: config.rpc,
    tronFullHost: config.tronFullHost,
    ...(config.tronSolidityHost ? { tronSolidityHost: config.tronSolidityHost } : {}),
    watchOnly: true,
    fromReplica: { contracts: config.contracts, entityProviderDeploymentBlock: config.entityProviderDeploymentBlock },
  };
  return { name: config.name, key: name, rpcUrl: config.rpc, blockTimeMs: config.blockTimeMs, adapterConfig };
}
