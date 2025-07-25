require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
      viaIR: true, // Enable via-IR compilation for stack too deep issues
    },
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      allowUnlimitedContractSize: true
    },
    hardhat: {
      chainId: 1337,
    },
    ethereum: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      allowUnlimitedContractSize: true
    },
    polygon: {
      url: "http://127.0.0.1:8546",
      chainId: 1337,
      allowUnlimitedContractSize: true
    },
    arbitrum: {
      url: "http://127.0.0.1:8547",
      chainId: 1337,
      allowUnlimitedContractSize: true
    },
  }
};
