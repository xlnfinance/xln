import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

const deployerAccounts = () => {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) return [];
  return [key.startsWith("0x") ? key : `0x${key}`];
};
const requiredRpcPlaceholder = (envName: string) => process.env[envName] || "http://127.0.0.1:0";
const typechainOutDir = process.env.XLN_TYPECHAIN_OUT_DIR || "typechain-types";
const etherscanApiKey = process.env.ETHERSCAN_API_KEY || "";
const stackManagerChainId = Number(process.env.XLN_STACK_MANAGER_CHAIN_ID || 0);

const config = defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  // test/foundry/**/*.sol is a Foundry-native suite (run via `forge test`), not
  // Hardhat's own Solidity-test feature. Hardhat 3 defaults `tests.solidity` to
  // the whole `test/` tree and auto-detects the sibling foundry.toml, which makes
  // `hardhat compile`/`hardhat test` try to resolve forge-std through Hardhat's
  // own (non-Foundry-aware) import resolution and fail. Point it at an unused
  // directory so Hardhat's solc test-scanning leaves the Foundry suite alone.
  paths: {
    tests: {
      mocha: "test",
      solidity: "test-solidity-unused",
    },
  },
  solidity: {
    version: "0.8.36",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      viaIR: true,
      // No CBOR metadata trailer: the committed artifacts must be byte-identical
      // on every platform (CI Linux vs local macOS produced different ipfs
      // metadata hashes for identical sources).
      metadata: {
        bytecodeHash: "none",
        appendCBOR: false,
      },
    },
  },
  typechain: {
    outDir: typechainOutDir,
  },
  ...(etherscanApiKey
    ? {
        verify: {
          etherscan: {
            apiKey: etherscanApiKey,
          },
        },
      }
    : {}),
  networks: {
    "stack-manager": {
      type: "http",
      url: requiredRpcPlaceholder("XLN_STACK_MANAGER_RPC_URL"),
      ...(Number.isSafeInteger(stackManagerChainId) && stackManagerChainId > 0
        ? { chainId: stackManagerChainId }
        : {}),
      accounts: deployerAccounts(),
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
      allowUnlimitedContractSize: true,
    },
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      allowUnlimitedContractSize: true,
      blockGasLimit: 300_000_000,
    },
    // Base Networks (Coinbase L2)
    "base-sepolia": {
      type: "http",
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    "base-mainnet": {
      type: "http",
      url: process.env.BASE_MAINNET_RPC || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // Ethereum Networks
    "ethereum-sepolia": {
      type: "http",
      url: requiredRpcPlaceholder("ETH_SEPOLIA_RPC"),
      chainId: 11155111,
      accounts: deployerAccounts(),
    },
    "ethereum-mainnet": {
      type: "http",
      url: requiredRpcPlaceholder("ETH_MAINNET_RPC"),
      chainId: 1,
      accounts: deployerAccounts(),
    },
    // Local test networks
    ethereum: {
      type: "http",
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
    polygon: {
      type: "http",
      url: "http://0.0.0.0:8546",
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
    arbitrum: {
      type: "http",
      url: "http://0.0.0.0:8547",
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
  },
});

export default config;
