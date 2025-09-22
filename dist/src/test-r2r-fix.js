#!/usr/bin/env bun
/**
 * Test and fix reserve-to-reserve transfers
 * Step-by-step approach to identify and fix the issue
 */
import { ethers } from 'ethers';
import { connectToEthereum, fundEntityReserves } from './evm.js';
const TEST_JURISDICTION = {
    address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', // Local hardhat default
    name: 'test',
    entityProviderAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    depositoryAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    chainId: 31337,
};
async function testReserveToReserve() {
    console.log('🧪 Testing Reserve-to-Reserve Fixes\n');
    // Step 1: Connect to contracts
    console.log('Step 1: Connecting to contracts...');
    const { depository, provider } = await connectToEthereum(TEST_JURISDICTION);
    const code = await provider.getCode(depository.target);
    if (code === '0x') {
        console.error('❌ Contract not deployed! Deploy contracts first.');
        process.exit(1);
    }
    console.log('✅ Contract found at', depository.target);
    // Step 2: Create test entities
    const entity1 = ethers.id('test-entity-1');
    const entity2 = ethers.id('test-entity-2');
    console.log('\nStep 2: Test entities created');
    console.log('  Entity 1:', entity1.slice(0, 10) + '...');
    console.log('  Entity 2:', entity2.slice(0, 10) + '...');
    // Step 3: Check initial balances
    console.log('\nStep 3: Checking initial balances...');
    const tokenId = 1; // ETH token
    try {
        const balance1Before = await depository._reserves(entity1, tokenId);
        const balance2Before = await depository._reserves(entity2, tokenId);
        console.log(`  Entity 1 balance: ${ethers.formatEther(balance1Before)} ETH`);
        console.log(`  Entity 2 balance: ${ethers.formatEther(balance2Before)} ETH`);
        // Step 4: Fund entity1 if needed
        if (balance1Before === 0n) {
            console.log('\nStep 4: Funding Entity 1...');
            // Try bulk funding first (if available in contract)
            try {
                console.log('  Attempting debugBulkFundEntities...');
                const tx = await depository.debugBulkFundEntities();
                await tx.wait();
                console.log('  ✅ Bulk funding completed');
            }
            catch (e) {
                console.log('  ⚠️ Bulk funding not available, trying direct funding...');
                // Use the fundEntityReserves helper
                await fundEntityReserves(entity1, [
                    { tokenId: 1, amount: ethers.parseEther('10').toString(), symbol: 'ETH' }
                ]);
            }
            // Verify funding worked
            const balance1After = await depository._reserves(entity1, tokenId);
            console.log(`  Entity 1 new balance: ${ethers.formatEther(balance1After)} ETH`);
            if (balance1After === 0n) {
                console.error('❌ Failed to fund entity!');
                process.exit(1);
            }
        }
        // Step 5: Test direct reserve-to-reserve
        console.log('\nStep 5: Testing direct reserve-to-reserve transfer...');
        const transferAmount = ethers.parseEther('1');
        console.log(`  Transferring ${ethers.formatEther(transferAmount)} ETH from Entity 1 to Entity 2`);
        try {
            const tx = await depository.reserveToReserve(entity1, entity2, tokenId, transferAmount);
            console.log(`  Transaction sent: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`  ✅ Transaction confirmed in block ${receipt.blockNumber}`);
            // Step 6: Verify final balances
            console.log('\nStep 6: Verifying final balances...');
            const balance1Final = await depository._reserves(entity1, tokenId);
            const balance2Final = await depository._reserves(entity2, tokenId);
            console.log(`  Entity 1 final: ${ethers.formatEther(balance1Final)} ETH`);
            console.log(`  Entity 2 final: ${ethers.formatEther(balance2Final)} ETH`);
            const expectedBalance1 = balance1Before - transferAmount;
            const expectedBalance2 = balance2Before + transferAmount;
            if (balance1Final === expectedBalance1 && balance2Final === expectedBalance2) {
                console.log('\n🎉 SUCCESS: Reserve-to-reserve is working!');
            }
            else {
                console.log('\n⚠️ WARNING: Balances don\'t match expected values');
                console.log(`  Expected Entity 1: ${ethers.formatEther(expectedBalance1)}`);
                console.log(`  Expected Entity 2: ${ethers.formatEther(expectedBalance2)}`);
            }
        }
        catch (error) {
            console.error('\n❌ Reserve-to-reserve failed:', error.message);
            // Try to decode the revert reason
            if (error.data) {
                try {
                    const reason = depository.interface.parseError(error.data);
                    console.error('  Revert reason:', reason);
                }
                catch {
                    console.error('  Raw error data:', error.data);
                }
            }
            // Suggest fixes based on common errors
            if (error.message.includes('insufficient')) {
                console.log('\n💡 Fix: Entity needs more funds. Try increasing funding amount.');
            }
            else if (error.message.includes('unauthorized')) {
                console.log('\n💡 Fix: Check if entity is registered in EntityProvider contract.');
            }
            else if (error.message.includes('invalid')) {
                console.log('\n💡 Fix: Verify entity IDs are valid bytes32 values.');
            }
        }
    }
    catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}
// Run the test
testReserveToReserve().catch(console.error);
