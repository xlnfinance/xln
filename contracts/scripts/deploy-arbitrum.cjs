const { ethers } = require("hardhat");

async function main() {
  console.log("🚀 Deploying contracts to Arbitrum network...");
  
  // Deploy EntityProvider
  console.log("🏗️ Deploying EntityProvider...");
  const EntityProvider = await ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy();
  await entityProvider.waitForDeployment();
  const entityProviderAddress = await entityProvider.getAddress();
  console.log(`✅ EntityProvider deployed to: ${entityProviderAddress}`);

  // Deploy Depository
  console.log("🏦 Deploying Depository...");
  const Depository = await ethers.getContractFactory("Depository");
  const depository = await Depository.deploy();
  await depository.waitForDeployment();
  const depositoryAddress = await depository.getAddress();
  console.log(`✅ Depository deployed to: ${depositoryAddress}`);

  console.log("\n📋 Deployment Summary:");
  console.log(`EntityProvider: ${entityProviderAddress}`);
  console.log(`Depository: ${depositoryAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
