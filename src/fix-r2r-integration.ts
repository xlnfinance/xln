#!/usr/bin/env bun

/**
 * Fix for Reserve-to-Reserve TypeScript Integration
 *
 * The contract R2R works (test-r2r-post-deployment.cjs proves it).
 * The issue is in the TypeScript layer's batch construction.
 */

import { ethers } from 'ethers';
import { connectToEthereum } from './evm.js';
import type { JurisdictionConfig } from './types.js';

// Use the EXACT same entities that are pre-funded in the contract constructor
const PREFUNDED_ENTITY_1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
const PREFUNDED_ENTITY_2 = '0x0000000000000000000000000000000000000000000000000000000000000002';

/**
 * Create a minimal batch for R2R transfer
 * This matches EXACTLY what the contract test does
 */
function createR2RBatch(receivingEntity: string, tokenId: number, amount: bigint) {
  return {
    reserveToExternalToken: [],
    externalTokenToReserve: [],
    reserveToReserve: [{
      receivingEntity,
      tokenId,
      amount  // Keep as bigint, don't convert to string yet
    }],
    reserveToCollateral: [],
    settlements: [],
    cooperativeUpdate: [],
    cooperativeDisputeProof: [],
    initialDisputeProof: [],
    finalDisputeProof: [],
    flashloans: [],
    hub_id: 0
  };
}

export async function executeReserveToReserve(
  jurisdiction: JurisdictionConfig,
  fromEntity: string = PREFUNDED_ENTITY_1,
  toEntity: string = PREFUNDED_ENTITY_2,
  tokenId: number = 1,
  amount: string = '0.1'  // In ether units as string
): Promise<{ success: boolean; txHash?: string; error?: string }> {

  try {
    console.log('\n📦 Executing Reserve-to-Reserve Transfer');
    console.log('━'.repeat(50));

    // Connect to contracts
    const { depository } = await connectToEthereum(jurisdiction);

    // Convert amount to wei
    const amountWei = ethers.parseEther(amount);
    console.log(`💰 Amount: ${amount} ETH → ${amountWei.toString()} wei`);

    // Check balances before
    const balanceBefore1 = await depository._reserves(fromEntity, tokenId);
    const balanceBefore2 = await depository._reserves(toEntity, tokenId);

    console.log('\n📊 Balances Before:');
    console.log(`   From Entity: ${ethers.formatEther(balanceBefore1)} ETH`);
    console.log(`   To Entity:   ${ethers.formatEther(balanceBefore2)} ETH`);

    if (balanceBefore1 < amountWei) {
      throw new Error(`Insufficient balance: ${ethers.formatEther(balanceBefore1)} < ${amount}`);
    }

    // Create batch EXACTLY like the contract test
    const batch = createR2RBatch(toEntity, tokenId, amountWei);

    console.log('\n📤 Sending processBatch transaction...');

    // Execute the batch
    const tx = await depository.processBatch(fromEntity, batch);
    console.log(`   TX Hash: ${tx.hash}`);

    // Wait for confirmation
    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

    // Check balances after
    const balanceAfter1 = await depository._reserves(fromEntity, tokenId);
    const balanceAfter2 = await depository._reserves(toEntity, tokenId);

    console.log('\n📊 Balances After:');
    console.log(`   From Entity: ${ethers.formatEther(balanceAfter1)} ETH`);
    console.log(`   To Entity:   ${ethers.formatEther(balanceAfter2)} ETH`);

    // Verify the transfer worked
    const expectedBalance1 = balanceBefore1 - amountWei;
    const expectedBalance2 = balanceBefore2 + amountWei;

    if (balanceAfter1 === expectedBalance1 && balanceAfter2 === expectedBalance2) {
      console.log('\n✅ Reserve-to-Reserve Transfer Successful!');
      return { success: true, txHash: receipt.hash };
    } else {
      throw new Error('Balance verification failed after transfer');
    }

  } catch (error: any) {
    console.error('\n❌ R2R Transfer Failed:', error.message);
    return { success: false, error: error.message };
  }
}

// Export for use in other modules
export { PREFUNDED_ENTITY_1, PREFUNDED_ENTITY_2, createR2RBatch };

// If running directly, execute a test transfer
if (import.meta.main) {
  const TEST_JURISDICTION: JurisdictionConfig = {
    address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    name: 'localhost',
    entityProviderAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    depositoryAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    chainId: 31337,
  };

  console.log('🧪 Testing Fixed R2R Integration...\n');

  executeReserveToReserve(
    TEST_JURISDICTION,
    PREFUNDED_ENTITY_1,
    PREFUNDED_ENTITY_2,
    1,      // ETH token
    '0.1'   // 0.1 ETH
  ).then(result => {
    if (result.success) {
      console.log('\n🎉 Integration test passed!');
      process.exit(0);
    } else {
      console.log('\n💡 Next steps to debug:');
      console.log('   1. Ensure local blockchain is running: ./start-networks.sh');
      console.log('   2. Deploy contracts: ./deploy-contracts.sh');
      console.log('   3. Check jurisdiction addresses match deployed contracts');
      process.exit(1);
    }
  });
}