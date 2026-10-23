import type { JAdapterConfig } from './types';

/** Local EVM chains where development-only contract methods are allowed. */
export const DEV_CHAIN_IDS = new Set<number>([31337, 31338]);

const LOOPBACK_RPC_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The development key is public, so it can pay only a node no one else can
 * reach. A watch-only Runtime on a shared endpoint (a hosted wallet) submits
 * with its own Entity signer, as on any other chain.
 */
export const sponsorsWithPublicDevKey = (config: JAdapterConfig): boolean => {
  if (!DEV_CHAIN_IDS.has(config.chainId)) return false;
  if (!config.watchOnly || config.mode === 'browservm') return true;
  try {
    return LOOPBACK_RPC_HOSTS.has(new URL(config.rpcUrl ?? '').hostname);
  } catch {
    return false;
  }
};

/** TRON networks exposed through the shared JAdapter interface. */
export const TRON_CHAIN_IDS = new Set<number>([728126428, 3448148188]);

export const isTronChainId = (chainId: number): boolean => TRON_CHAIN_IDS.has(chainId);
