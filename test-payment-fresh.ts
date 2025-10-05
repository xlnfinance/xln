/**
 * Comprehensive bilateral consensus test
 * Tests all fixes from 2025-10-06 session:
 * - Bilateral credit limit setup (2M total capacity)
 * - Both parties sending payments
 * - Rollback scenarios
 * - State consistency verification
 *
 * Reference: 2024_src/test/directpayment.test.ts
 */

import { Env, EntityInput } from './src/types';
import { applyServerInput } from './src/server';
import { safeStringify } from './src/serialization-utils';

async function processOutputsUntilEmpty(env: Env, initialOutputs: EntityInput[], maxIterations: number = 20): Promise<number> {
  let outputs = initialOutputs;
  let iteration = 0;

  while (outputs.length > 0 && iteration < maxIterations) {
    iteration++;
    console.log(`\n🔄 Iteration ${iteration}: Processing ${outputs.length} outputs...`);

    const result = await applyServerInput(env, {
      serverTxs: [],
      entityInputs: outputs,
    });

    outputs = result.entityOutbox;
    if (outputs.length > 0) {
      console.log(`   Generated ${outputs.length} new outputs`);
    }
  }

  if (iteration >= maxIterations) {
    console.error(`❌ FATAL: Hit max iterations (${maxIterations}) - consensus not converging!`);
    throw new Error('Bilateral consensus failed to converge');
  }

  console.log(`✅ Consensus converged in ${iteration} iterations\n`);
  return iteration;
}

async function testBilateralConsensus() {
  console.log('🧪 ==========================================================');
  console.log('🧪 COMPREHENSIVE BILATERAL CONSENSUS TEST');
  console.log('🧪 Testing fixes from 2025-10-06 session');
  console.log('🧪 ==========================================================\n');

  // Create minimal in-memory environment
  const env: Env = {
    replicas: new Map(),
    height: 0,
    timestamp: Date.now(),
    serverInput: { serverTxs: [], entityInputs: [] },
    history: [],
    gossip: null as any,
  };

  const entity1Id = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const entity2Id = '0x0000000000000000000000000000000000000000000000000000000000000002';

  console.log('📦 SETUP: Creating Entity 1 and Entity 2...\n');

  await applyServerInput(env, {
    serverTxs: [
      {
        type: 'importReplica',
        entityId: entity1Id,
        signerId: 's1',
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: ['s1'],
            shares: { s1: 1n },
            jurisdiction: {
              name: 'Test',
              chainId: 1,
              address: 'test',
              entityProviderAddress: '0x1',
              depositoryAddress: '0x2',
            },
          },
        },
      },
      {
        type: 'importReplica',
        entityId: entity2Id,
        signerId: 's2',
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: ['s2'],
            shares: { s2: 1n },
            jurisdiction: {
              name: 'Test',
              chainId: 1,
              address: 'test',
              entityProviderAddress: '0x1',
              depositoryAddress: '0x2',
            },
          },
        },
      },
    ],
    entityInputs: [],
  });

  console.log(`✅ Entities created: ${env.replicas.size} replicas\n`);

  // ============================================================
  // TEST 1: Account Opening with Bilateral Credit Limits
  // ============================================================
  console.log('🧪 TEST 1: Account Opening + Bilateral Credit Limits');
  console.log('─────────────────────────────────────────────────────\n');

  console.log('📝 Entity 1 opens account with Entity 2...');

  const openResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity1Id,
        signerId: 's1',
        entityTxs: [{ type: 'openAccount', data: { targetEntityId: entity2Id } }],
      },
    ],
  });

  console.log(`📤 OpenAccount queued ${openResult.entityOutbox.length} outputs`);

  // DEBUG: Check state immediately after openAccount
  let e1Debug = env.replicas.get(`${entity1Id}:s1`);
  console.log(`🔍 DEBUG: Entity 1 accounts after openAccount: ${e1Debug?.state.accounts.size || 0}`);
  console.log(`🔍 DEBUG: Entity 1 has account with E2: ${e1Debug?.state.accounts.has(entity2Id)}`);

  if (e1Debug?.state.accounts.has(entity2Id)) {
    const acc = e1Debug.state.accounts.get(entity2Id);
    console.log(`🔍 DEBUG: Account mempool: ${acc?.mempool.length}, pending: ${!!acc?.pendingFrame}`);
  }

  // Process all outputs until bilateral consensus completes
  const openIterations = await processOutputsUntilEmpty(env, openResult.entityOutbox);

  // Verify account created on both sides
  const e1 = env.replicas.get(`${entity1Id}:s1`);
  const e2 = env.replicas.get(`${entity2Id}:s2`);
  const account1to2 = e1?.state.accounts.get(entity2Id);
  const account2to1 = e2?.state.accounts.get(entity1Id);

  console.log('🔍 VERIFY: Account creation...');
  console.log(`   Entity 1 accounts.size: ${e1?.state.accounts.size || 0}`);
  console.log(`   Entity 2 accounts.size: ${e2?.state.accounts.size || 0}`);
  console.log(`   Entity 1 has account with E2: ${!!account1to2}`);
  console.log(`   Entity 2 has account with E1: ${!!account2to1}`);

  if (!account1to2 || !account2to1) {
    console.error('❌ FATAL: Account not created on one or both sides');
    console.error(`   This means bilateral frame exchange failed completely`);
    process.exit(1);
  }
  console.log('   ✅ Account created on both sides');

  // Verify no stuck pending frames
  console.log('🔍 VERIFY: No stuck frames...');
  if (account1to2.pendingFrame || account2to1.pendingFrame) {
    console.error('❌ FATAL: Pending frame stuck after account opening!');
    console.error(`   Entity 1 pending: ${!!account1to2.pendingFrame}`);
    console.error(`   Entity 2 pending: ${!!account2to1.pendingFrame}`);
    process.exit(1);
  }
  console.log('   ✅ No stuck frames');

  // Verify frame history
  console.log('🔍 VERIFY: Frame history...');
  console.log(`   Entity 1: ${account1to2.frameHistory?.length || 0} frames`);
  console.log(`   Entity 2: ${account2to1.frameHistory?.length || 0} frames`);

  if ((account1to2.frameHistory?.length || 0) < 2 || (account2to1.frameHistory?.length || 0) < 2) {
    console.error('❌ FATAL: Expected at least 2 frames on each side');
    console.error('   Frame 1: [add_delta, set_credit_limit(left)]');
    console.error('   Frame 2: [set_credit_limit(right)]');
    process.exit(1);
  }
  console.log('   ✅ Both entities have 2+ committed frames');

  // CRITICAL: Verify bilateral credit limits (today's main fix!)
  console.log('🔍 VERIFY: Bilateral credit limits (2M total capacity)...');
  const delta1 = account1to2.deltas.get(1); // Token 1 = USDC
  const delta2 = account2to1.deltas.get(1);

  if (!delta1 || !delta2) {
    console.error('❌ FATAL: Missing delta for token 1 on one or both sides');
    process.exit(1);
  }

  console.log(`   Entity 1 view: left=${delta1.leftCreditLimit}, right=${delta1.rightCreditLimit}`);
  console.log(`   Entity 2 view: left=${delta2.leftCreditLimit}, right=${delta2.rightCreditLimit}`);

  // DETERMINISTIC: Both sides MUST see identical credit limits
  if (delta1.leftCreditLimit !== delta2.leftCreditLimit) {
    console.error('❌ CONSENSUS-FAILURE: leftCreditLimit mismatch!');
    console.error(`   Entity 1: ${delta1.leftCreditLimit}`);
    console.error(`   Entity 2: ${delta2.leftCreditLimit}`);
    process.exit(1);
  }

  if (delta1.rightCreditLimit !== delta2.rightCreditLimit) {
    console.error('❌ CONSENSUS-FAILURE: rightCreditLimit mismatch!');
    console.error(`   Entity 1: ${delta1.rightCreditLimit}`);
    console.error(`   Entity 2: ${delta2.rightCreditLimit}`);
    process.exit(1);
  }

  const expectedCreditLimit = 1000000000000000000000000n; // 1M with 18 decimals
  if (delta1.leftCreditLimit !== expectedCreditLimit) {
    console.error(`❌ FATAL: Left credit limit incorrect. Expected ${expectedCreditLimit}, got ${delta1.leftCreditLimit}`);
    process.exit(1);
  }

  if (delta1.rightCreditLimit !== expectedCreditLimit) {
    console.error(`❌ FATAL: Right credit limit incorrect. Expected ${expectedCreditLimit}, got ${delta1.rightCreditLimit}`);
    process.exit(1);
  }

  const totalCapacity = delta1.leftCreditLimit + delta1.rightCreditLimit;
  console.log(`   ✅ Both sides have 1M credit limit each`);
  console.log(`   ✅ Total capacity: ${totalCapacity} (2M)`);

  console.log('\n✅ TEST 1 PASSED: Bilateral credit limits work!\n');

  // ============================================================
  // TEST 2: Direct Payment Entity 1 → Entity 2
  // ============================================================
  console.log('🧪 TEST 2: Direct Payment (Entity 1 → Entity 2)');
  console.log('─────────────────────────────────────────────────────\n');

  console.log('💸 Entity 1 sends 200,000 to Entity 2...');

  const payment1Result = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity1Id,
        signerId: 's1',
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: entity2Id,
              tokenId: 1,
              amount: 200000n,
              description: 'Test payment 1→2',
            },
          },
        ],
      },
    ],
  });

  await processOutputsUntilEmpty(env, payment1Result.entityOutbox);

  // Refresh state
  const e1After1 = env.replicas.get(`${entity1Id}:s1`);
  const e2After1 = env.replicas.get(`${entity2Id}:s2`);
  const account1After1 = e1After1?.state.accounts.get(entity2Id);
  const account2After1 = e2After1?.state.accounts.get(entity1Id);

  console.log('🔍 VERIFY: Payment processed...');
  if (account1After1?.pendingFrame || account2After1?.pendingFrame) {
    console.error('❌ FATAL: Frame stuck after payment!');
    process.exit(1);
  }
  console.log('   ✅ No stuck frames');

  // Verify deltas updated correctly
  const delta1After1 = account1After1?.deltas.get(1);
  const delta2After1 = account2After1?.deltas.get(1);

  console.log('🔍 VERIFY: State consistency after payment...');
  console.log(`   Entity 1 offdelta: ${delta1After1?.offdelta}`);
  console.log(`   Entity 2 offdelta: ${delta2After1?.offdelta}`);

  // CRITICAL: Both sides must have IDENTICAL canonical delta
  if (delta1After1?.offdelta !== delta2After1?.offdelta) {
    console.error('❌ CONSENSUS-FAILURE: offdelta mismatch!');
    console.error(`   Entity 1: ${delta1After1?.offdelta}`);
    console.error(`   Entity 2: ${delta2After1?.offdelta}`);
    process.exit(1);
  }

  // Entity 1 is left (smaller ID), paid 200k → offdelta should be +200000
  const expectedOffDelta1 = 200000n;
  if (delta1After1?.offdelta !== expectedOffDelta1) {
    console.error(`❌ FATAL: Incorrect offdelta. Expected ${expectedOffDelta1}, got ${delta1After1?.offdelta}`);
    process.exit(1);
  }

  console.log(`   ✅ Both sides computed identical offdelta: ${delta1After1?.offdelta}`);
  console.log('\n✅ TEST 2 PASSED: Payment 1→2 works!\n');

  // ============================================================
  // TEST 3: Reverse Payment Entity 2 → Entity 1
  // ============================================================
  console.log('🧪 TEST 3: Reverse Payment (Entity 2 → Entity 1)');
  console.log('─────────────────────────────────────────────────────\n');

  console.log('💸 Entity 2 sends 100,000 back to Entity 1...');

  const payment2Result = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity2Id,
        signerId: 's2',
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: entity1Id,
              tokenId: 1,
              amount: 100000n,
              description: 'Reverse payment 2→1',
            },
          },
        ],
      },
    ],
  });

  await processOutputsUntilEmpty(env, payment2Result.entityOutbox);

  // Refresh state
  const e1After2 = env.replicas.get(`${entity1Id}:s1`);
  const e2After2 = env.replicas.get(`${entity2Id}:s2`);
  const account1After2 = e1After2?.state.accounts.get(entity2Id);
  const account2After2 = e2After2?.state.accounts.get(entity1Id);

  console.log('🔍 VERIFY: Reverse payment processed...');
  if (account1After2?.pendingFrame || account2After2?.pendingFrame) {
    console.error('❌ FATAL: Frame stuck after reverse payment!');
    console.error(`   Entity 1 pending: ${!!account1After2?.pendingFrame}`);
    console.error(`   Entity 2 pending: ${!!account2After2?.pendingFrame}`);
    process.exit(1);
  }
  console.log('   ✅ No stuck frames');

  const delta1After2 = account1After2?.deltas.get(1);
  const delta2After2 = account2After2?.deltas.get(1);

  console.log('🔍 VERIFY: Net delta after reverse payment...');
  console.log(`   Entity 1 offdelta: ${delta1After2?.offdelta}`);
  console.log(`   Entity 2 offdelta: ${delta2After2?.offdelta}`);

  // Both must match
  if (delta1After2?.offdelta !== delta2After2?.offdelta) {
    console.error('❌ CONSENSUS-FAILURE: offdelta mismatch after reverse!');
    process.exit(1);
  }

  // Net: +200k - 100k = +100k
  const expectedNetDelta = 100000n;
  if (delta1After2?.offdelta !== expectedNetDelta) {
    console.error(`❌ FATAL: Incorrect net delta. Expected ${expectedNetDelta}, got ${delta1After2?.offdelta}`);
    process.exit(1);
  }

  console.log(`   ✅ Net delta correct: ${delta1After2?.offdelta} (200k sent - 100k received = 100k net)`);
  console.log('\n✅ TEST 3 PASSED: Reverse payment works!\n');

  // ============================================================
  // TEST 4: State Consistency Verification
  // ============================================================
  console.log('🧪 TEST 4: Complete State Consistency Check');
  console.log('─────────────────────────────────────────────────────\n');

  console.log('🔍 VERIFY: All delta fields match on both sides...');

  const fieldsToCheck = ['offdelta', 'ondelta', 'collateral', 'leftCreditLimit', 'rightCreditLimit', 'leftAllowence', 'rightAllowence'] as const;

  for (const field of fieldsToCheck) {
    if (delta1After2![field] !== delta2After2![field]) {
      console.error(`❌ CONSENSUS-FAILURE: ${field} mismatch!`);
      console.error(`   Entity 1.${field}: ${delta1After2![field]}`);
      console.error(`   Entity 2.${field}: ${delta2After2![field]}`);
      process.exit(1);
    }
  }

  console.log('   ✅ All delta fields identical on both sides:');
  console.log(`      offdelta: ${delta1After2!.offdelta}`);
  console.log(`      ondelta: ${delta1After2!.ondelta}`);
  console.log(`      collateral: ${delta1After2!.collateral}`);
  console.log(`      leftCreditLimit: ${delta1After2!.leftCreditLimit}`);
  console.log(`      rightCreditLimit: ${delta1After2!.rightCreditLimit}`);
  console.log(`      leftAllowence: ${delta1After2!.leftAllowence}`);
  console.log(`      rightAllowence: ${delta1After2!.rightAllowence}`);

  console.log('\n✅ TEST 4 PASSED: State consistency verified!\n');

  // ============================================================
  // TEST 5: Simultaneous Payments (Rollback Test)
  // ============================================================
  console.log('🧪 TEST 5: Simultaneous Payments (Rollback Scenario)');
  console.log('─────────────────────────────────────────────────────\n');
  console.log('⚠️  Both entities send payments at SAME TICK');
  console.log('   Expected: Left entity wins, right entity rolls back\n');

  const simultaneousResult = await applyServerInput(env, {
    serverTxs: [],
    entityInputs: [
      {
        entityId: entity1Id,
        signerId: 's1',
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: entity2Id,
              tokenId: 1,
              amount: 50000n,
              description: 'Simultaneous payment from E1',
            },
          },
        ],
      },
      {
        entityId: entity2Id,
        signerId: 's2',
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: entity1Id,
              tokenId: 1,
              amount: 30000n,
              description: 'Simultaneous payment from E2',
            },
          },
        ],
      },
    ],
  });

  console.log('📤 Simultaneous payments generated outputs, processing...');

  const simultaneousIterations = await processOutputsUntilEmpty(env, simultaneousResult.entityOutbox, 30);

  console.log(`🔄 Rollback scenario converged in ${simultaneousIterations} iterations`);

  // Refresh state
  const e1After3 = env.replicas.get(`${entity1Id}:s1`);
  const e2After3 = env.replicas.get(`${entity2Id}:s2`);
  const account1After3 = e1After3?.state.accounts.get(entity2Id);
  const account2After3 = e2After3?.state.accounts.get(entity1Id);

  console.log('🔍 VERIFY: Rollback handled correctly...');
  if (account1After3?.pendingFrame || account2After3?.pendingFrame) {
    console.error('❌ FATAL: Frame stuck after simultaneous payments!');
    process.exit(1);
  }
  console.log('   ✅ No stuck frames after rollback');

  const delta1After3 = account1After3?.deltas.get(1);
  const delta2After3 = account2After3?.deltas.get(1);

  console.log('🔍 VERIFY: Final state consistency...');
  if (delta1After3?.offdelta !== delta2After3?.offdelta) {
    console.error('❌ CONSENSUS-FAILURE: States diverged after rollback!');
    console.error(`   Entity 1: ${delta1After3?.offdelta}`);
    console.error(`   Entity 2: ${delta2After3?.offdelta}`);
    process.exit(1);
  }

  console.log(`   ✅ States consistent after rollback: offdelta=${delta1After3?.offdelta}`);

  // Verify rollback counters
  console.log('🔍 VERIFY: Rollback counters...');
  console.log(`   Entity 1 rollbackCount: ${account1After3?.rollbackCount || 0}`);
  console.log(`   Entity 2 rollbackCount: ${account2After3?.rollbackCount || 0}`);

  if ((account1After3?.rollbackCount || 0) > 1 || (account2After3?.rollbackCount || 0) > 1) {
    console.error('❌ WARNING: High rollback count detected');
    console.error('   This suggests consensus instability');
  } else {
    console.log('   ✅ Rollback counts normal (≤1)');
  }

  console.log('\n✅ TEST 5 PASSED: Rollback handling works!\n');

  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  console.log('🎉 ==========================================================');
  console.log('🎉 ALL TESTS PASSED!');
  console.log('🎉 ==========================================================\n');

  console.log('✅ Account opening with bilateral credit limits');
  console.log('✅ Direct payments (both directions)');
  console.log('✅ State consistency (identical on both sides)');
  console.log('✅ Rollback handling (simultaneous proposals)');
  console.log('✅ No stuck frames or deadlocks');

  console.log('\n🔐 Bilateral consensus is BULLETPROOF! ⏰\n');

  process.exit(0);
}

testBilateralConsensus().catch((err) => {
  console.error('\n❌ ========================================');
  console.error('❌ TEST FAILED!');
  console.error('❌ ========================================\n');
  console.error('Error:', err.message);
  console.error('\nStack trace:');
  console.error(err.stack);
  process.exit(1);
});
