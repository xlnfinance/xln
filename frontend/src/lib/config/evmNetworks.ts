// EVM Network configuration (single-chain local mode)

export interface EVMNetwork {
  chainId: number;
  name: string;
  symbol: string;
  rpcUrl: string;
  explorerUrl: string;
  explorerName: string;
  isTestnet: boolean;
  tokens: TokenInfo[];
}

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoUrl?: string;
}

export const EVM_NETWORKS: EVMNetwork[] = [
  {
    chainId: 31337,
    name: 'Localhost',
    symbol: 'ETH',
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: '',
    explorerName: 'Local',
    isTestnet: true,
    tokens: [],
  },
];

// Helper to get network by chainId
export function getNetworkByChainId(chainId: number): EVMNetwork | undefined {
  return EVM_NETWORKS.find(n => n.chainId === chainId);
}

// Helper to get mainnet networks only
export function getMainnetNetworks(): EVMNetwork[] {
  return EVM_NETWORKS.filter(n => !n.isTestnet);
}

// Helper to get testnet networks only
export function getTestnetNetworks(): EVMNetwork[] {
  return EVM_NETWORKS.filter(n => n.isTestnet);
}

// Default network
export const DEFAULT_NETWORK = EVM_NETWORKS[0];

// ERC20 ABI for transfer function (minimal)
export const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const;
