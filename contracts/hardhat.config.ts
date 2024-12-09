import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
  networks: {
    localhost: {
      allowUnlimitedContractSize: true
    },
    hardhat: {
      chainId: 1337,
    },
    testnode1: {
      url: "http://127.0.0.1:8545",
      chainId: 1338,
    },
    testnode2: {
      url: "http://127.0.0.1:8546",
      chainId: 1339,
    },
    testnode3: {
      url: "http://127.0.0.1:8547",
      chainId: 1340,
    },

  }
};

export default config;
