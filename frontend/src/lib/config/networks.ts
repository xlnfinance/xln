/**
 * Local network configuration
 * Used for J-Machine selection in Settings
 */

export interface NetworkConfig {
  chainId: number;
  name: string;
  ticker: string;
  icon: string;
  rpcs: string[];
  blockTimeMs: number;
  explorer?: string;
  contracts?: {
    depository?: string;
    entityProvider?: string;
  };
  testnet?: boolean;
  disabledReason?: string;
}

const DEFAULT_LOCAL_RPC_URL = 'http://localhost:8545';
const DEFAULT_LOCAL_RPC2_URL = 'http://localhost:8546';

function resolveLocalRpcUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_LOCAL_RPC_URL;
  const { hostname } = window.location;
  if (hostname !== 'localhost') return DEFAULT_LOCAL_RPC_URL;
  return new URL('/rpc', window.location.origin).toString();
}

function resolveLocalRpc2Url(): string {
  if (typeof window === 'undefined') return DEFAULT_LOCAL_RPC2_URL;
  const { hostname } = window.location;
  if (hostname !== 'localhost') return DEFAULT_LOCAL_RPC2_URL;
  return new URL('/rpc2', window.location.origin).toString();
}

export const POPULAR_NETWORKS: NetworkConfig[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    ticker: 'ETH',
    icon: '⟠',
    rpcs: ['https://ethereum-rpc.publicnode.com'],
    blockTimeMs: 12_000,
    explorer: 'https://etherscan.io',
    disabledReason: 'XLN contracts are not configured on Ethereum yet',
  },
  {
    chainId: 8453,
    name: 'Base',
    ticker: 'ETH',
    icon: '🔵',
    rpcs: ['https://mainnet.base.org'],
    blockTimeMs: 2_000,
    explorer: 'https://basescan.org',
    disabledReason: 'XLN contracts are not configured on Base yet',
  },
  {
    chainId: 11155111,
    name: 'Sepolia',
    ticker: 'ETH',
    icon: '🧪',
    rpcs: ['https://ethereum-sepolia-rpc.publicnode.com'],
    blockTimeMs: 12_000,
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
    disabledReason: 'XLN contracts are not configured on Sepolia yet',
  },
  {
    chainId: 84532,
    name: 'Base Sepolia',
    ticker: 'ETH',
    icon: '🟦',
    rpcs: ['https://sepolia.base.org'],
    blockTimeMs: 2_000,
    explorer: 'https://sepolia.basescan.org',
    testnet: true,
    disabledReason: 'XLN contracts are not configured on Base Sepolia yet',
  },
  {
    chainId: 31337,
    name: 'Localhost',
    ticker: 'ETH',
    icon: '🏠',
    rpcs: [resolveLocalRpcUrl()],
    blockTimeMs: 1_000,
    explorer: '',
    testnet: true,
  },
  {
    chainId: 31338,
    name: 'Tron',
    ticker: 'TRX',
    icon: 'T',
    rpcs: [resolveLocalRpc2Url()],
    blockTimeMs: 1_000,
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

export const BROWSERVM_CHAIN_START = 31337;
export const BROWSERVM_CHAIN_MAX = 31338;

export function isBrowserVMChainId(chainId: number): boolean {
  return chainId >= BROWSERVM_CHAIN_START && chainId <= BROWSERVM_CHAIN_MAX;
}
