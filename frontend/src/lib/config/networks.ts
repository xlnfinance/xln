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

const DEFAULT_LOCAL_RPC_URL = 'http://127.0.0.1:8545';

function resolveLocalRpcUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_LOCAL_RPC_URL;
  const { hostname, protocol, port } = window.location;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return DEFAULT_LOCAL_RPC_URL;
  const currentPort = Number(port || 0);
  if (!Number.isFinite(currentPort) || currentPort < 1) return DEFAULT_LOCAL_RPC_URL;
  if (currentPort === 8080) return DEFAULT_LOCAL_RPC_URL;
  const shiftedRpcPort = currentPort - 4;
  if (shiftedRpcPort < 1) return DEFAULT_LOCAL_RPC_URL;
  const rpcProtocol = protocol === 'https:' ? 'https:' : 'http:';
  return `${rpcProtocol}//${hostname}:${shiftedRpcPort}`;
}

export const POPULAR_NETWORKS: NetworkConfig[] = [
  {
    chainId: 31337,
    name: 'Localhost',
    ticker: 'ETH',
    icon: '🏠',
    rpcs: [resolveLocalRpcUrl()],
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
