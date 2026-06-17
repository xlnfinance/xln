require("@nomicfoundation/hardhat-toolbox");
require("@typechain/hardhat");

const deployerAccounts = () => {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) return [];
  return [key.startsWith("0x") ? key : `0x${key}`];
};
const requiredRpcPlaceholder = (envName) => process.env[envName] || "http://127.0.0.1:0";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      viaIR: true,
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      allowUnlimitedContractSize: true
    },
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
      blockGasLimit: 300000000,
      mining: {
        auto: true,
        interval: 0
      }
    },
    // ═══════════════════════════════════════════════════════════════════
    // Base Networks (Coinbase L2)
    // ═══════════════════════════════════════════════════════════════════
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    "base-mainnet": {
      url: process.env.BASE_MAINNET_RPC || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // ═══════════════════════════════════════════════════════════════════
    // Ethereum Networks
    // ═══════════════════════════════════════════════════════════════════
    "ethereum-sepolia": {
      url: requiredRpcPlaceholder("ETH_SEPOLIA_RPC"),
      chainId: 11155111,
      accounts: deployerAccounts(),
    },
    "ethereum-mainnet": {
      url: requiredRpcPlaceholder("ETH_MAINNET_RPC"),
      chainId: 1,
      accounts: deployerAccounts(),
    },
    // ═══════════════════════════════════════════════════════════════════
    // Legacy local networks
    // ═══════════════════════════════════════════════════════════════════
    ethereum: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      allowUnlimitedContractSize: true
    },
    polygon: {
      url: "http://0.0.0.0:8546",
      chainId: 31337,
      allowUnlimitedContractSize: true
    },
    arbitrum: {
      url: "http://0.0.0.0:8547",
      chainId: 31337,
      allowUnlimitedContractSize: true
    },
  }
};
