/**
 * Deploy full XLN contract stack
 * Usage: npx hardhat run scripts/deploy-stack.cjs --network localhost
 */
const hre = require("hardhat");

const disputeDelayBlocks = Number(process.env.XLN_DISPUTE_DELAY_BLOCKS);
if (!Number.isSafeInteger(disputeDelayBlocks) || disputeDelayBlocks <= 0 || disputeDelayBlocks > 65_535) {
  throw new Error(`XLN_DISPUTE_DELAY_BLOCKS_INVALID:${process.env.XLN_DISPUTE_DELAY_BLOCKS || 'missing'}`);
}
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

async function main() {
  console.log("🚀 Deploying XLN Contract Stack...\n");
  const network = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();
  const foundationRecipient = hre.ethers.getAddress(
    process.env.XLN_FOUNDATION_ADDRESS || deployer.address
  );

  // 1. Deploy Account library
  console.log("1️⃣ Deploying Account library...");
  const Account = await hre.ethers.getContractFactory("Account");
  const account = await Account.deploy();
  await account.waitForDeployment();
  const accountAddr = await account.getAddress();
  console.log(`   Account: ${accountAddr}`);

  // 2. Deploy bounded Hanko verifier and linked EntityProvider
  console.log("2️⃣ Deploying HankoVerifier + EntityProvider...");
  const HankoVerifier = await hre.ethers.getContractFactory("HankoVerifier");
  const hankoVerifier = await HankoVerifier.deploy();
  await hankoVerifier.waitForDeployment();
  const hankoVerifierAddr = await hankoVerifier.getAddress();
  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider", {
    libraries: { HankoVerifier: hankoVerifierAddr },
  });
  const entityProvider = await EntityProvider.deploy(foundationRecipient);
  await entityProvider.waitForDeployment();
  const entityProviderAddr = await entityProvider.getAddress();
  console.log(`   EntityProvider: ${entityProviderAddr}`);
  console.log(`   HankoVerifier: ${hankoVerifierAddr}`);
  console.log(`   Foundation recipient: ${foundationRecipient}`);

  // 3. Deploy Depository (needs Account library linked)
  console.log("3️⃣ Deploying Depository...");
  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: {
      Account: accountAddr,
    },
  });
  const depository = await Depository.deploy(entityProviderAddr, disputeDelayBlocks);
  await depository.waitForDeployment();
  const depositoryAddr = await depository.getAddress();
  console.log(`   Depository: ${depositoryAddr}`);

  // 4. Deploy DeltaTransformer
  console.log("4️⃣ Deploying DeltaTransformer...");
  const DeltaTransformer = await hre.ethers.getContractFactory("DeltaTransformer");
  const deltaTransformer = await DeltaTransformer.deploy();
  await deltaTransformer.waitForDeployment();
  const deltaTransformerAddr = await deltaTransformer.getAddress();
  console.log(`   DeltaTransformer: ${deltaTransformerAddr}`);

  const result = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    foundationRecipient,
    contracts: {
      account: accountAddr,
      entityProvider: entityProviderAddr,
      depository: depositoryAddr,
      deltaTransformer: deltaTransformerAddr,
    }
  };

  if (process.env.XLN_DEPLOY_OUTPUT) {
    mkdirSync(dirname(process.env.XLN_DEPLOY_OUTPUT), { recursive: true });
    writeFileSync(process.env.XLN_DEPLOY_OUTPUT, JSON.stringify(result, null, 2));
  }

  console.log("\n✅ Stack deployed successfully!\n");
  console.log("Update jurisdictions.json with:");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
