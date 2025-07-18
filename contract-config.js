// Auto-generated contract configuration
// Generated on: Fri Jul 18 17:04:18 MSK 2025
export const CONTRACT_CONFIG = {
  networks: {
    "8545": {
      name: "Ethereum",
      rpc: "http://localhost:8545",
      chainId: 1337,
      entityProvider: "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1"
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
  deployedAt: 1752847458,
  version: "eb99799"
};

// Helper function to get contract address by port
export const getContractAddress = (port) => {
  return CONTRACT_CONFIG.networks[port]?.entityProvider;
};

// Helper function to get network config by port
export const getNetworkConfig = (port) => {
  return CONTRACT_CONFIG.networks[port];
};
