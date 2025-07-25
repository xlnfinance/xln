// Auto-generated contract configuration
// Generated on: Thu 24 Jul 2025 23:33:48 MSK
export const CONTRACT_CONFIG = {
  networks: {
    "8545": {
      name: "Ethereum",
      rpc: "http://localhost:8545",
      chainId: 1337,
      entityProvider: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    },
    "8546": {
      name: "Polygon", 
      rpc: "http://localhost:8546",
      chainId: 1337,
      entityProvider: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    },
    "8547": {
      name: "Arbitrum",
      rpc: "http://localhost:8547", 
      chainId: 1337,
      entityProvider: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    }
  },
  deployedAt: 1753389228,
  version: "f13edde"
};

// Helper function to get contract address by port
export const getContractAddress = (port) => {
  return CONTRACT_CONFIG.networks[port]?.entityProvider;
};

// Helper function to get network config by port
export const getNetworkConfig = (port) => {
  return CONTRACT_CONFIG.networks[port];
};
