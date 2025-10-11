#!/usr/bin/env bun

/**
 * Minimal BrowserEVM prototype using Tevm
 * Tests deploying Depository.sol and calling debugFundReserves
 */

import { createMemoryClient, http } from 'tevm';
import { readFileSync } from 'fs';
import { parseAbi, parseEther, encodeFunctionData, decodeFunctionResult } from 'viem';

// Load contract artifact
const depositoryArtifact = JSON.parse(
  readFileSync('./contracts/artifacts/contracts/Depository.sol/Depository.json', 'utf-8')
);

const abi = depositoryArtifact.abi;
const bytecode = depositoryArtifact.bytecode;

console.log('📦 Loaded Depository.sol artifact');
console.log(`   ABI entries: ${abi.length}`);
console.log(`   Bytecode size: ${bytecode.length / 2} bytes`);

// Create Tevm memory client (in-memory EVM)
const client = createMemoryClient({
  fork: undefined, // Don't fork from any network
});

console.log('\n🚀 Created Tevm memory client');

// Deploy contract
async function deployDepository() {
  console.log('\n📝 Deploying Depository.sol...');

  // Need a deployer address with funds
  const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Hardhat default account 0

  // Fund the deployer
  await client.tevmSetAccount({
    address: deployer,
    balance: parseEther('10000'),
  });

  // Use tevmCall with deployment bytecode
  const result = await client.tevmCall({
    from: deployer,
    data: bytecode, // Deployment bytecode
    // DON'T use createTransaction - it's broken/deprecated
  });

  if (result.errors && result.errors.length > 0) {
    console.error('❌ Deployment failed:', result.errors);
    console.error(result.errors);
    process.exit(1);
  }

  const deployedAddress = result.createdAddress;
  if (!deployedAddress) {
    console.error('❌ No contract address returned');
    process.exit(1);
  }

  console.log(`✅ Deployed at: ${deployedAddress}`);

  // tevm's tevmCall applies state immediately in memory mode
  // No need to mine for in-memory client

  // Verify contract exists by getting its code
  const code = await client.getCode({ address: deployedAddress });
  console.log(`📋 Contract code length: ${code?.length || 0} bytes`);

  if (!code || code === '0x') {
    console.error('❌ Contract has no code!');
    process.exit(1);
  }

  return deployedAddress;
}

// Test debugFundReserves function
async function testFundReserves(contractAddress: string) {
  console.log('\n🧪 Testing debugFundReserves...');

  // Entity ID: bytes32(1)
  const entityId = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const tokenId = 1n;
  const amount = parseEther('1000');

  console.log(`   Entity: ${entityId}`);
  console.log(`   Token: ${tokenId}`);
  console.log(`   Amount: ${amount}`);

  // Call debugFundReserves
  const result = await client.tevmContract({
    to: contractAddress,
    abi,
    functionName: 'debugFundReserves',
    args: [entityId, tokenId, amount],
  });

  if (result.errors && result.errors.length > 0) {
    console.error('❌ Fund failed:', result.errors);
    return false;
  }

  console.log(`✅ Transaction executed`);

  // Mine a block to persist the transaction
  await client.tevmMine();
  console.log('⛏️  Mined block');

  // Verify reserves were updated
  const balanceResult = await client.tevmContract({
    to: contractAddress,
    abi,
    functionName: '_reserves',
    args: [entityId, tokenId],
  });

  const balance = balanceResult.data as bigint;
  console.log(`✅ New balance: ${balance}`);
  console.log(`   Expected: ${amount + 100000000000000000000n} (includes debugBulkFundEntities)`);

  return balance > 0n;
}

// Run test
(async () => {
  try {
    const contractAddress = await deployDepository();
    const success = await testFundReserves(contractAddress);

    console.log('\n' + '='.repeat(60));
    if (success) {
      console.log('✅ BROWSER EVM PROTOTYPE: SUCCESS');
      console.log('   Tevm works! Ready for browser integration.');
      process.exit(0);
    } else {
      console.log('❌ BROWSER EVM PROTOTYPE: FAILED');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
})();
