#!/usr/bin/env bun

/**
 * BrowserEVM prototype using @ethereumjs/vm
 * Tests deploying Depository.sol and calling debugFundReserves
 */

import { createVM, runTx } from '@ethereumjs/vm';
import { createLegacyTx } from '@ethereumjs/tx';
import { Address, createAddressFromPrivateKey, hexToBytes, createAccount } from '@ethereumjs/util';
import { readFileSync } from 'fs';

// Load contract artifact (Depository - self-contained)
const depositoryArtifact = JSON.parse(
  readFileSync('./jurisdictions/artifacts/contracts/Depository.sol/Depository.json', 'utf-8')
);

const bytecode = depositoryArtifact.bytecode;
const abi = depositoryArtifact.abi;

console.log('📦 Loaded Depository.sol artifact (IDepository implementation)');
console.log(`   Bytecode size: ${bytecode.length / 2} bytes`);

// Create EthereumJS VM
const vm = await createVM();
const common = vm.common;

console.log('\n🚀 Created EthereumJS VM');

// Deployer account
const deployerPrivKey = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // Hardhat account #0
const deployerAddress = createAddressFromPrivateKey(deployerPrivKey);

console.log(`👤 Deployer: ${deployerAddress.toString()}`);

// Fund deployer
const deployerAccount = createAccount({
  nonce: 0n,
  balance: 10000000000000000000000n, // 10000 ETH
});
await vm.stateManager.putAccount(deployerAddress, deployerAccount);

console.log('💰 Funded deployer with 10000 ETH');

// Deploy contract
async function deployDepository() {
  console.log('\n📝 Deploying Depository.sol...');

  const tx = createLegacyTx({
    gasLimit: 100000000n, // Large contract needs lots of gas
    gasPrice: 10n, // Must be >= baseFeePerGas (7 for Prague)
    data: bytecode,
  }, { common }).sign(deployerPrivKey);

  const result = await runTx(vm, { tx });

  if (result.execResult.exceptionError) {
    console.error('❌ Deployment failed:', result.execResult.exceptionError);
    process.exit(1);
  }

  const deployedAddress = result.createdAddress!;
  console.log(`✅ Deployed at: ${deployedAddress.toString()}`);
  console.log(`⛽ Gas used: ${result.totalGasSpent}`);

  // Verify contract code exists
  const code = await vm.stateManager.getCode(deployedAddress);
  console.log(`📋 Contract code length: ${code.length} bytes`);

  return deployedAddress;
}

// Test debugFundReserves
async function testFundReserves(contractAddress: Address) {
  console.log('\n🧪 Testing debugFundReserves...');

  // Encode function call: debugFundReserves(bytes32 entity, uint tokenId, uint amount)
  const entityId = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const tokenId = '0x0000000000000000000000000000000000000000000000000000000000000001'; // 1
  const amount = '00000000000000000000000000000000000000000000003635c9adc5dea00000'; // 1000 ETH

  // Function selector for debugFundReserves(bytes32,uint256,uint256)
  const selector = '0x5ffefe5b';

  const callData = selector + entityId.slice(2) + tokenId.slice(2) + amount;

  console.log(`   Call data: ${callData.slice(0, 66)}...`);

  const tx = createLegacyTx({
    to: contractAddress,
    gasLimit: 1000000n,
    gasPrice: 10n, // Must be >= baseFeePerGas
    data: callData,
    nonce: 1n,
  }, { common }).sign(deployerPrivKey);

  const result = await runTx(vm, { tx });

  if (result.execResult.exceptionError) {
    console.error('❌ Call failed:', result.execResult.exceptionError);
    return false;
  }

  console.log(`✅ Transaction executed`);
  console.log(`⛽ Gas used: ${result.totalGasSpent}`);

  // Check logs (ReserveUpdated event)
  if (result.execResult.logs && result.execResult.logs.length > 0) {
    console.log(`📜 Emitted ${result.execResult.logs.length} log(s)`);
  }

  return true;
}

// Run test
(async () => {
  try {
    const contractAddress = await deployDepository();
    const success = await testFundReserves(contractAddress);

    console.log('\n' + '='.repeat(60));
    if (success) {
      console.log('✅ BROWSER EVM PROTOTYPE: SUCCESS');
      console.log('   EthereumJS VM works! Ready for browser integration.');
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
