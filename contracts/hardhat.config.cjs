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
      allowUnlimitedContractSize: true,
      // Increase gas limit 10x for large grid deployments (grid 6 = 216 entities)
      blockGasLimit: 300000000, // 300M gas (default is 30M)
      // Bind to 0.0.0.0 to allow network access (Oculus, mobile devices)
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
