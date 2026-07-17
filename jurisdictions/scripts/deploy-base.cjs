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
  const foundationRecipient = hre.ethers.getAddress(
    process.env.XLN_FOUNDATION_ADDRESS || deployer.address
  );

  console.log(`\n📍 Deployer: ${deployer.address}`);
  console.log(`   Foundation recipient: ${foundationRecipient}`);
  console.log(`   Balance: ${hre.ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("\n❌ ERROR: Deployer has 0 ETH. Get testnet ETH from a faucet:");
    console.error("   https://www.alchemy.com/faucets/base-sepolia");
    console.error("   https://faucets.chain.link/base-sepolia");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Step 1: Resolve USDC token
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 1: Resolving USDC token ───");

  const configuredUsdc = String(process.env.XLN_USDC_ADDRESS || '').trim();
  const isBaseMainnet = network === 'base-mainnet' || Number(chainId) === 8453;
  let tokenAddress;
  let tokenSource;
  if (configuredUsdc) {
    tokenAddress = hre.ethers.getAddress(configuredUsdc);
    tokenSource = "configured";
    console.log(`   ✅ Using configured USDC: ${tokenAddress}`);
  } else {
    if (isBaseMainnet) {
      throw new Error("XLN_USDC_ADDRESS is required for Base mainnet deploy");
    }
    const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    const token = await ERC20Mock.deploy("USD Coin", "USDC", 6, hre.ethers.parseUnits("1000000", 6));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    tokenSource = "mock";
    console.log(`   ✅ Mock USDC deployed: ${tokenAddress}`);
  }

  const usdc = new hre.ethers.Contract(
    tokenAddress,
    ["function decimals() external view returns (uint8)"],
    deployer,
  );
  const tokenDecimals = Number(await usdc.decimals());
  const expectedDecimals = 6;
  if (!Number.isSafeInteger(tokenDecimals) || tokenDecimals !== expectedDecimals) {
    throw new Error(`USDC_DECIMALS_MISMATCH expected=${expectedDecimals} actual=${tokenDecimals}`);
  }
  console.log(`   ✅ Live USDC decimals verified: ${tokenDecimals}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 2: Deploy EntityProvider
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 2: Deploying EntityProvider ───");

  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy(foundationRecipient);
  await entityProvider.waitForDeployment();
  const entityProviderAddress = await entityProvider.getAddress();
  console.log(`   ✅ EntityProvider deployed: ${entityProviderAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 3: Deploy Account library and Depository
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 3: Deploying Account library and Depository ───");

  const Account = await hre.ethers.getContractFactory("Account");
  const account = await Account.deploy();
  await account.waitForDeployment();
  const accountAddress = await account.getAddress();
  console.log(`   ✅ Account library deployed: ${accountAddress}`);

  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: {
      Account: accountAddress,
    },
  });
  const depository = await Depository.deploy(entityProviderAddress);
  await depository.waitForDeployment();
  const depositoryAddress = await depository.getAddress();
  console.log(`   ✅ Depository deployed: ${depositoryAddress}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 4: Configure Depository
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 4: Configuring Depository ───");

  console.log(`   ✅ Depository bound to immutable EntityProvider at deploy time`);

  const registration = await depository.registerExternalToken(0, tokenAddress, 0);
  await registration.wait();
  const usdcReference = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "address", "uint96"],
      [0, tokenAddress, 0],
    ),
  );
  const usdcTokenId = await depository.tokenToId(usdcReference);
  if (usdcTokenId !== 1n) {
    throw new Error(`USDC_TOKEN_ID_MISMATCH expected=1 actual=${usdcTokenId}`);
  }
  console.log(`   ✅ USDC registered as tokenId ${usdcTokenId}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 5: Deploy DeltaTransformer (optional, for advanced features)
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n─── Step 5: Deploying DeltaTransformer ───");

  const DeltaTransformer = await hre.ethers.getContractFactory("DeltaTransformer");
  const deltaTransformer = await DeltaTransformer.deploy();
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
  Account Library:   ${accountAddress}
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
    foundationRecipient,
    tokenSource,
    tokens: {
      USDC: {
        address: tokenAddress,
        tokenId: Number(usdcTokenId),
        decimals: tokenDecimals,
      },
    },
    deployedAt: new Date().toISOString(),
    contracts: {
      token: tokenAddress,
      account: accountAddress,
      entityProvider: entityProviderAddress,
      depository: depositoryAddress,
      deltaTransformer: deltaTransformerAddress,
    },
    explorer: explorerBase,
  };

  const deploymentPath = process.env.XLN_DEPLOY_OUTPUT
    ? path.resolve(process.env.XLN_DEPLOY_OUTPUT)
    : path.join(__dirname, `../deployments/${network}.json`);
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
   BASE_SEPOLIA_ACCOUNT_LIBRARY=${accountAddress}

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
   npx hardhat verify --network ${network} ${deltaTransformerAddress}
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
