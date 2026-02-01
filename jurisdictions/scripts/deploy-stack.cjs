/**
 * Deploy full XLN contract stack
 * Usage: npx hardhat run scripts/deploy-stack.cjs --network localhost
 */
const hre = require("hardhat");

async function main() {
  console.log("🚀 Deploying XLN Contract Stack...\n");

  // 1. Deploy Account library
  console.log("1️⃣ Deploying Account library...");
  const Account = await hre.ethers.getContractFactory("Account");
  const account = await Account.deploy();
  await account.waitForDeployment();
  const accountAddr = await account.getAddress();
  console.log(`   Account: ${accountAddr}`);

  // 2. Deploy EntityProvider
  console.log("2️⃣ Deploying EntityProvider...");
  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy();
  await entityProvider.waitForDeployment();
  const entityProviderAddr = await entityProvider.getAddress();
  console.log(`   EntityProvider: ${entityProviderAddr}`);

  // 3. Deploy Depository (needs Account library linked)
  console.log("3️⃣ Deploying Depository...");
  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: {
      Account: accountAddr,
    },
  });
  const depository = await Depository.deploy(entityProviderAddr);
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

  console.log("\n✅ Stack deployed successfully!\n");
  console.log("Update jurisdictions.json with:");
  console.log(JSON.stringify({
    contracts: {
      account: accountAddr,
      entityProvider: entityProviderAddr,
      depository: depositoryAddr,
      deltaTransformer: deltaTransformerAddr,
    }
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
