import { FetchRequest, JsonRpcProvider } from 'ethers';
import { networks } from '../identities';
import { preflightProvider, runtimeRpc } from '../provider';
import type { ExecutionProviders } from '../execution/providers';

/** Separate current/write and archive/read capabilities; no endpoint failover. */
export const fundingProviders = (chainId: number, access: 'read' | 'write'): ExecutionProviders => {
  const chain = networks.find(value => value.chainId === chainId);
  if (!chain) throw new Error('USDC_FUNDING_CHAIN_UNSUPPORTED');
  const historical = process.env[chain.env];
  if (!historical) throw new Error(`USDC_FUNDING_HISTORY_RPC_REQUIRED:${chain.env}`);
  const current = runtimeRpc(chain);
  const request = new FetchRequest(current);
  request.timeout = 10_000;
  request.retryFunc = async () => false;
  return {
    current:
      access === 'read'
        ? preflightProvider(current, chainId)
        : new JsonRpcProvider(request, chainId, { cacheTimeout: -1 }),
    historical: preflightProvider(historical, chainId),
  };
};
