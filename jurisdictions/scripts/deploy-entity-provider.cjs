const hre = require("hardhat");

async function main() {
  console.log("🔄 Deploying EntityProvider...");
  const [deployer] = await hre.ethers.getSigners();
  const foundationRecipient = hre.ethers.getAddress(
    process.env.XLN_FOUNDATION_ADDRESS || deployer.address
  );

  // Deploy EntityProvider contract
  const EntityProvider = await hre.ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy(foundationRecipient);

  await entityProvider.waitForDeployment();

  const address = await entityProvider.getAddress();
  console.log(`✅ EntityProvider deployed to: ${address}`);
  console.log(`✅ Foundation recipient: ${foundationRecipient}`);

  // Output in a format that's easy to parse
  console.log(`DEPLOYED_ADDRESS=${address}`);
  console.log(`FOUNDATION_RECIPIENT=${foundationRecipient}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
