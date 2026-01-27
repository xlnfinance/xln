/**
 * Test EVM interface abstraction
 * Run: bun runtime/evms/test-evm-interface.ts
 */

import { createEVM, type EVM, type BrowserEVMConfig } from '../evm-interface';

async function main() {
  console.log('Testing EVM interface abstraction...\n');

  // Test BrowserEVM creation
  console.log('1. Creating BrowserEVM...');
  const browserConfig: BrowserEVMConfig = {
    type: 'browser',
    name: 'test-simnet',
  };

  const browserEVM = await createEVM(browserConfig);
  console.log(`   ✅ BrowserEVM created`);
  console.log(`   - Type: ${browserEVM.type}`);
  console.log(`   - Name: ${browserEVM.name}`);
  console.log(`   - ChainId: ${browserEVM.chainId}`);
  console.log(`   - Depository: ${browserEVM.depository.address}`);
  console.log(`   - EntityProvider: ${browserEVM.entityProvider.address}`);

  // Test block number
  const blockNum = await browserEVM.getBlockNumber();
  console.log(`   - Block: ${blockNum}`);

  // Test reserves query
  const testEntity = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const reserves = await browserEVM.depository._reserves(testEntity, 1);
  console.log(`   - Test reserves: ${reserves}`);

  // Test debug fund reserves (browser only)
  if (browserEVM.debugFundReserves) {
    console.log('\n2. Testing debug fund reserves...');
    await browserEVM.debugFundReserves(testEntity, 1, 1000000000000000000n);
    const newReserves = await browserEVM.depository._reserves(testEntity, 1);
    console.log(`   ✅ Funded: ${newReserves}`);
  }

  // Test state capture (browser only)
  if (browserEVM.captureStateRoot) {
    console.log('\n3. Testing state capture...');
    const stateRoot = await browserEVM.captureStateRoot();
    console.log(`   ✅ State root: ${Buffer.from(stateRoot).toString('hex').slice(0, 16)}...`);
  }

  console.log('\n✅ All EVM interface tests passed!');
}

main().catch((e) => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
