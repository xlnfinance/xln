const hre = require("hardhat");

async function main() {
  console.log("🔄 Deploying EntityProvider...");
  
  // Deploy EntityProvider contract
  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy();
  
  await entityProvider.waitForDeployment();
  
  const address = await entityProvider.getAddress();
  console.log(`✅ EntityProvider deployed to: ${address}`);
  
  // Output in a format that's easy to parse
  console.log(`DEPLOYED_ADDRESS=${address}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 