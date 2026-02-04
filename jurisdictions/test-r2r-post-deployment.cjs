const hre = require("hardhat");
const fs = require("fs");

async function main() {
  console.log("\n🧪 Testing Reserve-to-Reserve functionality (Post-Deployment)...");

  // Read deployed contract address from ignition
  const deployedAddressesPath = "ignition/deployments/chain-1337/deployed_addresses.json";
  
  if (!fs.existsSync(deployedAddressesPath)) {
    throw new Error(`❌ Deployed addresses file not found: ${deployedAddressesPath}`);
  }

  const deployedAddresses = JSON.parse(fs.readFileSync(deployedAddressesPath, "utf8"));
  const depositoryAddress = deployedAddresses["DepositoryModule#Depository"];
  
  if (!depositoryAddress) {
    throw new Error("❌ Depository address not found in deployed addresses");
  }

  console.log(`📍 Using deployed Depository at: ${depositoryAddress}`);

  // Connect to the deployed contract (link Account library)
  const accountLibraryAddress = deployedAddresses["DepositoryModule#Account"];
  if (!accountLibraryAddress) {
    throw new Error("❌ Account library address not found in deployed addresses");
  }
  const Depository = await hre.ethers.getContractFactory("Depository", {
    libraries: {
      Account: accountLibraryAddress
    }
  });
  const depository = Depository.attach(depositoryAddress);

  // Get signers
  const [owner] = await hre.ethers.getSigners();
  console.log(`👤 Testing with account: ${owner.address}`);

  // Use pre-funded entity IDs from constructor
  const entity1 = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const entity2 = "0x0000000000000000000000000000000000000000000000000000000000000002"; 
  const tokenId = 1; // Pre-funded token ID from constructor

  console.log("\n📊 Initial balances:");
  let initialBalance1 = await depository._reserves(entity1, tokenId);
  let initialBalance2 = await depository._reserves(entity2, tokenId);
  console.log(`   Entity1: ${hre.ethers.formatEther(initialBalance1)} ETH`);
  console.log(`   Entity2: ${hre.ethers.formatEther(initialBalance2)} ETH`);

  // Ensure entities are funded for the test (constructor no longer pre-funds)
  const expectedBalance = hre.ethers.parseEther("1");
  if (initialBalance1 < expectedBalance) {
    const topup = expectedBalance - initialBalance1;
    const tx = await depository.mintToReserve(entity1, tokenId, topup);
    await tx.wait();
  }
  if (initialBalance2 < expectedBalance) {
    const topup = expectedBalance - initialBalance2;
    const tx = await depository.mintToReserve(entity2, tokenId, topup);
    await tx.wait();
  }

  initialBalance1 = await depository._reserves(entity1, tokenId);
  initialBalance2 = await depository._reserves(entity2, tokenId);
  console.log("✅ Funding verification passed");

  // Create batch for reserve-to-reserve transfer
  const transferAmount = hre.ethers.parseEther("0.1"); // 0.1 tokens
  const batch = {
    flashloans: [],
    reserveToReserve: [{
      receivingEntity: entity2,
      tokenId: tokenId,
      amount: transferAmount
    }],
    reserveToCollateral: [],
    collateralToReserve: [],
    settlements: [],
    disputeStarts: [],
    disputeFinalizations: [],
    externalTokenToReserve: [],
    reserveToExternalToken: [],
    revealSecrets: [],
    hub_id: 0
  };

  console.log("\n🚀 Executing reserve-to-reserve transfer...");
  console.log(`   Transfer: ${hre.ethers.formatEther(transferAmount)} ETH from Entity1 to Entity2`);
  
  // Listen for events (ReserveUpdated is canonical)
  const updateFilter = depository.filters.ReserveUpdated();
  const tx = await depository.unsafeProcessBatch(entity1, batch);
  const receipt = await tx.wait();
  
  console.log(`✅ Transfer successful! TX: ${receipt.hash}`);

  // Check events
  const updateEvents = await depository.queryFilter(updateFilter, receipt.blockNumber, receipt.blockNumber);
  
  console.log("\n📡 Events emitted:");
  console.log(`   ReserveUpdated: ${updateEvents.length}`);

  // Check final balances
  console.log("\n📊 Final balances:");
  const finalBalance1 = await depository._reserves(entity1, tokenId);
  const finalBalance2 = await depository._reserves(entity2, tokenId);
  console.log(`   Entity1: ${hre.ethers.formatEther(finalBalance1)} ETH`);
  console.log(`   Entity2: ${hre.ethers.formatEther(finalBalance2)} ETH`);

  // Verify transfer worked
  const expectedBalance1 = initialBalance1 - transferAmount;
  const expectedBalance2 = initialBalance2 + transferAmount;
  
  console.log("\n✅ Verification:");
  const balanceCheck1 = finalBalance1 === expectedBalance1;
  const balanceCheck2 = finalBalance2 === expectedBalance2;
  const eventCheck = updateEvents.length >= 2;
  
  console.log(`   Entity1 balance correct: ${balanceCheck1}`);
  console.log(`   Entity2 balance correct: ${balanceCheck2}`);
  console.log(`   ReserveUpdated events emitted: ${eventCheck}`);
  
  if (balanceCheck1 && balanceCheck2 && eventCheck) {
    console.log("\n🎉 ALL RESERVE-TO-RESERVE TESTS PASSED!");
    console.log("✅ Depository contract is working correctly in the deployment cycle");
    return true;
  } else {
    console.log("\n❌ RESERVE-TO-RESERVE TESTS FAILED!");
    console.log("   The deployed contract is not working as expected");
    throw new Error("R2R test failure");
  }
}

main()
  .then((success) => {
    if (success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error("\n❌ R2R Test Error:", error.message);
    process.exit(1);
  });
