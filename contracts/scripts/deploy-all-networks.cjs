const { ethers } = require("hardhat");

async function main() {
  console.log("🚀 Deploying contracts to all networks...");

  const networks = [
    { name: "ethereum", url: "http://127.0.0.1:8545" },
    { name: "polygon", url: "http://127.0.0.1:8546" },
    { name: "arbitrum", url: "http://127.0.0.1:8547" }
  ];

  const deployedAddresses = {};

  for (const network of networks) {
    console.log(`\n📡 Deploying to ${network.name} (${network.url})...`);
    
    try {
      // Connect to the network
      const provider = new ethers.JsonRpcProvider(network.url);
      
      // Get signer (using first account)
      const accounts = await provider.listAccounts();
      if (accounts.length === 0) {
        console.log(`⚠️ No accounts found on ${network.name}, skipping...`);
        continue;
      }
      
      const signer = provider.getSigner(accounts[0]);
      console.log(`👤 Using signer: ${accounts[0]}`);

      // Deploy EntityProvider
      console.log(`🏗️ Deploying EntityProvider...`);
      const EntityProvider = await ethers.getContractFactory("EntityProvider", signer);
      const entityProvider = await EntityProvider.deploy();
      await entityProvider.waitForDeployment();
      const entityProviderAddress = await entityProvider.getAddress();
      console.log(`✅ EntityProvider deployed to: ${entityProviderAddress}`);

      // Deploy Depository
      console.log(`🏦 Deploying Depository...`);
      const Depository = await ethers.getContractFactory("Depository", signer);
      const depository = await Depository.deploy();
      await depository.waitForDeployment();
      const depositoryAddress = await depository.getAddress();
      console.log(`✅ Depository deployed to: ${depositoryAddress}`);

      // Store addresses
      deployedAddresses[network.name] = {
        entityProvider: entityProviderAddress,
        depository: depositoryAddress,
        deployer: accounts[0]
      };

      console.log(`🎉 Successfully deployed to ${network.name}!`);
      
    } catch (error) {
      console.error(`❌ Failed to deploy to ${network.name}:`, error.message);
    }
  }

  // Save deployment results
  console.log("\n📋 Deployment Summary:");
  console.log(JSON.stringify(deployedAddresses, null, 2));

  // Update jurisdictions.json with new addresses
  const fs = require('fs');
  const path = require('path');
  
  try {
    const jurisdictionsPath = path.join(__dirname, '../../jurisdictions.json');
    const jurisdictions = JSON.parse(fs.readFileSync(jurisdictionsPath, 'utf8'));
    
    for (const [networkName, addresses] of Object.entries(deployedAddresses)) {
      if (jurisdictions.jurisdictions[networkName]) {
        jurisdictions.jurisdictions[networkName].contracts = {
          entityProvider: addresses.entityProvider,
          depository: addresses.depository
        };
      }
    }
    
    fs.writeFileSync(jurisdictionsPath, JSON.stringify(jurisdictions, null, 2));
    console.log("\n✅ Updated jurisdictions.json with new contract addresses");
    
  } catch (error) {
    console.error("❌ Failed to update jurisdictions.json:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
