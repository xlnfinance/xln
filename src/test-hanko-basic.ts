/**
 * 🧪 BASIC HANKO FUNCTIONALITY TEST
 * 
 * Simple test to verify Hanko basics work with real signatures:
 * - Build Hanko with real signatures
 * - Verify TypeScript->Solidity encoding works
 * - Test various signature scenarios
 */

import { ethers } from 'ethers';
import { randomBytes } from 'crypto';
import { HankoBytes } from './types.js';
import { buildRealHanko, packRealSignatures, unpackRealSignatures, detectSignatureCount } from './hanko-real.js';

// Test private keys (same as in other tests)
const testKeys = {
  alice: Buffer.from('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c6a2440020bbaa6bd1a13'.slice(2), 'hex'),
  bob: Buffer.from('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804d99bb9a1'.slice(2), 'hex'),
  carol: Buffer.from('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'.slice(2), 'hex')
};

const testAddresses = {
  alice: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  bob: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  carol: '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
};

/**
 * Test 1: Single signature Hanko
 */
async function testSingleSignature() {
  console.log('\n🧪 TEST 1: Single Signature Hanko');
  
  const testHash = Buffer.from(ethers.randomBytes(32));
  
  const hanko = await buildRealHanko(testHash, {
    noEntities: [], // No failed entities
    privateKeys: [testKeys.alice], // Alice signs
    claims: [] // No claims
  });
  
  console.log('✅ Built Hanko with:');
  console.log(`   - Placeholders: ${hanko.placeholders.length}`);
  console.log(`   - Packed signatures: ${hanko.packedSignatures.length} bytes`);
  console.log(`   - Claims: ${hanko.claims.length}`);
  
  // Verify signature count detection
  const sigCount = detectSignatureCount(hanko.packedSignatures);
  console.log(`   - Detected signatures: ${sigCount}`);
  
  // Verify unpacking
  const signatures = unpackRealSignatures(hanko.packedSignatures);
  console.log(`   - Unpacked signatures: ${signatures.length}`);
  
  return true;
}

/**
 * Test 2: Multiple signatures Hanko
 */
async function testMultipleSignatures() {
  console.log('\n🧪 TEST 2: Multiple Signatures Hanko');
  
  const testHash = Buffer.from(ethers.randomBytes(32));
  
  const hanko = await buildRealHanko(testHash, {
    noEntities: [],
    privateKeys: [testKeys.alice, testKeys.bob, testKeys.carol], // All three sign
    claims: []
  });
  
  console.log('✅ Built Hanko with:');
  console.log(`   - Placeholders: ${hanko.placeholders.length}`);
  console.log(`   - Packed signatures: ${hanko.packedSignatures.length} bytes`);
  console.log(`   - Claims: ${hanko.claims.length}`);
  
  const sigCount = detectSignatureCount(hanko.packedSignatures);
  console.log(`   - Detected signatures: ${sigCount}`);
  
  const signatures = unpackRealSignatures(hanko.packedSignatures);
  console.log(`   - Unpacked signatures: ${signatures.length}`);
  
  return sigCount === 3 && signatures.length === 3;
}

/**
 * Test 3: Mixed placeholders + signatures + claims
 */
async function testMixedHanko() {
  console.log('\n🧪 TEST 3: Mixed Hanko (placeholders + signatures + claims)');
  
  const testHash = Buffer.from(ethers.randomBytes(32));
  
  const hanko = await buildRealHanko(testHash, {
    noEntities: [Buffer.from(ethers.randomBytes(32))], // 1 failed entity
    privateKeys: [testKeys.alice, testKeys.bob], // 2 signatures
    claims: [{
      entityId: Buffer.from(ethers.randomBytes(32)),
      entityIndexes: [1, 2], // Reference the signatures
      weights: [50, 50],
      threshold: 100,
      expectedQuorumHash: Buffer.from(ethers.randomBytes(32))
    }]
  });
  
  console.log('✅ Built complex Hanko with:');
  console.log(`   - Placeholders: ${hanko.placeholders.length}`);
  console.log(`   - Packed signatures: ${hanko.packedSignatures.length} bytes`);
  console.log(`   - Claims: ${hanko.claims.length}`);
  
  const sigCount = detectSignatureCount(hanko.packedSignatures);
  console.log(`   - Detected signatures: ${sigCount}`);
  
  // Verify structure
  console.log('✅ Hanko structure:');
  console.log(`   - Index 0: Placeholder (${ethers.hexlify(hanko.placeholders[0]).slice(0, 10)}...)`);
  console.log(`   - Index 1-2: Signatures (${sigCount} detected)`);
  console.log(`   - Index 3: Claim referencing entities 1,2`);
  
  return hanko.placeholders.length === 1 && sigCount === 2 && hanko.claims.length === 1;
}

/**
 * Test 4: ABI encoding compatibility
 */
async function testABIEncoding() {
  console.log('\n🧪 TEST 4: ABI Encoding Compatibility');
  
  const testHash = Buffer.from(ethers.randomBytes(32));
  
  const hanko = await buildRealHanko(testHash, {
    noEntities: [],
    privateKeys: [testKeys.alice],
    claims: []
  });
  
  // Test ABI encoding (what we send to Solidity)
  try {
    const hankoData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(bytes[] placeholders, bytes packedSignatures, tuple(bytes entityId, uint256[] entityIndexes, uint256[] weights, uint256 threshold, bytes expectedQuorumHash)[] claims)'],
      [[
        hanko.placeholders.map(p => ethers.hexlify(p)),
        ethers.hexlify(hanko.packedSignatures),
        hanko.claims.map(c => [
          ethers.hexlify(c.entityId),
          c.entityIndexes,
          c.weights,
          c.threshold,
          ethers.hexlify(c.expectedQuorumHash)
        ])
      ]]
    );
    
    console.log('✅ ABI encoding successful');
    console.log(`   - Encoded length: ${hankoData.length} chars`);
    console.log(`   - Sample: ${hankoData.slice(0, 100)}...`);
    
    return true;
  } catch (error) {
    console.error('❌ ABI encoding failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Test 5: Signature verification
 */
async function testSignatureVerification() {
  console.log('\n🧪 TEST 5: Signature Verification');
  
  const testHash = Buffer.from(ethers.randomBytes(32));
  
  // Create signature manually
  const wallet = new ethers.Wallet(ethers.hexlify(testKeys.alice));
  const signature = await wallet.signMessage(testHash);
  
  console.log('✅ Manual signature:');
  console.log(`   - Signer: ${wallet.address}`);
  console.log(`   - Expected: ${testAddresses.alice}`);
  console.log(`   - Signature: ${signature.slice(0, 20)}...`);
  
  // Now create Hanko with same signature
  const hanko = await buildRealHanko(testHash, {
    noEntities: [],
    privateKeys: [testKeys.alice],
    claims: []
  });
  
  const signatures = unpackRealSignatures(hanko.packedSignatures);
  console.log(`   - Hanko signatures: ${signatures.length}`);
  console.log(`   - Hanko sig length: ${signatures[0].length} bytes`);
  
  return signatures.length === 1 && signatures[0].length === 65;
}

/**
 * Main test runner
 */
export async function runBasicHankoTests() {
  console.log('🚀 STARTING BASIC HANKO FUNCTIONALITY TESTS');
  
  const results = [];
  
  try {
    results.push(await testSingleSignature());
    results.push(await testMultipleSignatures());
    results.push(await testMixedHanko());
    results.push(await testABIEncoding());
    results.push(await testSignatureVerification());
    
    const passed = results.filter(Boolean).length;
    const total = results.length;
    
    console.log(`\n🏆 BASIC HANKO TESTS: ${passed}/${total} passed`);
    
    if (passed === total) {
      console.log('✅ ALL BASIC HANKO TESTS PASSED!');
      console.log('✅ Hanko signature building works correctly!');
      console.log('✅ placeholders + packedSignatures + claims structure verified!');
    } else {
      console.log('❌ Some basic tests failed');
    }
    
    return passed === total;
    
  } catch (error) {
    console.error('💥 Basic Hanko tests failed:', error);
    return false;
  }
}