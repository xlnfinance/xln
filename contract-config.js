// Auto-generated contract configuration
// Generated on: Fri 18 Jul 2025 17:37:42 MSK
export const CONTRACT_CONFIG = {
  networks: {
    "8545": {
      name: "Ethereum",
      rpc: "http://localhost:8545",
      chainId: 1337,
      entityProvider: "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c"
    },
    "8546": {
      name: "Polygon", 
      rpc: "http://localhost:8546",
      chainId: 1337,
      entityProvider: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
    },
    "8547": {
      name: "Arbitrum",
      rpc: "http://localhost:8547", 
      chainId: 1337,
      entityProvider: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
    }
  },
  deployedAt: 1752849462,
  version: "9655da3"
};

// Helper function to get contract address by port
export const getContractAddress = (port) => {
  return CONTRACT_CONFIG.networks[port]?.entityProvider;
};

// Helper function to get network config by port
export const getNetworkConfig = (port) => {
  return CONTRACT_CONFIG.networks[port];
};
