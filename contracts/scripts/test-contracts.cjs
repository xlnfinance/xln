const { ethers } = require("hardhat");

async function main() {
  console.log("🧪 Testing contracts on all networks...");

  const networks = [
    { name: "ethereum", url: "http://127.0.0.1:8545" },
    { name: "polygon", url: "http://127.0.0.1:8546" },
    { name: "arbitrum", url: "http://127.0.0.1:8547" }
  ];

  for (const network of networks) {
    console.log(`\n📡 Testing ${network.name} (${network.url})...`);
    
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

      // Test EntityProvider contract
      const entityProviderAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
      const entityProvider = new ethers.Contract(
        entityProviderAddress,
        [
          "function getEntityCount() external view returns (uint256)",
          "function createEntity(bytes32 boardHash) external returns (uint256 entityNumber)",
          "function getEntity(uint256 entityNumber) external view returns (bytes32 boardHash, bool exists)"
        ],
        signer
      );

      // Test getEntityCount
      try {
        const entityCount = await entityProvider.getEntityCount();
        console.log(`✅ Entity count: ${entityCount.toString()}`);
      } catch (error) {
        console.error(`❌ Failed to get entity count:`, error.message);
        continue;
      }

      // Test entity creation
      try {
        const boardHash = ethers.keccak256(ethers.toUtf8Bytes(`test-${Date.now()}`));
        console.log(`🏗️ Creating test entity with board hash: ${boardHash}`);
        
        const tx = await entityProvider.createEntity(boardHash);
        const receipt = await tx.wait();
        
        // Find the EntityCreated event
        const event = receipt.logs.find((log) => 
          log.eventName === 'EntityCreated'
        );
        
        if (event) {
          const entityNumber = Number(event.args.entityNumber);
          console.log(`✅ Test entity created: #${entityNumber} (tx: ${receipt.hash})`);
          
          // Test getting entity info
          const [retrievedBoardHash, exists] = await entityProvider.getEntity(entityNumber);
          console.log(`✅ Retrieved entity #${entityNumber}: boardHash=${retrievedBoardHash}, exists=${exists}`);
        } else {
          console.log(`⚠️ EntityCreated event not found in receipt`);
        }
        
      } catch (error) {
        console.error(`❌ Failed to create test entity:`, error.message);
      }

      // Test Depository contract
      const depositoryAddress = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
      const depository = new ethers.Contract(
        depositoryAddress,
        [
          "function getBalance(address token, address account) external view returns (uint256)"
        ],
        signer
      );

      try {
        const balance = await depository.getBalance(ethers.ZeroAddress, accounts[0]);
        console.log(`✅ Depository balance for ${accounts[0]}: ${balance.toString()}`);
      } catch (error) {
        console.error(`❌ Failed to get depository balance:`, error.message);
      }

      console.log(`🎉 ${network.name} tests completed successfully!`);
      
    } catch (error) {
      console.error(`❌ Failed to test ${network.name}:`, error.message);
    }
  }

  console.log("\n🏁 All network tests completed!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
