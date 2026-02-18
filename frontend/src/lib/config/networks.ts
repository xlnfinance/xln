/**
 * Local network configuration (single-chain mode)
 * Used for J-Machine selection in Settings
 */

export interface NetworkConfig {
  chainId: number;
  name: string;
  ticker: string;
  icon: string;
  rpcs: string[];
  explorer?: string;
  contracts?: {
    depository?: string;
    entityProvider?: string;
  };
  testnet?: boolean;
}

export const POPULAR_NETWORKS: NetworkConfig[] = [
  {
    chainId: 31337,
    name: 'Localhost',
    ticker: 'ETH',
    icon: '🏠',
    rpcs: ['http://127.0.0.1:8545'],
    explorer: '',
    testnet: true,
  },
];

export function getNetworkByChainId(chainId: number): NetworkConfig | undefined {
  return POPULAR_NETWORKS.find(n => n.chainId === chainId);
}

export function isBrowserVM(rpcs: string[]): boolean {
  return rpcs.length === 0;
}

// Single-chain local mode
export const BROWSERVM_CHAIN_START = 31337;
export const BROWSERVM_CHAIN_MAX = 31337;

export function isBrowserVMChainId(chainId: number): boolean {
  return chainId >= BROWSERVM_CHAIN_START && chainId <= BROWSERVM_CHAIN_MAX;
}
