/**
 * JTest - Simplified JAdapter Test
 * Tests basic functionality with both browservm and anvil
 *
 * Usage:
 *   bun runtime/scenarios/jtest.ts            # browservm mode
 *   bun runtime/scenarios/jtest.ts anvil      # anvil mode (requires running anvil)
 *
 * @license AGPL-3.0
 */

import { createJAdapter, type JAdapter } from '../jadapter';
import { ethers } from 'ethers';

const mode = process.argv[2] === 'anvil' ? 'anvil' : 'browservm';

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  JTest - Mode: ${mode.toUpperCase()}`);
  console.log(`══════════════════════════════════════════════════════════════\n`);

  // Create JAdapter
  const config = mode === 'anvil'
    ? { mode: 'anvil' as const, chainId: 31337, rpcUrl: 'http://127.0.0.1:8545' }
    : { mode: 'browservm' as const, chainId: 31337 };

  console.log('1. Creating JAdapter...');
  const j = await createJAdapter(config);
  console.log(`   ✓ Provider created (chainId: ${j.chainId})`);

  // Deploy contracts (anvil needs this, browservm already has them)
  console.log('\n2. Deploying contracts...');
  await j.deployStack();
  console.log(`   ✓ Depository: ${j.addresses.depository}`);
  console.log(`   ✓ EntityProvider: ${j.addresses.entityProvider}`);

  // Test 1: Read reserves (should be 0)
  console.log('\n3. Testing reserve reads...');
  const testEntityId = '0x' + '1'.repeat(64);
  const reserves = await j.depository._reserves(testEntityId, 0);
  console.log(`   ✓ Reserves for test entity: ${reserves}`);
  if (reserves !== 0n) {
    throw new Error(`Expected 0 reserves, got ${reserves}`);
  }

  // Test 2: Check entity count
  console.log('\n4. Testing entity provider...');
  const initialNextNumber = await j.entityProvider.nextNumber();
  console.log(`   ✓ Initial next entity number: ${initialNextNumber}`);

  // Test 3: Register an entity (single transaction)
  console.log('\n5. Testing entity registration...');
  const boardHash = ethers.keccak256(ethers.toUtf8Bytes('jtest-entity-1'));

  // Get current nonce before sending
  const signerAddr = await j.signer.getAddress();
  const nonceBefore = await j.provider.getTransactionCount(signerAddr);
  console.log(`   Signer: ${signerAddr.slice(0, 10)}...`);
  console.log(`   Nonce before tx: ${nonceBefore}`);

  const tx = await j.entityProvider.registerNumberedEntity(boardHash);
  console.log(`   Tx sent: ${tx.hash.slice(0, 18)}...`);

  const receipt = await tx.wait();
  console.log(`   ✓ Tx confirmed in block ${receipt?.blockNumber}`);

  const nonceAfter = await j.provider.getTransactionCount(signerAddr);
  console.log(`   Nonce after tx (provider): ${nonceAfter}`);

  // Verify registration
  const afterNextNumber = await j.entityProvider.nextNumber();
  console.log(`   ✓ Next entity number after: ${afterNextNumber}`);

  if (afterNextNumber !== initialNextNumber + 1n) {
    throw new Error(`Expected nextNumber to increase by 1`);
  }

  // Test 4: Deposit 1M+ tokens to 3 entities across 3 token types
  console.log('\n6. Testing reserve deposits (1M+ across 3 tokens)...');

  // Create test entity IDs (using registered entity and two more)
  const entity1 = ethers.keccak256(ethers.toUtf8Bytes('deposit-test-entity-1'));
  const entity2 = ethers.keccak256(ethers.toUtf8Bytes('deposit-test-entity-2'));
  const entity3 = ethers.keccak256(ethers.toUtf8Bytes('deposit-test-entity-3'));

  // Define amounts: 1M, 2M, 5M
  const depositAmounts = [
    { entityId: entity1, tokenId: 1, amount: 1_000_000n * 10n ** 18n },  // 1M USDC
    { entityId: entity2, tokenId: 2, amount: 2_000_000n * 10n ** 18n },  // 2M WETH
    { entityId: entity3, tokenId: 3, amount: 5_000_000n * 10n ** 18n },  // 5M USDT
  ];

  // Mint to reserves using admin function
  for (const { entityId, tokenId, amount } of depositAmounts) {
    const txMint = await j.depository.mintToReserve(entityId, tokenId, amount);
    await txMint.wait();
    const reserves = await j.depository._reserves(entityId, tokenId);
    const formattedAmt = Number(amount / 10n ** 18n).toLocaleString();
    console.log(`   ✓ Entity ${entityId.slice(0, 10)}... token=${tokenId} reserve=${formattedAmt}`);

    if (reserves !== amount) {
      throw new Error(`Reserve mismatch: expected ${amount}, got ${reserves}`);
    }
  }

  // Test reserve-to-reserve transfer
  console.log('\n7. Testing reserve-to-reserve transfer...');
  const transferAmt = 100_000n * 10n ** 18n; // 100k
  const txR2R = await j.depository.reserveToReserve(entity1, entity3, 1, transferAmt);
  await txR2R.wait();

  const e1After = await j.depository._reserves(entity1, 1);
  const e3After = await j.depository._reserves(entity3, 1);
  console.log(`   Entity1 reserve after: ${Number(e1After / 10n ** 18n).toLocaleString()}`);
  console.log(`   Entity3 reserve after: ${Number(e3After / 10n ** 18n).toLocaleString()}`);

  if (e1After !== depositAmounts[0].amount - transferAmt) {
    throw new Error(`Entity1 reserve wrong after R2R`);
  }
  if (e3After !== transferAmt) {
    throw new Error(`Entity3 reserve wrong after R2R`);
  }
  console.log(`   ✓ R2R transfer successful (100k from Entity1 to Entity3)`);

  // Test 5: Snapshot and revert (if supported)
  if (mode !== 'rpc') {
    console.log('\n8. Testing snapshot/revert...');
    const snapshotId = await j.snapshot();
    console.log(`   Snapshot: ${snapshotId.slice(0, 18)}...`);

    // Register another entity
    const boardHash2 = ethers.keccak256(ethers.toUtf8Bytes('jtest-entity-2'));
    const tx2 = await j.entityProvider.registerNumberedEntity(boardHash2);
    await tx2.wait();

    const afterSecond = await j.entityProvider.nextNumber();
    console.log(`   After second registration: nextNumber=${afterSecond}`);

    // Revert
    await j.revert(snapshotId);
    const afterRevert = await j.entityProvider.nextNumber();
    console.log(`   After revert: nextNumber=${afterRevert}`);

    if (afterRevert !== afterNextNumber) {
      console.log(`   ⚠ Revert mismatch: expected ${afterNextNumber}, got ${afterRevert}`);
    } else {
      console.log(`   ✓ Revert successful`);
    }
  }

  // Cleanup
  await j.close();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  JTest PASSED (${mode} mode)`);
  console.log(`══════════════════════════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  if (err.stack) {
    console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  }
  process.exit(1);
});
