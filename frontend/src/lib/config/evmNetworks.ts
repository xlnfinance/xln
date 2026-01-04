// EVM Network configurations - Top 10 chains by usage
// Each network has RPC, block explorer, and common tokens

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
  // Mainnets - Base is default
  {
    chainId: 8453,
    name: 'Base',
    symbol: 'ETH',
    rpcUrl: 'https://mainnet.base.org',  // Official Base RPC (CORS-enabled)
    explorerUrl: 'https://basescan.org',
    explorerName: 'Basescan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    ]
  },
  {
    chainId: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    rpcUrl: 'https://ethereum.publicnode.com',  // Public node with CORS
    explorerUrl: 'https://etherscan.io',
    explorerName: 'Etherscan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x6B175474E89094C44Da98b954EescdeCB5bC4F9d', decimals: 18 },
      { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      { symbol: 'WBTC', name: 'Wrapped BTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    ]
  },
  {
    chainId: 137,
    name: 'Polygon',
    symbol: 'MATIC',
    rpcUrl: 'https://polygon-rpc.com',  // Official Polygon RPC
    explorerUrl: 'https://polygonscan.com',
    explorerName: 'Polygonscan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      { symbol: 'USDT', name: 'Tether USD', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
      { symbol: 'WMATIC', name: 'Wrapped MATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
    ]
  },
  {
    chainId: 42161,
    name: 'Arbitrum One',
    symbol: 'ETH',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',  // Official Arbitrum RPC
    explorerUrl: 'https://arbiscan.io',
    explorerName: 'Arbiscan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      { symbol: 'USDT', name: 'Tether USD', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
      { symbol: 'ARB', name: 'Arbitrum', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    ]
  },
  {
    chainId: 10,
    name: 'Optimism',
    symbol: 'ETH',
    rpcUrl: 'https://mainnet.optimism.io',  // Official Optimism RPC
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerName: 'Optimistic Etherscan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      { symbol: 'USDT', name: 'Tether USD', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
      { symbol: 'OP', name: 'Optimism', address: '0x4200000000000000000000000000000000000042', decimals: 18 },
    ]
  },
  {
    chainId: 56,
    name: 'BNB Chain',
    symbol: 'BNB',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    explorerName: 'BscScan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      { symbol: 'USDT', name: 'Tether USD', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'BUSD', name: 'Binance USD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
      { symbol: 'WBNB', name: 'Wrapped BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    ]
  },
  {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    symbol: 'AVAX',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorerUrl: 'https://snowtrace.io',
    explorerName: 'Snowtrace',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
      { symbol: 'USDT', name: 'Tether USD', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
      { symbol: 'WAVAX', name: 'Wrapped AVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18 },
    ]
  },
  {
    chainId: 250,
    name: 'Fantom',
    symbol: 'FTM',
    rpcUrl: 'https://rpc.ftm.tools',
    explorerUrl: 'https://ftmscan.com',
    explorerName: 'FTMScan',
    isTestnet: false,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', decimals: 6 },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E', decimals: 18 },
      { symbol: 'WFTM', name: 'Wrapped FTM', address: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', decimals: 18 },
    ]
  },
  // Testnets
  {
    chainId: 11155111,
    name: 'Sepolia',
    symbol: 'ETH',
    rpcUrl: 'https://rpc.sepolia.org',
    explorerUrl: 'https://sepolia.etherscan.io',
    explorerName: 'Sepolia Etherscan',
    isTestnet: true,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin (Test)', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 },
    ]
  },
  {
    chainId: 31337,
    name: 'Localhost (Hardhat)',
    symbol: 'ETH',
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: '',
    explorerName: 'Local',
    isTestnet: true,
    tokens: []
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

// Default network (Base)
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
