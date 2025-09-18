const hre = require("hardhat");

async function main() {
  console.log("Testing Reserve Transfer functionality...");

  // Deploy Depository contract
  const Depository = await hre.ethers.getContractFactory("Depository");
  const depository = await Depository.deploy();
  await depository.waitForDeployment();
  
  console.log("✅ Depository deployed to:", await depository.getAddress());

  // Get signers
  const [owner, user1] = await hre.ethers.getSigners();
  console.log("👤 Owner:", owner.address);
  console.log("👤 User1:", user1.address);

  // Create entity IDs (using simple incrementing pattern for testing)
  const entity1 = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const entity2 = "0x0000000000000000000000000000000000000000000000000000000000000002"; 
  const tokenId = 1; // Pre-funded token ID

  console.log("\n📊 Initial balances:");
  const initialBalance1 = await depository._reserves(entity1, tokenId);
  const initialBalance2 = await depository._reserves(entity2, tokenId);
  console.log(`Entity1: ${initialBalance1.toString()}`);
  console.log(`Entity2: ${initialBalance2.toString()}`);

  // Create batch for reserve-to-reserve transfer
  const transferAmount = hre.ethers.parseEther("0.1"); // 0.1 tokens
  const batch = {
    reserveToExternalToken: [],
    externalTokenToReserve: [],
    reserveToReserve: [{
      receivingEntity: entity2,
      tokenId: tokenId,
      amount: transferAmount
    }],
    reserveToCollateral: [],
    cooperativeUpdate: [],
    cooperativeDisputeProof: [],
    initialDisputeProof: [],
    finalDisputeProof: [],
    flashloans: [],
    hub_id: 0
  };

  console.log("\n🚀 Executing reserve-to-reserve transfer...");
  
  // Listen for events
  const transferFilter = depository.filters.ReserveTransferred();
  const updateFilter = depository.filters.ReserveUpdated();
  
  const tx = await depository.processBatch(entity1, batch);
  const receipt = await tx.wait();
  
  console.log("✅ Transfer successful! Transaction:", receipt.hash);

  // Check events
  const transferEvents = await depository.queryFilter(transferFilter, receipt.blockNumber, receipt.blockNumber);
  const updateEvents = await depository.queryFilter(updateFilter, receipt.blockNumber, receipt.blockNumber);
  
  console.log("\n📡 Events emitted:");
  console.log(`ReserveTransferred events: ${transferEvents.length}`);
  console.log(`ReserveUpdated events: ${updateEvents.length}`);
  
  if (transferEvents.length > 0) {
    const event = transferEvents[0];
    console.log(`📤 Transfer: ${event.args.from} → ${event.args.to} (${event.args.amount} of token ${event.args.tokenId})`);
  }

  // Check final balances
  console.log("\n📊 Final balances:");
  const finalBalance1 = await depository._reserves(entity1, tokenId);
  const finalBalance2 = await depository._reserves(entity2, tokenId);
  console.log(`Entity1: ${finalBalance1.toString()}`);
  console.log(`Entity2: ${finalBalance2.toString()}`);

  // Verify transfer worked
  const expectedBalance1 = initialBalance1 - transferAmount;
  const expectedBalance2 = initialBalance2 + transferAmount;
  
  console.log("\n✅ Verification:");
  console.log(`Entity1 balance correct: ${finalBalance1 === expectedBalance1}`);
  console.log(`Entity2 balance correct: ${finalBalance2 === expectedBalance2}`);
  console.log(`ReserveTransferred event emitted: ${transferEvents.length > 0}`);
  
  if (finalBalance1 === expectedBalance1 && finalBalance2 === expectedBalance2 && transferEvents.length > 0) {
    console.log("\n🎉 ALL TESTS PASSED!");
  } else {
    console.log("\n❌ Some tests failed!");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });