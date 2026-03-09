const { ethers } = require('hardhat');
const fs = require('fs');

const JURISDICTIONS_PATH = 'jurisdictions/jurisdictions.json';

async function deployDirect() {
  console.log('🚀 DIRECT deployment bypassing ignition...');
  
  const [deployer] = await ethers.getSigners();
  console.log(`📍 Deploying with: ${deployer.address}`);
  
  // Deploy contracts directly
  console.log('🔧 Deploying EntityProvider...');
  const EntityProvider = await ethers.getContractFactory("EntityProvider");
  const entityProvider = await EntityProvider.deploy();
  await entityProvider.waitForDeployment();
  const epAddress = await entityProvider.getAddress();
  console.log(`✅ EntityProvider: ${epAddress}`);
  
  console.log('🔧 Deploying Depository...');
  const Depository = await ethers.getContractFactory("Depository");
  const depository = await Depository.deploy(); // Constructor will run debugBulkFundEntities!
  await depository.waitForDeployment();
  const depAddress = await depository.getAddress();
  console.log(`✅ Depository: ${depAddress}`);
  
  console.log('🔧 Adding EntityProvider to Depository...');
  const tx = await depository.addEntityProvider(epAddress);
  await tx.wait();
  console.log('✅ EntityProvider approved');
  
  // TEST: Check if our function works
  console.log('🔍 Testing our debug function...');
  try {
    const testTx = await depository.debugBulkFundEntities();
    await testTx.wait();
    console.log('✅ debugBulkFundEntities works!');
    
    const balance = await depository._reserves("0x0000000000000000000000000000000000000000000000000000000000000001", 1);
    console.log(`💰 Entity 1 has: ${ethers.formatEther(balance)} ETH`);
  } catch (error) {
    console.log('❌ Function test failed:', error.message);
  }
  
  // Update jurisdictions.json
  const jurisdictions = JSON.parse(fs.readFileSync(JURISDICTIONS_PATH, 'utf8'));
  jurisdictions.jurisdictions.ethereum.contracts.entityProvider = epAddress;
  jurisdictions.jurisdictions.ethereum.contracts.depository = depAddress;
  jurisdictions.lastUpdated = new Date().toISOString();
  
  fs.writeFileSync(JURISDICTIONS_PATH, JSON.stringify(jurisdictions, null, 2));
  console.log(`✅ Updated ${JURISDICTIONS_PATH}`);
  
  console.log(`🎯 SUCCESS! Depository with pre-funding: ${depAddress}`);
}

deployDirect().catch(console.error);
