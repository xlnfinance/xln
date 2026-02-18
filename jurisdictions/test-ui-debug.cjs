const hre = require("hardhat");
const fs = require("fs");

async function main() {
  console.log("\n🔍 Debugging UI R2R Issue...");

  // Read deployed contract address
  const deployedAddressesPath = "ignition/deployments/chain-31337/deployed_addresses.json";
  const deployedAddresses = JSON.parse(fs.readFileSync(deployedAddressesPath, "utf8"));
  const depositoryAddress = deployedAddresses["DepositoryModule#Depository"];
  
  console.log(`📍 Using Depository: ${depositoryAddress}`);

  // Connect to deployed contract
  const Depository = await hre.ethers.getContractFactory("Depository");
  const depository = Depository.attach(depositoryAddress);

  // Test entities
  const entity1 = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const entity2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
  
  console.log(`\n🔍 Testing Entity→Entity transfer:`);
  console.log(`   From: ${entity1}`);
  console.log(`   To:   ${entity2}`);

  // Check balances
  const balance1Before = await depository._reserves(entity1, 1);
  const balance2Before = await depository._reserves(entity2, 1);
  console.log(`\n📊 Before:`);
  console.log(`   Entity1 Token1: ${hre.ethers.formatEther(balance1Before)} ETH`);
  console.log(`   Entity2 Token1: ${hre.ethers.formatEther(balance2Before)} ETH`);

  // Create the exact same batch structure as UI
  const batch = {
    reserveToExternalToken: [],
    externalTokenToReserve: [], 
    reserveToReserve: [{
      receivingEntity: entity2,
      tokenId: 1,
      amount: hre.ethers.parseEther("0.1") // 0.1 ETH worth
    }],
    reserveToCollateral: [],
    cooperativeUpdate: [],
    cooperativeDisputeProof: [],
    initialDisputeProof: [],
    finalDisputeProof: [],
    flashloans: [],
    hub_id: 0
  };

  console.log(`\n🔍 Batch structure:`, JSON.stringify({
    ...batch,
    reserveToReserve: batch.reserveToReserve.map(r => ({
      ...r,
      amount: r.amount.toString() + ' wei'
    }))
  }, null, 2));

  try {
    // Test static call first
    console.log(`\n🧪 Testing static call...`);
    const staticResult = await depository.processBatch.staticCall(entity1, batch);
    console.log(`✅ Static call successful: ${staticResult}`);
    
    // If static call works, do real transaction
    console.log(`\n💸 Executing real transaction...`);
    const tx = await depository.processBatch(entity1, batch);
    const receipt = await tx.wait();
    console.log(`✅ Transaction successful: ${receipt.hash}`);

    // Check balances after
    const balance1After = await depository._reserves(entity1, 1);
    const balance2After = await depository._reserves(entity2, 1);
    console.log(`\n📊 After:`);
    console.log(`   Entity1 Token1: ${hre.ethers.formatEther(balance1After)} ETH`);
    console.log(`   Entity2 Token1: ${hre.ethers.formatEther(balance2After)} ETH`);

    // Verify transfer
    const expectedBalance1 = balance1Before - hre.ethers.parseEther("0.1");
    const expectedBalance2 = balance2Before + hre.ethers.parseEther("0.1");
    
    console.log(`\n✅ Verification:`);
    console.log(`   Entity1 correct: ${balance1After === expectedBalance1}`);
    console.log(`   Entity2 correct: ${balance2After === expectedBalance2}`);
    
    if (balance1After === expectedBalance1 && balance2After === expectedBalance2) {
      console.log(`\n🎉 CONTRACT WORKS PERFECTLY!`);
      console.log(`   The issue is in the UI ABI or parameters`);
    } else {
      console.log(`\n❌ Contract has issues`);
    }

  } catch (error) {
    console.error(`\n❌ Contract call failed:`, error.message);
    
    // Try to understand the error
    if (error.message.includes('require(false)')) {
      console.log(`\n🔍 This is likely a validation error in the contract:`);
      console.log(`   - Check if entity has sufficient balance`);
      console.log(`   - Check if self-transfer protection is triggered`);
      console.log(`   - Check if batch structure matches contract expectations`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });