import { JsonRpcProvider } from 'ethers';
import { networks } from '../identities';
import { preflightProvider } from '../provider';

export type ChainBinding = Readonly<{
  chainId: number;
  anchorNumber: number;
  anchorHash: string;
  depository: string;
  entityProvider: string;
  token: string;
  codeHashes: Readonly<Record<string, string>>;
}>;

export type NonceGrant = Readonly<{ address: string; firstNonce: number }>;

export type ExecutionProviders = Readonly<{
  current: JsonRpcProvider;
  historical: JsonRpcProvider;
}>;

export const historicalRpc = (apiBase: string, chainId: number): string => {
  const chain = networks.find(value => value.chainId === chainId);
  if (!chain) throw new Error('USDC_EXECUTION_CHAIN_UNSUPPORTED');
  return apiBase + '/history' + chain.path;
};

export const connectExecutionProviders = (apiBase: string, chainId: number): ExecutionProviders => ({
  current: new JsonRpcProvider(apiBase + (chainId === 11155111 ? '/rpc' : '/rpc2'), chainId, { cacheTimeout: -1 }),
  historical: preflightProvider(historicalRpc(apiBase, chainId), chainId),
});

/** An archive may trail the live RPC. Wait for a fixed observed fact, never a
 * moving live head, and never retry another endpoint after a read failure. */
export const waitForHistory = async (label: string, ready: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`USDC_EXECUTION_HISTORY_LAG:${label}`);
    await Bun.sleep(250);
  }
};
