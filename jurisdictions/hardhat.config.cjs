require("@nomicfoundation/hardhat-toolbox");
require("@typechain/hardhat");

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
      chainId: 1337,
      allowUnlimitedContractSize: true,
      blockGasLimit: 300000000,
      mining: {
        auto: true,
        interval: 0
      }
    },
    ethereum: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      allowUnlimitedContractSize: true
    },
    polygon: {
      url: "http://0.0.0.0:8546",
      chainId: 1337,
      allowUnlimitedContractSize: true
    },
    arbitrum: {
      url: "http://0.0.0.0:8547",
      chainId: 1337,
      allowUnlimitedContractSize: true
    },
  }
};
