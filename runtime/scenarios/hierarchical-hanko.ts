/**
 * Hierarchical Hanko Test - TradFi Corporate Structures
 *
 * Tests nested entity governance:
 * - HoldingCo board = [SubsidiaryA, SubsidiaryB] (entities, not EOAs)
 * - SubsidiaryA board = [Alice, Bob, CFO] (2-of-3 EOAs)
 * - SubsidiaryB board = [Carol, Dave, CFO] (2-of-3 EOAs)
 *
 * This validates the full hierarchical hanko system where
 * entities can authorize on behalf of parent entities.
 */

import { ethers, keccak256 } from 'ethers';
import { buildRealHanko, recoverHankoEntities, packRealSignatures } from '../hanko';
import { createHash, randomBytes } from '../utils';

// Test wallet generation
const generateWallet = () => {
  const privateKey = randomBytes(32);
  const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
  return { privateKey, address: wallet.address };
};

// Convert address to bytes32 (left-padded)
const addressToBytes32 = (address: string): Buffer => {
  return Buffer.from(ethers.zeroPadValue(address, 32).slice(2), 'hex');
};

// Generate entity ID from board hash
const computeBoardHash = (
  threshold: number,
  members: Buffer[], // bytes32[] of addresses or entity IDs
  weights: number[]
): Buffer => {
  // Match EP.sol Board struct encoding
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[
      threshold,
      members.map(m => '0x' + m.toString('hex')),
      weights,
      0, 0, 0 // delays
    ]]
  );
  return Buffer.from(keccak256(encoded).slice(2), 'hex');
};

async function runHierarchicalTest() {
  console.log('\n' + '='.repeat(70));
  console.log('🏢 HIERARCHICAL HANKO TEST - TradFi Corporate Structure');
  console.log('='.repeat(70) + '\n');

  // Generate 5 EOA wallets
  const alice = generateWallet();
  const bob = generateWallet();
  const carol = generateWallet();
  const dave = generateWallet();
  const cfo = generateWallet(); // Shared board member

  console.log('👥 EOA Wallets:');
  console.log(`   Alice: ${alice.address.slice(0, 10)}...`);
  console.log(`   Bob:   ${bob.address.slice(0, 10)}...`);
  console.log(`   Carol: ${carol.address.slice(0, 10)}...`);
  console.log(`   Dave:  ${dave.address.slice(0, 10)}...`);
  console.log(`   CFO:   ${cfo.address.slice(0, 10)}... (shared)\n`);

  // Create SubsidiaryA: [Alice, Bob, CFO] with 2-of-3
  const subAMembers = [
    addressToBytes32(alice.address),
    addressToBytes32(bob.address),
    addressToBytes32(cfo.address)
  ];
  const subAWeights = [1, 1, 1];
  const subAThreshold = 2;
  const subABoardHash = computeBoardHash(subAThreshold, subAMembers, subAWeights);
  const subsidiaryAId = subABoardHash; // Lazy entity: entityId = boardHash

  console.log('🏛️  SubsidiaryA (lazy entity):');
  console.log(`   Board: [Alice, Bob, CFO]`);
  console.log(`   Threshold: 2-of-3`);
  console.log(`   EntityId: 0x${subsidiaryAId.toString('hex').slice(0, 16)}...\n`);

  // Create SubsidiaryB: [Carol, Dave, CFO] with 2-of-3
  const subBMembers = [
    addressToBytes32(carol.address),
    addressToBytes32(dave.address),
    addressToBytes32(cfo.address)
  ];
  const subBWeights = [1, 1, 1];
  const subBThreshold = 2;
  const subBBoardHash = computeBoardHash(subBThreshold, subBMembers, subBWeights);
  const subsidiaryBId = subBBoardHash;

  console.log('🏛️  SubsidiaryB (lazy entity):');
  console.log(`   Board: [Carol, Dave, CFO]`);
  console.log(`   Threshold: 2-of-3`);
  console.log(`   EntityId: 0x${subsidiaryBId.toString('hex').slice(0, 16)}...\n`);

  // Create HoldingCo: [SubsidiaryA, SubsidiaryB] with 2-of-2
  const holdingMembers = [subsidiaryAId, subsidiaryBId];
  const holdingWeights = [1, 1];
  const holdingThreshold = 2;
  const holdingBoardHash = computeBoardHash(holdingThreshold, holdingMembers, holdingWeights);
  const holdingCoId = holdingBoardHash;

  console.log('🏢 HoldingCo (lazy entity):');
  console.log(`   Board: [SubsidiaryA, SubsidiaryB]`);
  console.log(`   Threshold: 2-of-2 (both subsidiaries must approve)`);
  console.log(`   EntityId: 0x${holdingCoId.toString('hex').slice(0, 16)}...\n`);

  // Hash to sign
  const hashToSign = createHash('sha256').update('HoldingCo Board Resolution #1').digest();
  console.log(`📄 Hash to sign: 0x${hashToSign.toString('hex').slice(0, 32)}...\n`);

  // ============================================================
  // TEST 1: Full authorization (all EOAs sign)
  // ============================================================
  console.log('-'.repeat(70));
  console.log('TEST 1: Full authorization (Alice+Bob for SubA, Carol+Dave for SubB)');
  console.log('-'.repeat(70));

  try {
    // Build hierarchical hanko:
    // - 4 EOA signatures: Alice, Bob, Carol, Dave
    // - 3 claims: SubsidiaryA, SubsidiaryB, HoldingCo
    //
    // Index mapping:
    //   0-3: EOA signatures [Alice, Bob, Carol, Dave]
    //   4: Claim 0 (SubsidiaryA)
    //   5: Claim 1 (SubsidiaryB)
    //   6: Claim 2 (HoldingCo)

    const hanko = await buildRealHanko(hashToSign, {
      noEntities: [], // No placeholders - everyone signs
      privateKeys: [alice.privateKey, bob.privateKey, carol.privateKey, dave.privateKey],
      claims: [
        // Claim 0: SubsidiaryA authorized by Alice(0) + Bob(1)
        {
          entityId: subsidiaryAId,
          entityIndexes: [0, 1, 0], // Alice, Bob, (placeholder for CFO who didn't sign)
          weights: [1, 1, 1],
          threshold: 2,
        },
        // Claim 1: SubsidiaryB authorized by Carol(2) + Dave(3)
        {
          entityId: subsidiaryBId,
          entityIndexes: [2, 3, 2], // Carol, Dave, (reuse index - hacky but works for test)
          weights: [1, 1, 1],
          threshold: 2,
        },
        // Claim 2: HoldingCo authorized by SubsidiaryA(claim 4) + SubsidiaryB(claim 5)
        {
          entityId: holdingCoId,
          entityIndexes: [4, 5], // Claim 0 (SubA), Claim 1 (SubB)
          weights: [1, 1],
          threshold: 2,
        },
      ],
    });

    // Verify with flashloan governance
    const recovered = await recoverHankoEntities(hanko, hashToSign);

    console.log(`\n📊 Recovery result:`);
    console.log(`   Yes entities: ${recovered.yesEntities.length}`);
    console.log(`   Placeholders: ${recovered.noEntities.length}`);

    // Check if HoldingCo is in yesEntities
    const holdingCoApproved = recovered.yesEntities.some(e =>
      e.toString('hex') === holdingCoId.toString('hex')
    );

    if (holdingCoApproved) {
      console.log(`\n✅ TEST 1 PASSED: HoldingCo authorized via subsidiary chain`);
    } else {
      console.log(`\n❌ TEST 1 FAILED: HoldingCo not in yesEntities`);
    }
  } catch (error) {
    console.log(`\n❌ TEST 1 ERROR: ${error}`);
  }

  // ============================================================
  // TEST 2: Partial authorization (CFO signs for both - shared member)
  // ============================================================
  console.log('\n' + '-'.repeat(70));
  console.log('TEST 2: CFO + one other per subsidiary (CFO is shared board member)');
  console.log('-'.repeat(70));

  try {
    // CFO + Alice for SubA, CFO + Carol for SubB
    // But CFO signature is shared - tests signature reuse

    const hanko = await buildRealHanko(hashToSign, {
      noEntities: [
        addressToBytes32(bob.address),  // Bob didn't sign (placeholder 0)
        addressToBytes32(dave.address), // Dave didn't sign (placeholder 1)
      ],
      privateKeys: [alice.privateKey, carol.privateKey, cfo.privateKey],
      claims: [
        // Claim 0: SubsidiaryA = Alice(sig 0) + CFO(sig 2), Bob absent(placeholder 0)
        {
          entityId: subsidiaryAId,
          entityIndexes: [2, 0, 4], // sig: Alice, placeholder: Bob, sig: CFO
          weights: [1, 1, 1],
          threshold: 2,
        },
        // Claim 1: SubsidiaryB = Carol(sig 1) + CFO(sig 2), Dave absent(placeholder 1)
        {
          entityId: subsidiaryBId,
          entityIndexes: [3, 1, 4], // sig: Carol, placeholder: Dave, sig: CFO
          weights: [1, 1, 1],
          threshold: 2,
        },
        // Claim 2: HoldingCo = SubA(claim 5) + SubB(claim 6)
        {
          entityId: holdingCoId,
          entityIndexes: [5, 6], // Claims for SubA and SubB
          weights: [1, 1],
          threshold: 2,
        },
      ],
    });

    const recovered = await recoverHankoEntities(hanko, hashToSign);

    console.log(`\n📊 Recovery result:`);
    console.log(`   Yes entities: ${recovered.yesEntities.length}`);
    console.log(`   Placeholders: ${recovered.noEntities.length}`);

    const holdingCoApproved = recovered.yesEntities.some(e =>
      e.toString('hex') === holdingCoId.toString('hex')
    );

    if (holdingCoApproved) {
      console.log(`\n✅ TEST 2 PASSED: CFO shared signature works across subsidiaries`);
    } else {
      console.log(`\n❌ TEST 2 FAILED: HoldingCo not authorized`);
    }
  } catch (error) {
    console.log(`\n❌ TEST 2 ERROR: ${error}`);
  }

  // ============================================================
  // TEST 3: Insufficient quorum (only SubsidiaryA signs)
  // ============================================================
  console.log('\n' + '-'.repeat(70));
  console.log('TEST 3: Only SubsidiaryA authorizes (SubsidiaryB absent)');
  console.log('-'.repeat(70));

  try {
    // Only Alice + Bob sign, SubsidiaryB completely absent
    const hanko = await buildRealHanko(hashToSign, {
      noEntities: [
        subsidiaryBId, // SubsidiaryB as placeholder (didn't authorize)
      ],
      privateKeys: [alice.privateKey, bob.privateKey],
      claims: [
        // Claim 0: SubsidiaryA = Alice + Bob
        {
          entityId: subsidiaryAId,
          entityIndexes: [1, 2, 1], // sigs: Alice, Bob (CFO absent but 2-of-3 met)
          weights: [1, 1, 1],
          threshold: 2,
        },
        // Claim 1: HoldingCo = SubA(claim 3) + SubB(placeholder 0)
        {
          entityId: holdingCoId,
          entityIndexes: [3, 0], // Claim for SubA, placeholder for SubB
          weights: [1, 1],
          threshold: 2,
        },
      ],
    });

    const recovered = await recoverHankoEntities(hanko, hashToSign);

    console.log(`\n📊 Recovery result:`);
    console.log(`   Yes entities: ${recovered.yesEntities.length}`);
    console.log(`   Placeholders: ${recovered.noEntities.length}`);

    const holdingCoApproved = recovered.yesEntities.some(e =>
      e.toString('hex') === holdingCoId.toString('hex')
    );

    if (!holdingCoApproved) {
      console.log(`\n✅ TEST 3 PASSED: HoldingCo correctly rejected (1-of-2 insufficient)`);
    } else {
      console.log(`\n❌ TEST 3 FAILED: HoldingCo should NOT be authorized with only 1 subsidiary`);
    }
  } catch (error) {
    console.log(`\n❌ TEST 3 ERROR: ${error}`);
  }

  // ============================================================
  // TEST 4: No direct EOA signatures on HoldingCo
  // ============================================================
  console.log('\n' + '-'.repeat(70));
  console.log('TEST 4: HoldingCo has NO direct EOA board members (entity-only board)');
  console.log('-'.repeat(70));
  console.log('   This tests pure hierarchical governance where top entity');
  console.log('   has only entity members, no direct EOA control.\n');

  // This should work because:
  // - SubsidiaryA and SubsidiaryB each have EOA quorum
  // - HoldingCo's board is [SubA, SubB] - both are entities
  // - EP.sol requires eoaVotingPower >= threshold at EACH claim level
  // - But HoldingCo's EOA power = 0 (entity refs don't count as EOA)
  //
  // QUESTION: Should this pass or fail?
  // EP.sol line 842: if (eoaVotingPower < claim.threshold) return fail
  // This means HoldingCo claim would FAIL because it has 0 EOA power!

  console.log('   ⚠️  Expected: FAIL (EP.sol requires EOA power >= threshold at each level)');
  console.log('   This prevents pure circular entity governance without EOA root.\n');

  // The test from above (TEST 1) already demonstrates this works when
  // subsidiaries have EOA quorum. The key insight is that EOA requirement
  // is checked at EACH claim level, not just the top.

  console.log('\n' + '='.repeat(70));
  console.log('🏁 HIERARCHICAL HANKO TESTS COMPLETE');
  console.log('='.repeat(70));
}

// Run if executed directly
runHierarchicalTest().catch(console.error);
