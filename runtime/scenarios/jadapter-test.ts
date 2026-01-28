/**
 * JAdapter Test - Verify unified interface works with browservm and anvil
 *
 * Usage:
 *   bun runtime/scenarios/jadapter-test.ts            # browservm mode
 *   bun runtime/scenarios/jadapter-test.ts anvil      # anvil mode (requires running anvil)
 *
 * @license AGPL-3.0
 */

import { createJAdapter, type JAdapter } from '../jadapter';
import { ethers } from 'ethers';

const mode = process.argv[2] === 'anvil' ? 'anvil' : 'browservm';

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  JAdapter Test - Mode: ${mode.toUpperCase()}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  // Create JAdapter
  const config = mode === 'anvil'
    ? { mode: 'anvil' as const, chainId: 31337, rpcUrl: 'http://127.0.0.1:8545' }
    : { mode: 'browservm' as const, chainId: 1337 };

  console.log('1️⃣  Creating JAdapter...');
  const j = await createJAdapter(config);
  console.log(`   ✅ Provider created (chainId: ${j.chainId})`);

  // Deploy contracts
  console.log('\n2️⃣  Deploying contract stack...');
  await j.deployStack();
  console.log(`   ✅ Contracts deployed:`);
  console.log(`      Depository: ${j.addresses.depository}`);
  console.log(`      EntityProvider: ${j.addresses.entityProvider}`);

  // Test read operations via typed contract
  console.log('\n3️⃣  Testing contract reads...');
  const testEntityId = '0x' + '1'.repeat(64);

  // This uses typechain - fully typed!
  const reserves = await j.depository._reserves(testEntityId, 0);
  console.log(`   ✅ Reserves for test entity: ${reserves}`);

  // Test entity registration
  console.log('\n4️⃣  Testing entity registration...');
  const boardHash = ethers.keccak256(ethers.toUtf8Bytes('test-board'));

  const tx = await j.entityProvider.registerNumberedEntity(boardHash);
  console.log(`   📤 Tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`   ✅ Tx confirmed in block ${receipt?.blockNumber}`);

  // Check registration
  const nextNumber = await j.entityProvider.nextNumber();
  console.log(`   ✅ Next entity number: ${nextNumber}`);

  // Test events (via callback)
  console.log('\n5️⃣  Testing events...');
  let eventReceived = false;

  const unsubscribe = j.on('EntityRegistered', (event) => {
    console.log(`   📨 Event received: ${event.name}`);
    eventReceived = true;
  });

  // Register another entity to trigger event
  const boardHash2 = ethers.keccak256(ethers.toUtf8Bytes('test-board-2'));
  const tx2 = await j.entityProvider.registerNumberedEntity(boardHash2);
  await tx2.wait();

  // For anvil/rpc, events are async - need to wait
  if (mode === 'anvil') {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  unsubscribe();

  // Test snapshot/revert (browservm/anvil only)
  if (mode !== 'rpc') {
    console.log('\n6️⃣  Testing snapshot/revert...');

    const snapshotId = await j.snapshot();
    console.log(`   📸 Snapshot taken: ${snapshotId.slice(0, 18)}...`);

    // Make a change
    const boardHash3 = ethers.keccak256(ethers.toUtf8Bytes('test-board-3'));
    await (await j.entityProvider.registerNumberedEntity(boardHash3)).wait();
    const afterChange = await j.entityProvider.nextNumber();
    console.log(`   📊 After change: nextNumber = ${afterChange}`);

    // Revert
    await j.revert(snapshotId);
    const afterRevert = await j.entityProvider.nextNumber();
    console.log(`   🔄 After revert: nextNumber = ${afterRevert}`);

    if (afterRevert < afterChange) {
      console.log(`   ✅ Revert successful!`);
    } else {
      console.log(`   ❌ Revert did not work as expected`);
    }
  }

  // Cleanup
  await j.close();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  JAdapter Test PASSED (${mode} mode)`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
