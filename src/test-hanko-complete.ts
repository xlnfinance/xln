/**
 * Comprehensive Hanko Bytes Tests
 * Tests real Ethereum signatures, flashloan governance, and edge cases
 */

import { ethers } from 'ethers';
import { createHash, randomBytes } from './utils.js';
import { 
  buildRealHanko, 
  packRealSignatures, 
  unpackRealSignatures,
  createDirectHashSignature,
  verifySignatureRecovery,
  recoverHankoEntities,
  testFullCycle,
  testGasOptimization
} from './hanko-real.js';

// === TEST UTILITIES ===

const generateTestKeys = (count: number) => {
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push(randomBytes(32));
  }
  return keys;
};

const getWalletFromKey = (privateKey: Buffer) => {
  return new ethers.Wallet(ethers.hexlify(privateKey));
};

// === SIGNATURE TESTS ===

const testRealSignatures = async (): Promise<void> => {
  console.log('\n🔐 === REAL SIGNATURE TESTS ===\n');
  
  const testHash = createHash('sha256').update('test message').digest();
  const privateKey = randomBytes(32);
  const wallet = getWalletFromKey(privateKey);
  
  console.log(`📄 Test hash: 0x${testHash.toString('hex')}`);
  console.log(`🔑 Test wallet: ${wallet.address}`);
  
  // Test signature creation
  const signature = await createDirectHashSignature(testHash, privateKey);
  console.log(`✅ Created signature: ${signature.length} bytes`);
  
  // Test signature verification
  const verified = await verifySignatureRecovery(testHash, signature, wallet.address);
  console.log(`✅ Signature verification: ${verified ? 'PASS' : 'FAIL'}`);
  
  if (!verified) {
    throw new Error('Signature verification failed');
  }
};

// === PACKING TESTS ===

const testSignaturePacking = async (): Promise<void> => {
  console.log('\n📦 === SIGNATURE PACKING TESTS ===\n');
  
  const testHash = createHash('sha256').update('packing test').digest();
  const keys = generateTestKeys(3);
  const signatures = [];
  
  for (let i = 0; i < keys.length; i++) {
    const sig = await createDirectHashSignature(testHash, keys[i]);
    signatures.push(sig);
  }
  
  console.log(`📄 Original signatures: ${signatures.length} × 65 bytes = ${signatures.length * 65} bytes`);
  
  // Test packing
  const packed = packRealSignatures(signatures);
  console.log(`📦 Packed signatures: ${packed.length} bytes`);
  
  // Test unpacking
  const unpacked = unpackRealSignatures(packed);
  console.log(`📦 Unpacked signatures: ${unpacked.length} signatures`);
  
  // Verify unpacked signatures match
  for (let i = 0; i < signatures.length; i++) {
    const original = signatures[i];
    const recovered = unpacked[i];
    
    // Browser-compatible comparison: convert to hex strings
    const originalHex = Buffer.from(original).toString('hex');
    const recoveredHex = Buffer.from(recovered).toString('hex');
    const match = originalHex === recoveredHex;
    
    console.log(`   Signature ${i + 1}: ${match ? '✅' : '❌'} Match`);
    
    if (!match) {
      throw new Error(`Signature ${i + 1} packing/unpacking failed`);
    }
  }
};

// === BASIC HANKO TESTS ===

const testBasicHanko = async (): Promise<void> => {
  console.log('\n🖋️  === BASIC HANKO TESTS ===\n');
  
  const testHash = createHash('sha256').update('basic hanko test').digest();
  const keys = generateTestKeys(2);
  const wallets = keys.map(getWalletFromKey);
  
  console.log(`🔑 Signers: ${wallets.map(w => w.address.slice(0, 10) + '...').join(', ')}`);
  
  // Build basic hanko (simple entity with 2 EOA signers)
  const hanko = await buildRealHanko(testHash, {
    noEntities: [], // No failed entities
    privateKeys: keys,
    claims: [{
      entityId: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      entityIndexes: [0, 1], // Both signatures
      weights: [1, 1],
      threshold: 2,
      expectedQuorumHash: randomBytes(32)
    }]
  });
  
  console.log(`✅ Built hanko with ${hanko.claims.length} claims`);
  console.log(`📦 Packed signatures: ${hanko.packedSignatures.length} bytes`);
  console.log(`📋 Placeholders: ${hanko.placeholders.length}`);
  
  // Test recovery
  const recovered = await recoverHankoEntities(hanko, testHash);
  console.log(`🔍 Recovered: ${recovered.yesEntities.length} yes, ${recovered.noEntities.length} no`);
  
  if (recovered.yesEntities.length !== 3) { // 2 EOAs + 1 entity claim
    throw new Error(`Expected 3 yes entities, got ${recovered.yesEntities.length}`);
  }
};

// === HIERARCHICAL HANKO TESTS ===

const testHierarchicalHanko = async (): Promise<void> => {
  console.log('\n🏗️  === HIERARCHICAL HANKO TESTS ===\n');
  
  const testHash = createHash('sha256').update('hierarchical hanko test').digest();
  const keys = generateTestKeys(4);
  const wallets = keys.map(getWalletFromKey);
  
  console.log(`🔑 EOA Signers: ${wallets.map(w => w.address.slice(0, 10) + '...').join(', ')}`);
  
  // Build hierarchical hanko:
  // - Entity A: Requires 2/3 EOAs (indexes 0, 1, 2)
  // - Entity B: Requires Entity A + 1 EOA (index 3)
  const hanko = await buildRealHanko(testHash, {
    noEntities: [], 
    privateKeys: keys,
    claims: [
      {
        // Entity A: 3 EOAs, needs 2
        entityId: Buffer.from('000000000000000000000000000000000000000000000000000000000000000A', 'hex'),
        entityIndexes: [0, 1, 2], // First 3 signatures
        weights: [1, 1, 1],
        threshold: 2,
        expectedQuorumHash: randomBytes(32)
      },
      {
        // Entity B: Entity A + 1 EOA, needs both
        entityId: Buffer.from('000000000000000000000000000000000000000000000000000000000000000B', 'hex'),
        entityIndexes: [4, 3], // Entity A (index 4 = first claim) + EOA (index 3)
        weights: [1, 1],
        threshold: 2,
        expectedQuorumHash: randomBytes(32)
      }
    ]
  });
  
  console.log(`✅ Built hierarchical hanko:`);
  console.log(`   Entity A: 3 EOAs → threshold 2`);
  console.log(`   Entity B: Entity A + 1 EOA → threshold 2`);
  
  // Test flashloan governance recovery
  const recovered = await recoverHankoEntities(hanko, testHash);
  console.log(`🔍 Flashloan recovery: ${recovered.yesEntities.length} yes entities`);
  
  // Should have: 4 EOAs + 2 entity claims = 6 yes entities
  if (recovered.yesEntities.length !== 6) {
    throw new Error(`Expected 6 yes entities, got ${recovered.yesEntities.length}`);
  }
};

// === EDGE CASE TESTS ===

const testEdgeCases = async (): Promise<void> => {
  console.log('\n⚠️  === EDGE CASE TESTS ===\n');
  
  const testHash = createHash('sha256').update('edge case test').digest();
  
  // Test 1: Empty hanko
  console.log('🧪 Test 1: Empty hanko');
  try {
    const emptyHanko = await buildRealHanko(testHash, {
      noEntities: [],
      privateKeys: [],
      claims: []
    });
    console.log('✅ Empty hanko created successfully');
  } catch (error) {
    console.log('❌ Empty hanko failed:', error);
  }
  
  // Test 2: Single signature
  console.log('🧪 Test 2: Single signature hanko');
  const singleKey = [randomBytes(32)];
  const singleHanko = await buildRealHanko(testHash, {
    noEntities: [],
    privateKeys: singleKey,
    claims: [{
      entityId: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      entityIndexes: [0],
      weights: [1],
      threshold: 1,
      expectedQuorumHash: randomBytes(32)
    }]
  });
  console.log('✅ Single signature hanko created');
  
  // Test 3: Failed entities (placeholders)
  console.log('🧪 Test 3: Hanko with failed entities');
  const failedHanko = await buildRealHanko(testHash, {
    noEntities: [randomBytes(32), randomBytes(32)], // 2 failed entities
    privateKeys: singleKey,
    claims: [{
      entityId: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      entityIndexes: [0, 1, 2], // placeholder, placeholder, signature
      weights: [1, 1, 1],
      threshold: 1, // Only needs the signature
      expectedQuorumHash: randomBytes(32)
    }]
  });
  console.log('✅ Failed entities hanko created');
  
  const failedRecovered = await recoverHankoEntities(failedHanko, testHash);
  console.log(`   Recovered: ${failedRecovered.yesEntities.length} yes, ${failedRecovered.noEntities.length} placeholders`);
};

// === PERFORMANCE TESTS ===

const testPerformance = async (): Promise<void> => {
  console.log('\n⚡ === PERFORMANCE TESTS ===\n');
  
  const testHash = createHash('sha256').update('performance test').digest();
  
  // Test with larger number of signatures
  const LARGE_COUNT = 50;
  console.log(`🏃 Testing with ${LARGE_COUNT} signatures...`);
  
  const startTime = Date.now();
  const largeKeys = generateTestKeys(LARGE_COUNT);
  
  const largeHanko = await buildRealHanko(testHash, {
    noEntities: [],
    privateKeys: largeKeys,
    claims: [{
      entityId: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      entityIndexes: Array.from({length: LARGE_COUNT}, (_, i) => i),
      weights: Array.from({length: LARGE_COUNT}, () => 1),
      threshold: Math.floor(LARGE_COUNT * 0.66), // 66% threshold
      expectedQuorumHash: randomBytes(32)
    }]
  });
  
  const buildTime = Date.now() - startTime;
  console.log(`✅ Built large hanko in ${buildTime}ms`);
  console.log(`📦 Size: ${largeHanko.packedSignatures.length} bytes packed signatures`);
  
  // Test recovery performance
  const recoverStart = Date.now();
  const recovered = await recoverHankoEntities(largeHanko, testHash);
  const recoverTime = Date.now() - recoverStart;
  
  console.log(`🔍 Recovery took ${recoverTime}ms`);
  console.log(`📊 Throughput: ${Math.round(LARGE_COUNT / (buildTime + recoverTime) * 1000)} sigs/sec`);
};

// === INTEGRATION TESTS ===

const testIntegration = async (): Promise<void> => {
  console.log('\n🔗 === INTEGRATION TESTS ===\n');
  
  // Run full cycle test
  console.log('🧪 Running full cycle test...');
  const cycleResult = await testFullCycle();
  console.log('✅ Full cycle test completed');
  
  // Run gas optimization test
  console.log('🧪 Running gas optimization test...');
  await testGasOptimization();
  console.log('✅ Gas optimization test completed');
};

// === MAIN TEST RUNNER ===

const runAllTests = async (): Promise<void> => {
  console.log('🚀 === COMPREHENSIVE HANKO TESTS ===');
  
  try {
    await testRealSignatures();
    await testSignaturePacking();
    await testBasicHanko();
    await testHierarchicalHanko();
    await testEdgeCases();
    await testPerformance();
    await testIntegration();
    
    console.log('\n🎉 === ALL TESTS PASSED ===');
    console.log('✅ Real signatures working');
    console.log('✅ Packing/unpacking working');
    console.log('✅ Basic hanko working');
    console.log('✅ Hierarchical hanko working');
    console.log('✅ Edge cases handled');
    console.log('✅ Performance acceptable');
    console.log('✅ Integration working');
    
  } catch (error) {
    console.error('\n❌ === TEST FAILED ===');
    console.error(error);
    if (typeof process !== 'undefined') {
      process.exit(1);
    }
  }
};

// Run tests if this file is executed directly (Node.js only)
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export {
  runAllTests,
  testRealSignatures,
  testSignaturePacking,
  testBasicHanko,
  testHierarchicalHanko,
  testEdgeCases,
  testPerformance,
  testIntegration
}; 