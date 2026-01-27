/**
 * Test Base Sepolia connection
 * Run: cd jurisdictions && npx hardhat run scripts/test-base-connection.cjs --network base-sepolia
 */

const hre = require("hardhat");

async function main() {
  console.log("Testing Base Sepolia connection...\n");

  const network = hre.network.name;
  const chainId = hre.network.config.chainId;

  console.log(`Network: ${network}`);
  console.log(`Chain ID: ${chainId}`);

  // Test provider connectivity
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  console.log(`Current block: ${blockNumber}`);

  // Check if we have a signer
  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    console.log("\n⚠️  No signer configured. Set DEPLOYER_PRIVATE_KEY environment variable.");
    console.log("\nTo deploy:");
    console.log("  1. Generate a wallet: node -e \"console.log(require('ethers').Wallet.createRandom().privateKey)\"");
    console.log("  2. Export: export DEPLOYER_PRIVATE_KEY=0x...");
    console.log("  3. Get testnet ETH: https://www.alchemy.com/faucets/base-sepolia");
    console.log("  4. Deploy: npx hardhat run scripts/deploy-base.cjs --network base-sepolia");
    return;
  }

  const deployer = signers[0];
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`Balance: ${hre.ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.log("\n⚠️  Deployer has 0 ETH. Get testnet ETH from:");
    console.log("   https://www.alchemy.com/faucets/base-sepolia");
    console.log("   https://faucets.chain.link/base-sepolia");
  } else {
    console.log("\n✅ Ready to deploy! Run:");
    console.log("   npx hardhat run scripts/deploy-base.cjs --network base-sepolia");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
