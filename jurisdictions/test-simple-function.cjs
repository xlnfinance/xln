const hre = require("hardhat");

async function main() {
    const contractAddress = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
    console.log("🔍 Testing simple functions on deployed contract...");

    try {
        const contract = await hre.ethers.getContractAt('Depository', contractAddress);

        // Test settle function directly
        console.log("🔍 Testing settle function...");
        const entity1 = "0x0000000000000000000000000000000000000000000000000000000000000001";
        const entity2 = "0x0000000000000000000000000000000000000000000000000000000000000002";

        try {
            // Try a simple settle call (dry run)
            await contract.settle.staticCall(entity1, entity2, []);
            console.log("✅ settle function exists and can be called");
        } catch (e) {
            console.log("❌ settle function failed:", e.message);
        }

        // Test prefundAccount
        console.log("🔍 Testing prefundAccount function...");
        try {
            await contract.prefundAccount.staticCall(entity2, 1, 100);
            console.log("✅ prefundAccount function exists and can be called");
        } catch (e) {
            console.log("❌ prefundAccount function failed:", e.message);
        }

    } catch (error) {
        console.log("❌ Contract connection failed:", error.message);
    }
}

main().catch(console.error);