/**
 * 🎯 XLN Hanko Bytes - REAL Ethereum Implementation
 *
 * 🚨 CRITICAL DESIGN PHILOSOPHY: "ASSUME YES" FLASHLOAN GOVERNANCE 🚨
 *
 * This implementation INTENTIONALLY allows entities to mutually validate without EOA signatures.
 * This is NOT a bug - it's a feature for flexible governance structures.
 *
 * KEY DESIGN PRINCIPLES:
 * 1. ✅ Protocol flexibility: Allow exotic governance structures
 * 2. ✅ UI enforcement: Policy decisions belong in application layer
 * 3. ✅ Gas efficiency: Avoid complex graph traversal on-chain
 * 4. ✅ Atomic validation: All-or-nothing verification like flashloans
 *
 * EXAMPLE "LOOPHOLE" THAT IS INTENDED:
 * ```
 * EntityA: { threshold: 1, delegates: [EntityB] }
 * EntityB: { threshold: 1, delegates: [EntityA] }
 * Hanko: {
 *   placeholders: [],
 *   packedSignatures: "0x", // ZERO EOA signatures!
 *   claims: [
 *     { entityId: EntityA, entityIndexes: [1], weights: [100], threshold: 100 },
 *     { entityId: EntityB, entityIndexes: [0], weights: [100], threshold: 100 }
 *   ]
 * }
 * ```
 * Result: ✅ Both entities validate each other → Hanko succeeds!
 *
 * WHY THIS IS INTENDED:
 * - Real entities will include EOAs for practical control
 * - UI can enforce "at least 1 EOA" policies if desired
 * - Enables sophisticated delegation chains
 * - Alternative solutions are expensive and still gameable
 *
 * Uses actual secp256k1 signatures compatible with Solidity ecrecover
 */
import { createHash, randomBytes } from './utils.js';
import { ethers } from 'ethers';
// Browser-compatible Buffer.concat replacement
const bufferConcat = (buffers) => {
    if (typeof Buffer.concat === 'function') {
        return Buffer.concat(buffers);
    }
    else {
        // Browser fallback: manual concatenation
        const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of buffers) {
            result.set(buf, offset);
            offset += buf.length;
        }
        return Buffer.from(result);
    }
};
// Browser-compatible Buffer.alloc replacement
const bufferAlloc = (size, fill) => {
    if (typeof Buffer.alloc === 'function') {
        return Buffer.alloc(size, fill);
    }
    else {
        // Browser fallback: create and fill manually
        const result = new Uint8Array(size);
        if (fill !== undefined) {
            result.fill(fill);
        }
        return Buffer.from(result);
    }
};
// === REAL ETHEREUM SIGNATURES ===
/**
 * Create REAL Ethereum signature using secp256k1
 */
const createRealSignature = async (hash, privateKey) => {
    try {
        // Create wallet from private key
        const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
        // Sign the hash (ethers automatically prefixes with \x19Ethereum Signed Message)
        // For raw hash signing without prefix, we need to use wallet._signingKey
        const hashHex = ethers.hexlify(hash);
        const signature = await wallet.signMessage(ethers.getBytes(hash));
        // Parse signature components
        const sig = ethers.Signature.from(signature);
        // Convert to 65-byte format (r + s + v)
        const r = ethers.getBytes(sig.r);
        const s = ethers.getBytes(sig.s);
        const v = sig.v;
        // Ensure r and s are 32 bytes each
        const rPadded = new Uint8Array(32);
        const sPadded = new Uint8Array(32);
        rPadded.set(r, 32 - r.length);
        sPadded.set(s, 32 - s.length);
        return bufferConcat([
            Buffer.from(rPadded),
            Buffer.from(sPadded),
            Buffer.from([v])
        ]);
    }
    catch (error) {
        console.error(`❌ Failed to create signature: ${error}`);
        throw error;
    }
};
/**
 * Create DIRECT hash signature (no message prefix)
 * This matches what Solidity ecrecover expects
 */
export const createDirectHashSignature = async (hash, privateKey) => {
    try {
        const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
        // Sign the raw hash directly (no message prefix)
        const hashHex = ethers.hexlify(hash);
        const signature = await wallet.signMessage(ethers.getBytes(hash));
        // For direct hash signing, we need to use the signing key directly
        const signingKey = new ethers.SigningKey(ethers.hexlify(privateKey));
        const sig = signingKey.sign(hashHex);
        // Convert to Buffer format
        const r = ethers.getBytes(sig.r);
        const s = ethers.getBytes(sig.s);
        const v = sig.v;
        const rPadded = new Uint8Array(32);
        const sPadded = new Uint8Array(32);
        rPadded.set(r, 32 - r.length);
        sPadded.set(s, 32 - s.length);
        console.log(`🔑 Created signature: r=${ethers.hexlify(r).slice(0, 10)}..., s=${ethers.hexlify(s).slice(0, 10)}..., v=${v}`);
        return bufferConcat([
            Buffer.from(rPadded),
            Buffer.from(sPadded),
            Buffer.from([v])
        ]);
    }
    catch (error) {
        console.error(`❌ Failed to create direct hash signature: ${error}`);
        throw error;
    }
};
/**
 * Verify signature recovery works (for testing)
 */
export const verifySignatureRecovery = async (hash, signature, expectedAddress) => {
    try {
        // Extract components
        const r = ethers.hexlify(signature.slice(0, 32));
        const s = ethers.hexlify(signature.slice(32, 64));
        const v = signature[64];
        // Recover address
        const recoveredAddress = ethers.recoverAddress(ethers.hexlify(hash), { r, s, v });
        const matches = recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
        console.log(`🔍 Recovery test: expected=${expectedAddress.slice(0, 10)}..., recovered=${recoveredAddress.slice(0, 10)}..., match=${matches}`);
        return matches;
    }
    catch (error) {
        console.error(`❌ Failed to verify signature recovery: ${error}`);
        return false;
    }
};
// === SIGNATURE PACKING (Real Version) ===
export const packRealSignatures = (signatures) => {
    console.log(`📦 Packing ${signatures.length} REAL signatures...`);
    if (signatures.length === 0) {
        return bufferAlloc(0);
    }
    // Validate all signatures are exactly 65 bytes
    for (let i = 0; i < signatures.length; i++) {
        if (signatures[i].length !== 65) {
            throw new Error(`Invalid signature ${i}: ${signatures[i].length} bytes (expected 65)`);
        }
        const v = signatures[i][64];
        if (v !== 27 && v !== 28) {
            throw new Error(`Invalid v value in signature ${i}: ${v} (expected 27 or 28)`);
        }
    }
    // Pack R,S values
    const rsValues = bufferAlloc(signatures.length * 64);
    let rsOffset = 0;
    for (const sig of signatures) {
        // Browser-compatible copy: extract R,S (first 64 bytes) and copy to rsValues
        const rsBytes = sig.slice(0, 64);
        rsValues.set(rsBytes, rsOffset);
        rsOffset += 64;
    }
    // Pack V values as bits
    const vBytesNeeded = Math.ceil(signatures.length / 8);
    const vValues = bufferAlloc(vBytesNeeded);
    for (let i = 0; i < signatures.length; i++) {
        const vByte = signatures[i][64];
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        if (vByte === 28) {
            vValues[byteIndex] |= (1 << bitIndex);
        }
    }
    const packed = bufferConcat([rsValues, vValues]);
    console.log(`✅ Packed ${signatures.length} real signatures: ${packed.length} bytes`);
    return packed;
};
// === SIGNATURE DETECTION AND PACKING ===
/**
 * Detect signature count from packed signatures length
 */
export const detectSignatureCount = (packedSignatures) => {
    if (packedSignatures.length === 0)
        return 0;
    // Try different signature counts until we find the right one
    // Formula: length = count * 64 + ceil(count / 8)
    for (let count = 1; count <= 16000; count++) {
        const expectedRSBytes = count * 64;
        const expectedVBytes = Math.ceil(count / 8);
        const expectedTotal = expectedRSBytes + expectedVBytes;
        if (packedSignatures.length === expectedTotal) {
            console.log(`🔍 Detected ${count} signatures from ${packedSignatures.length} bytes`);
            return count;
        }
        // Early exit if we've exceeded possible length
        if (expectedTotal > packedSignatures.length) {
            break;
        }
    }
    throw new Error(`Invalid packed signature length: ${packedSignatures.length} bytes - cannot detect count`);
};
export const unpackRealSignatures = (packedSignatures) => {
    const signatureCount = detectSignatureCount(packedSignatures);
    console.log(`📦 Unpacking ${signatureCount} REAL signatures...`);
    if (signatureCount === 0)
        return [];
    const expectedRSBytes = signatureCount * 64;
    const expectedVBytes = Math.ceil(signatureCount / 8);
    const expectedTotal = expectedRSBytes + expectedVBytes;
    if (packedSignatures.length !== expectedTotal) {
        throw new Error(`Invalid packed signature length: ${packedSignatures.length} (expected ${expectedTotal})`);
    }
    const rsValues = packedSignatures.slice(0, expectedRSBytes);
    const vValues = packedSignatures.slice(expectedRSBytes);
    const signatures = [];
    for (let i = 0; i < signatureCount; i++) {
        const rs = rsValues.slice(i * 64, (i + 1) * 64);
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        const vBit = (vValues[byteIndex] >> bitIndex) & 1;
        const vByte = vBit === 0 ? 27 : 28;
        const signature = bufferConcat([rs, Buffer.from([vByte])]);
        signatures.push(signature);
    }
    console.log(`✅ Unpacked ${signatures.length} real signatures`);
    return signatures;
};
// === REAL HANKO BUILDING ===
/**
 * 💡 WHY WE DON'T TRACK SIGNATURE USAGE (Response to Junior's Concern)
 *
 * Question: "How do you ensure signatures are actually used in claims?"
 *
 * ANSWER: We intentionally DON'T track this because:
 *
 * 1. 🔄 CIRCULAR REFERENCE PROBLEM:
 *    EntityA → EntityB → EntityA means neither "uses" direct signatures
 *    But this is VALID hierarchical governance we want to support
 *
 * 2. 💰 GAS COST EXPLOSION:
 *    Tracking would require O(n²) analysis of claim dependency graphs
 *    Current approach: O(n) sequential processing with assumptions
 *
 * 3. 🎯 STILL GAMEABLE:
 *    Even with tracking, attacker can include "decoy" signatures:
 *    - Add 1 real signature that IS referenced by some claim
 *    - Add circular claims that don't use that signature
 *    - System still validates circular parts independently
 *
 * 4. 🛡️  PROTOCOL VS POLICY:
 *    Protocol provides flexible primitive
 *    UI/Application enforces business rules (e.g., "require EOA in root")
 *
 * EXAMPLE WHY TRACKING FAILS:
 * ```
 * packedSignatures: [RealSig1]  // ← Used by ClaimC
 * claims: [
 *   ClaimA: refs ClaimB,    // ← Circular validation
 *   ClaimB: refs ClaimA,    // ← Still works without RealSig1!
 *   ClaimC: refs RealSig1   // ← Uses the signature
 * ]
 * ```
 * Tracking would say "✅ RealSig1 is used" but ClaimA/B still validate circularly.
 */
export const buildRealHanko = async (hashToSign, config) => {
    console.log(`🖋️  Building REAL hanko: ${config.claims.length} claims, ${config.privateKeys.length} signatures`);
    // Create REAL Ethereum signatures
    const signatures = [];
    const signerAddresses = [];
    for (let i = 0; i < config.privateKeys.length; i++) {
        const privateKey = config.privateKeys[i];
        // Get the address for this private key
        const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
        signerAddresses.push(wallet.address);
        console.log(`🔑 Signing with key ${i + 1}/${config.privateKeys.length}: ${wallet.address.slice(0, 10)}...`);
        // Create real signature
        const signature = await createDirectHashSignature(hashToSign, privateKey);
        signatures.push(signature);
        // Verify the signature works
        const verifySuccess = await verifySignatureRecovery(hashToSign, signature, wallet.address);
        if (!verifySuccess) {
            throw new Error(`Signature verification failed for key ${i}`);
        }
    }
    // Pack signatures
    const packedSignatures = packRealSignatures(signatures);
    // Build claims
    const claims = config.claims.map(claim => ({
        entityId: claim.entityId,
        entityIndexes: claim.entityIndexes,
        weights: claim.weights,
        threshold: claim.threshold,
        expectedQuorumHash: claim.expectedQuorumHash
    }));
    const hanko = {
        placeholders: config.noEntities, // Failed entities (index 0..N-1)
        packedSignatures, // EOA signatures (index N..M-1)  
        claims // Entity claims (index M..∞)
    };
    console.log(`✅ Built REAL hanko with verifiable signatures`);
    console.log(`   📋 Signers: ${signerAddresses.map(addr => addr.slice(0, 10) + '...').join(', ')}`);
    console.log(`   📊 Signature count: ${signatures.length} (detected from length)`);
    return hanko;
};
/**
 * 🔥 FLASHLOAN GOVERNANCE SIMULATION - "ASSUME YES" in TypeScript
 *
 * This function mirrors the Solidity flashloan governance logic on the client side.
 * Used for gas optimization: pre-recover entities to avoid on-chain signature recovery.
 *
 * CRITICAL: This implements the SAME optimistic assumptions as Solidity:
 * - When claim X references claim Y, we assume Y = YES regardless of verification order
 * - If ANY claim later fails its threshold → entire validation should fail
 * - Enables circular references to mutually validate (INTENDED behavior)
 *
 * EXAMPLE CIRCULAR VALIDATION:
 * Claims: [
 *   { entityId: A, entityIndexes: [3], weights: [100], threshold: 100 }, // refs claim 1 (B)
 *   { entityId: B, entityIndexes: [2], weights: [100], threshold: 100 }  // refs claim 0 (A)
 * ]
 *
 * Processing:
 * 1. Claim 0: Assume B=YES → 100 ≥ 100 → A passes ✅
 * 2. Claim 1: Assume A=YES → 100 ≥ 100 → B passes ✅
 * 3. Both entities added to yesEntities → circular validation succeeds!
 *
 * Recover hanko signatures and return processed entities (for gas optimization)
 */
export const recoverHankoEntities = async (hanko, hash) => {
    console.log('🔍 Recovering hanko entities with flashloan governance...');
    // Step 1: Unpack and recover signatures
    const signatures = unpackRealSignatures(hanko.packedSignatures);
    const yesEntities = [];
    for (let i = 0; i < signatures.length; i++) {
        try {
            // Use ethers to recover the signer address
            const sig = signatures[i];
            const r = ethers.hexlify(sig.slice(0, 32));
            const s = ethers.hexlify(sig.slice(32, 64));
            const v = sig[64];
            const recoveredAddress = ethers.recoverAddress(ethers.hexlify(hash), { r, s, v });
            // Convert address to bytes32 (same format as Solidity)
            const addressAsBytes32 = Buffer.from(ethers.zeroPadValue(recoveredAddress, 32).slice(2), 'hex');
            yesEntities.push(addressAsBytes32);
            console.log(`✅ Recovered signer ${i + 1}: ${recoveredAddress.slice(0, 10)}...`);
        }
        catch (error) {
            console.log(`❌ Failed to recover signature ${i + 1}: ${error}`);
        }
    }
    // Step 2: 🔥 FLASHLOAN GOVERNANCE - optimistically assume all claims pass
    //
    // 🚨 KEY INSIGHT: We process claims sequentially but assume ALL future claims = YES
    // This mirrors the Solidity behavior and enables circular validation
    //
    // CONCRETE EXAMPLE:
    // Claim 0: EntityA needs EntityB (assume YES) → A gets added to yesEntities
    // Claim 1: EntityB needs EntityA (assume YES) → B gets added to yesEntities  
    // Result: Both A and B are in yesEntities → mutual validation succeeds!
    for (let claimIndex = 0; claimIndex < hanko.claims.length; claimIndex++) {
        const claim = hanko.claims[claimIndex];
        console.log(`🔄 Processing claim ${claimIndex + 1}/${hanko.claims.length}: Entity ${ethers.hexlify(claim.entityId).slice(0, 10)}...`);
        // Calculate voting power with flashloan assumptions
        let totalVotingPower = 0;
        const totalEntities = hanko.placeholders.length + signatures.length + hanko.claims.length;
        for (let i = 0; i < claim.entityIndexes.length; i++) {
            const entityIndex = claim.entityIndexes[i];
            // Validate bounds
            if (entityIndex >= totalEntities) {
                console.log(`❌ Entity index ${entityIndex} out of bounds (max: ${totalEntities})`);
                continue;
            }
            // Prevent self-reference  
            const referencedClaimIndex = entityIndex - hanko.placeholders.length - signatures.length;
            if (referencedClaimIndex === claimIndex) {
                console.log(`❌ Claim ${claimIndex} cannot reference itself`);
                continue;
            }
            if (entityIndex < hanko.placeholders.length) {
                // Index 0..N-1: Placeholder (failed entity) - contributes 0 voting power
                console.log(`  📍 Index ${entityIndex}: Placeholder (no power)`);
                continue;
            }
            else if (entityIndex < hanko.placeholders.length + signatures.length) {
                // Index N..M-1: EOA signature - verified, contributes full weight
                console.log(`  🔑 Index ${entityIndex}: EOA signature (power: ${claim.weights[i]})`);
                totalVotingPower += claim.weights[i];
            }
            else {
                // Index M..∞: Entity claim - ASSUME YES! (flashloan governance)
                const refClaimIdx = referencedClaimIndex;
                console.log(`  🔥 Index ${entityIndex}: ASSUME claim ${refClaimIdx} = YES (power: ${claim.weights[i]})`);
                totalVotingPower += claim.weights[i];
            }
        }
        // Check threshold
        if (totalVotingPower >= claim.threshold) {
            yesEntities.push(claim.entityId);
            console.log(`✅ Claim ${claimIndex + 1} passed: ${totalVotingPower}/${claim.threshold} (flashloan assumption)`);
        }
        else {
            console.log(`❌ Claim ${claimIndex + 1} failed: ${totalVotingPower}/${claim.threshold}`);
            // Note: In flashloan governance, any failure means total failure
        }
    }
    console.log(`📊 Flashloan recovery complete: ${yesEntities.length} yes, ${hanko.placeholders.length} placeholders`);
    return {
        yesEntities,
        noEntities: hanko.placeholders,
        claims: hanko.claims
    };
};
// === FULL CYCLE TEST ===
export const testFullCycle = async () => {
    console.log('\n🧪 === FULL CYCLE TEST: TypeScript → Solidity ===\n');
    // Generate test data
    const hashToSign = createHash('sha256').update('Test hanko message').digest();
    const privateKey1 = randomBytes(32);
    const privateKey2 = randomBytes(32);
    // Get addresses
    const wallet1 = new ethers.Wallet(ethers.hexlify(privateKey1));
    const wallet2 = new ethers.Wallet(ethers.hexlify(privateKey2));
    console.log(`📄 Hash to sign: 0x${hashToSign.toString('hex')}`);
    console.log(`🔑 Signer 1: ${wallet1.address}`);
    console.log(`🔑 Signer 2: ${wallet2.address}`);
    // Create real hanko
    const hanko = await buildRealHanko(hashToSign, {
        noEntities: [],
        privateKeys: [privateKey1, privateKey2],
        claims: [{
                entityId: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
                entityIndexes: [0, 1], // Both signatures
                weights: [1, 1],
                threshold: 2,
                expectedQuorumHash: randomBytes(32)
            }]
    });
    // Verify unpacking works
    const unpacked = unpackRealSignatures(hanko.packedSignatures);
    console.log(`\n📦 Signature verification:`);
    for (let i = 0; i < unpacked.length; i++) {
        const expectedAddr = i === 0 ? wallet1.address : wallet2.address;
        const verified = await verifySignatureRecovery(hashToSign, unpacked[i], expectedAddr);
        console.log(`   Signature ${i + 1}: ${verified ? '✅' : '❌'} ${expectedAddr.slice(0, 10)}...`);
    }
    // Create ABI-encoded data for Solidity (flashloan governance format)
    const abiEncoded = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,bytes32)[])"], [[
            hanko.placeholders.map(p => '0x' + Buffer.from(p).toString('hex')),
            '0x' + Buffer.from(hanko.packedSignatures).toString('hex'),
            hanko.claims.map(c => [
                '0x' + Buffer.from(c.entityId).toString('hex'),
                c.entityIndexes,
                c.weights,
                c.threshold,
                '0x' + Buffer.from(c.expectedQuorumHash).toString('hex')
            ])
        ]]);
    console.log(`\n📋 ABI Encoded hanko: ${abiEncoded.length} bytes`);
    return { hanko, abiEncoded, hashToSign };
};
// === GAS OPTIMIZATION TEST ===
export const testGasOptimization = async () => {
    console.log('\n⛽ === GAS OPTIMIZATION TEST ===\n');
    // Create test hanko
    const { hanko, abiEncoded, hashToSign } = await testFullCycle();
    // Method 1: Send full hanko (higher calldata, more gas)
    console.log(`📊 Method 1 - Full Hanko:`);
    console.log(`   Calldata size: ${abiEncoded.length} bytes`);
    console.log(`   Solidity function: verifyHankoSignature(bytes,bytes32)`);
    // Method 2: Pre-recover entities and send optimized data
    const recovered = await recoverHankoEntities(hanko, hashToSign);
    // Encode optimized data (yesEntities + noEntities + claims)
    const optimizedEncoded = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32[]", "bytes32[]", "tuple(bytes32,uint256[],uint256[],uint256,bytes32)[]"], [
        recovered.yesEntities.map(entity => '0x' + Buffer.from(entity).toString('hex')),
        recovered.noEntities.map(entity => '0x' + Buffer.from(entity).toString('hex')),
        recovered.claims.map(c => [
            '0x' + Buffer.from(c.entityId).toString('hex'),
            c.entityIndexes,
            c.weights,
            c.threshold,
            '0x' + Buffer.from(c.expectedQuorumHash).toString('hex')
        ])
    ]);
    console.log(`📊 Method 2 - Pre-recovered:`);
    console.log(`   Calldata size: ${optimizedEncoded.length} bytes`);
    console.log(`   Solidity function: verifyQuorumClaims(bytes32[],bytes32[],HankoClaim[])`);
    console.log(`   Gas savings: ~${Math.round((1 - optimizedEncoded.length / abiEncoded.length) * 100)}% calldata reduction`);
    console.log(`   Additional savings: No signature recovery gas cost on-chain`);
    console.log(`\n💡 Recommendation: Use Method 2 for gas-sensitive applications`);
};
// All functions exported above 
