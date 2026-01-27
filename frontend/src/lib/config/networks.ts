/**
 * Popular EVM Networks Configuration
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
  // === Mainnets ===
  {
    chainId: 1,
    name: 'Ethereum',
    ticker: 'ETH',
    icon: 'Ξ',
    rpcs: [
      'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
      'https://ethereum.publicnode.com',
    ],
    explorer: 'https://etherscan.io',
  },
  {
    chainId: 8453,
    name: 'Base',
    ticker: 'ETH',
    icon: '🔵',
    rpcs: [
      'https://mainnet.base.org',
      'https://base.publicnode.com',
      'https://base.drpc.org',
    ],
    explorer: 'https://basescan.org',
  },
  {
    chainId: 10,
    name: 'Optimism',
    ticker: 'ETH',
    icon: '🔴',
    rpcs: [
      'https://mainnet.optimism.io',
      'https://optimism.publicnode.com',
    ],
    explorer: 'https://optimistic.etherscan.io',
  },
  {
    chainId: 42161,
    name: 'Arbitrum One',
    ticker: 'ETH',
    icon: '🔷',
    rpcs: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.publicnode.com',
    ],
    explorer: 'https://arbiscan.io',
  },
  {
    chainId: 137,
    name: 'Polygon',
    ticker: 'MATIC',
    icon: '🟣',
    rpcs: [
      'https://polygon-rpc.com',
      'https://polygon.publicnode.com',
    ],
    explorer: 'https://polygonscan.com',
  },
  {
    chainId: 56,
    name: 'BNB Chain',
    ticker: 'BNB',
    icon: '🟡',
    rpcs: [
      'https://bsc-dataseed.binance.org',
      'https://bsc.publicnode.com',
    ],
    explorer: 'https://bscscan.com',
  },
  {
    chainId: 43114,
    name: 'Avalanche',
    ticker: 'AVAX',
    icon: '🔺',
    rpcs: [
      'https://api.avax.network/ext/bc/C/rpc',
      'https://avalanche.publicnode.com',
    ],
    explorer: 'https://snowtrace.io',
  },
  {
    chainId: 324,
    name: 'zkSync Era',
    ticker: 'ETH',
    icon: '⚡',
    rpcs: [
      'https://mainnet.era.zksync.io',
    ],
    explorer: 'https://explorer.zksync.io',
  },
  {
    chainId: 59144,
    name: 'Linea',
    ticker: 'ETH',
    icon: '🌀',
    rpcs: [
      'https://rpc.linea.build',
    ],
    explorer: 'https://lineascan.build',
  },
  {
    chainId: 534352,
    name: 'Scroll',
    ticker: 'ETH',
    icon: '📜',
    rpcs: [
      'https://rpc.scroll.io',
    ],
    explorer: 'https://scrollscan.com',
  },

  // === Testnets ===
  {
    chainId: 11155111,
    name: 'Sepolia',
    ticker: 'ETH',
    icon: 'Ξ',
    rpcs: ['https://rpc.sepolia.org'],
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
  },
  {
    chainId: 84532,
    name: 'Base Sepolia',
    ticker: 'ETH',
    icon: '🔵',
    rpcs: ['https://sepolia.base.org'],
    explorer: 'https://sepolia.basescan.org',
    testnet: true,
  },
  {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    ticker: 'ETH',
    icon: '🔷',
    rpcs: ['https://sepolia-rollup.arbitrum.io/rpc'],
    explorer: 'https://sepolia.arbiscan.io',
    testnet: true,
  },
];

export function getNetworkByChainId(chainId: number): NetworkConfig | undefined {
  return POPULAR_NETWORKS.find(n => n.chainId === chainId);
}

export function isBrowserVM(rpcs: string[]): boolean {
  return rpcs.length === 0;
}

// BrowserVM chainIds reserved range
export const BROWSERVM_CHAIN_START = 1001;
export const BROWSERVM_CHAIN_MAX = 1999;

export function isBrowserVMChainId(chainId: number): boolean {
  return chainId >= BROWSERVM_CHAIN_START && chainId <= BROWSERVM_CHAIN_MAX;
}
