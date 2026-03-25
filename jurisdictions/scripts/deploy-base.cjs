/**
 * Deploy XLN contracts to Base (Sepolia or Mainnet)
 *
 * Usage:
 *   # Set deployer private key
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *
 *   # Deploy to Base Sepolia (testnet)
 *   cd jurisdictions && npx hardhat run scripts/deploy-base.cjs --network base-sepolia
 *
 *   # Deploy to Base Mainnet (production)
 *   cd jurisdictions && npx hardhat run scripts/deploy-base.cjs --network base-mainnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const network = hre.network.name;
  const chainId = hre.network.config.chainId;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🚀 XLN Contract Deployment`);
  console.log(`   Network: ${network}`);
  console.log(`   Chain ID: ${chainId}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Get deployer
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log(`\n📍 Deployer: ${deployer.address}`);
  console.log(`   Balance: ${hre.ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("\n❌ ERROR: Deployer has 0 ETH. Get testnet ETH from a faucet:");
    console.error("   https://www.alchemy.com/faucets/base-sepolia");
    console.error("   https://faucets.chain.link/base-sepolia");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Step 1: Deploy Token (mock USDC for testing)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 1: Deploying Token (mock USDC) ───");

  const Token = await hre.ethers.getContractFactory("Token");
  const token = await Token.deploy("USD Coin", "USDC", 18);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`   ✅ Token deployed: ${tokenAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 2: Deploy EntityProvider
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 2: Deploying EntityProvider ───");

  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy();
  await entityProvider.waitForDeployment();
  const entityProviderAddress = await entityProvider.getAddress();
  console.log(`   ✅ EntityProvider deployed: ${entityProviderAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 3: Deploy Depository
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 3: Deploying Depository ───");

  const Depository = await hre.ethers.getContractFactory("Depository");
  const depository = await Depository.deploy(entityProviderAddress);
  await depository.waitForDeployment();
  const depositoryAddress = await depository.getAddress();
  console.log(`   ✅ Depository deployed: ${depositoryAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 4: Configure Depository
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 4: Configuring Depository ───");

  console.log(`   ✅ Depository bound to immutable EntityProvider at deploy time`);

  // Register USDC token
  // Token ID 0 is reserved for ETH, so USDC gets ID 1
  // Note: For real USDC, use the official Base USDC address
  console.log(`   ✅ Token ready for registration (ID will be assigned on first use)`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 5: Deploy DeltaTransformer (optional, for advanced features)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 5: Deploying DeltaTransformer ───");

  const DeltaTransformer = await hre.ethers.getContractFactory("DeltaTransformer");
  const deltaTransformer = await DeltaTransformer.deploy(depositoryAddress);
  await deltaTransformer.waitForDeployment();
  const deltaTransformerAddress = await deltaTransformer.getAddress();
  console.log(`   ✅ DeltaTransformer deployed: ${deltaTransformerAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`
Network: ${network} (chainId: ${chainId})

Contract Addresses:
  Token (USDC):      ${tokenAddress}
  EntityProvider:    ${entityProviderAddress}
  Depository:        ${depositoryAddress}
  DeltaTransformer:  ${deltaTransformerAddress}

Explorer Links:`);

  const explorerBase = chainId === 84532
    ? "https://sepolia.basescan.org"
    : "https://basescan.org";

  console.log(`  ${explorerBase}/address/${tokenAddress}`);
  console.log(`  ${explorerBase}/address/${entityProviderAddress}`);
  console.log(`  ${explorerBase}/address/${depositoryAddress}`);
  console.log(`  ${explorerBase}/address/${deltaTransformerAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Save deployment info
  // ═══════════════════════════════════════════════════════════════════
  const deploymentInfo = {
    network,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      token: tokenAddress,
      entityProvider: entityProviderAddress,
      depository: depositoryAddress,
      deltaTransformer: deltaTransformerAddress,
    },
    explorer: explorerBase,
  };

  const deploymentPath = path.join(__dirname, `../deployments/${network}.json`);
  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\n📁 Deployment saved to: ${deploymentPath}`);

  // Print usage instructions
  console.log(`
═══════════════════════════════════════════════════════════════
📖 NEXT STEPS
═══════════════════════════════════════════════════════════════

1. Add to your .env or runtime config:

   BASE_SEPOLIA_DEPOSITORY=${depositoryAddress}
   BASE_SEPOLIA_ENTITY_PROVIDER=${entityProviderAddress}

2. Use in code:

   import { createEVM } from './evm-interface';

   const evm = await createEVM({
     type: 'rpc',
     name: 'base-sepolia',
     rpcUrl: 'https://sepolia.base.org',
     chainId: 84532,
     depositoryAddress: '${depositoryAddress}',
     entityProviderAddress: '${entityProviderAddress}',
     signer: yourWalletSigner,
   });

3. Verify contracts on explorer (optional):

   npx hardhat verify --network ${network} ${depositoryAddress}
   npx hardhat verify --network ${network} ${entityProviderAddress}
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
