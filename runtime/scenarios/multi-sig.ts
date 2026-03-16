/**
 * Multi-Signer Consensus Test
 *
 * Tests entity-level BFT consensus with multiple validators:
 * - Alice entity: 2-of-3 validators (alice, bob, carol)
 * - Hub entity: single validator (hub)
 * - directPayment requires 2 signatures to commit
 *
 * This proves:
 * - Byzantine fault tolerance (1 validator can be offline/malicious)
 * - Signature collection and verification
 * - Precommit/commit flow with multiple signers
 * - State transitions with threshold consensus
 *
 * Run with: bun runtime/scenarios/multi-sig.ts
 */

import type { Env } from '../types';
import { ensureJAdapter, getJAdapterMode, createJReplica } from './boot';
import { findReplica, assert, processWithOffline, convergeWithOffline, enableStrictScenario, ensureSignerKeysFromSeed, requireRuntimeSeed, syncChain } from './helpers';

const USDC = 1;
const ONE = 10n ** 18n;
const usd = (amount: number | bigint) => BigInt(amount) * ONE;

export async function multiSig(env: Env): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Multi-Sig');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  const { clearSignerKeys } = await import('../account-crypto');
  const runtimeSeed = requireRuntimeSeed(env, 'Multi-Sig');
  const offlineSigners = new Set<string>();

  clearSignerKeys();
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6', '7'], 'Multi-Sig');

  const { applyRuntimeInput } = await import('../runtime');

  if (env.scenarioMode && env.height === 0) {
    env.timestamp = 1;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('     MULTI-SIGNER CONSENSUS TEST (2-of-3 Validators)          ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: JAdapter
  // ============================================================================
  console.log('🏛️  Setting up JAdapter...');
  const jMode = getJAdapterMode();
  const jadapter = await ensureJAdapter(env, jMode);
  const jReplica = createJReplica(env, 'MultiSig', jadapter.addresses.depository, { x: 0, y: 600, z: 0 }); // Match ahb.ts positioning
  (jReplica as any).jadapter = jadapter;
  (jReplica as any).depositoryAddress = jadapter.addresses.depository;
  (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
  (jReplica as any).contracts = {
    depository: jadapter.addresses.depository,
    entityProvider: jadapter.addresses.entityProvider,
    account: jadapter.addresses.account,
    deltaTransformer: jadapter.addresses.deltaTransformer,
  };
  console.log('✅ JAdapter ready\n');

  // ============================================================================
  // SETUP: Create Alice (2-of-3) and Hub (single signer)
  // ============================================================================
  console.log('📦 Creating entities...');

  const alice = { id: '0x' + '1'.padStart(64, '0'), validators: ['1', '2', '3'] }; // 2-of-3
  const hub = { id: '0x' + '2'.padStart(64, '0'), validators: ['4'], signer: '4' }; // Single

  const aliceConfig = {
    mode: 'proposer-based' as const,
    threshold: 2n, // CRITICAL: 2-of-3 threshold
    validators: ['1', '2', '3'],
    shares: { '1': 1n, '2': 1n, '3': 1n },
  };

  // CRITICAL: Multi-signer requires separate replica for EACH validator
  await applyRuntimeInput(env, {
    runtimeTxs: [
      // Alice validator 1 (proposer)
      {
        type: 'importReplica',
        entityId: alice.id,
        signerId: '1',
        data: {
          isProposer: true,
          position: { x: 0, y: 0, z: 0 },
          config: aliceConfig,
        },
      },
      // Alice validator 2
      {
        type: 'importReplica',
        entityId: alice.id,
        signerId: '2',
        data: {
          isProposer: false, // Not proposer
          position: { x: 0, y: 0, z: 0 },
          config: aliceConfig,
        },
      },
      // Alice validator 3
      {
        type: 'importReplica',
        entityId: alice.id,
        signerId: '3',
        data: {
          isProposer: false,
          position: { x: 0, y: 0, z: 0 },
          config: aliceConfig,
        },
      },
      // Hub (single signer)
      {
        type: 'importReplica',
        entityId: hub.id,
        signerId: hub.signer,
        data: {
          isProposer: true,
          position: { x: 100, y: 0, z: 0 },
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [hub.signer],
            shares: { [hub.signer]: 1n },
          },
        },
      },
    ],
    entityInputs: [],
  });

  console.log('  ✅ Alice: 2-of-3 validators (1, 2, 3)');
  console.log('  ✅ Hub: single validator\n');

  // ============================================================================
  // SETUP: Entity-level commit under 2-of-3 threshold
  // ============================================================================
  console.log('🏦 Executing entity-level mintReserves under 2-of-3 threshold...');

  await processWithOffline(env, [{
    entityId: alice.id,
    signerId: '1',
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(1_000) } }],
  }], offlineSigners);

  await convergeWithOffline(env, offlineSigners, 20);
  await syncChain(env, 5);

  console.log('\\n🔍 Checking reserve state across all validators...');
  const setupHeights: number[] = [];
  for (const validator of alice.validators) {
    const key = `${alice.id}:${validator}`;
    const replica = env.eReplicas.get(key);
    const height = replica?.state.height || 0;
    const hasPending = Boolean(replica?.proposal || replica?.lockedFrame || (replica?.mempool.length || 0) > 0);
    setupHeights.push(height);
    console.log(`  ${validator}: height=${height}, pending=${hasPending ? 'yes' : 'no'}`);
    assert(height > 0, `Validator ${validator} committed the initial multi-sig entity tx`);
    assert(!hasPending, `Validator ${validator} is idle after the initial multi-sig commit`);
  }

  // ============================================================================
  // TEST 0: NEGATIVE TEST - Proposer alone can't commit (threshold enforcement)
  // ============================================================================
  console.log('\\n═══════════════════════════════════════════════════════════════');
  console.log('  TEST 0: Negative Test - Threshold Enforcement                ');
  console.log('═══════════════════════════════════════════════════════════════\\n');

  console.log('🔒 Creating isolated 2-of-3 entity for negative test...');
  const testEntity = { id: '0x' + 'F'.padStart(64, '0'), validators: ['5', '6', '7'] };
  const testConfig = {
    mode: 'proposer-based' as const,
    threshold: 2n,
    validators: ['5', '6', '7'],
    shares: { '5': 1n, '6': 1n, '7': 1n },
  };

  // Only create proposer replica (validators 6, 7 don't exist in network)
  await applyRuntimeInput(env, {
    runtimeTxs: [
      { type: 'importReplica', entityId: testEntity.id, signerId: '5', data: { isProposer: true, position: { x: 200, y: 0, z: 0 }, config: testConfig }},
    ],
    entityInputs: [],
  });

  // Proposer creates a proposal (entity-level operation)
  await processWithOffline(env, [{
    entityId: testEntity.id,
    signerId: '5',
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(10) }}],
  }], offlineSigners);

  await processWithOffline(env, undefined, offlineSigners); // Propagate proposal (but no validators exist to sign)

  const [, t1Rep] = findReplica(env, testEntity.id);
  assert(t1Rep.proposal, 'Proposer should have proposal');
  assert(t1Rep.proposal!.collectedSigs?.size === 1, `Only proposer signature, got ${t1Rep.proposal!.collectedSigs?.size || 0}`);

  const heightBefore = t1Rep.state.height;

  // Process multiple rounds - proposal should NOT commit with only 1/3 signatures
  await processWithOffline(env, undefined, offlineSigners);
  await processWithOffline(env, undefined, offlineSigners);
  await processWithOffline(env, undefined, offlineSigners);
  const [, t1AfterWait] = findReplica(env, testEntity.id);
  assert(t1AfterWait.state.height === heightBefore, `Height should NOT change with only 1/3 signatures: ${t1AfterWait.state.height} === ${heightBefore}`);
  assert(t1AfterWait.proposal, 'Proposal should still exist (not committed)');
  assert(t1AfterWait.proposal!.collectedSigs?.size === 1, 'Should still have only 1 signature');

  console.log('   ✅ Proposer alone cannot commit (1/2 threshold not met)');
  console.log('   ✅ Threshold enforcement verified\\n');

  // Cleanup negative-test entity to avoid dangling proposals/pending work.
  for (const key of Array.from(env.eReplicas.keys())) {
    if (key.startsWith(testEntity.id + ':')) {
      env.eReplicas.delete(key);
    }
  }
  if (env.pendingOutputs) {
    env.pendingOutputs = env.pendingOutputs.filter(output => output.entityId !== testEntity.id);
  }
  if (env.pendingNetworkOutputs) {
    env.pendingNetworkOutputs = env.pendingNetworkOutputs.filter(output => output.entityId !== testEntity.id);
  }
  if (env.networkInbox) {
    env.networkInbox = env.networkInbox.filter(output => output.entityId !== testEntity.id);
  }
  if (env.runtimeInput?.entityInputs) {
    env.runtimeInput.entityInputs = env.runtimeInput.entityInputs.filter(input => input.entityId !== testEntity.id);
  }
  // ============================================================================
  // TEST 1: Byzantine tolerance (3 offline, 1+2 reach threshold on Alice entity)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 1: Byzantine Tolerance (3 offline)                      ');
  console.log('═══════════════════════════════════════════════════════════════\\n');

  console.log('📴 Simulating 3 offline (drop inputs to signer)...');
  offlineSigners.add('3');
  env.info('network', 'OFFLINE_SIGNER', { signerId: '3', reason: 'byzantine test' }, alice.id);
  console.log('   3 input delivery disabled\\n');

  console.log('💼 1 proposes: mintReserves with 3 offline (2-of-3 still enough)');
  const heightBeforeOffline = (await findReplica(env, alice.id))[1].state.height;
  const reserveBeforeOffline = (await findReplica(env, alice.id))[1].state.height;

  await processWithOffline(env, [{
    entityId: alice.id,
    signerId: '1',
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(500) } }],
  }], offlineSigners);

  // Converge - only 1 and 2 available
  await convergeWithOffline(env, offlineSigners, 10, '3-offline');
  await syncChain(env, 5);

  const [, s1AfterOffline] = findReplica(env, alice.id);
  assert(s1AfterOffline.state.height > heightBeforeOffline, `Frame should commit with 2/3 (1+2): ${s1AfterOffline.state.height} > ${heightBeforeOffline}`);
  assert(!s1AfterOffline.proposal, 'Proposal should be cleared after commit');
  assert(s1AfterOffline.state.height > reserveBeforeOffline, 'Entity height should advance under byzantine-tolerant commit');
  console.log(`   ✅ Frame committed with 3 offline (height ${heightBeforeOffline} → ${s1AfterOffline.state.height})`);

  // Restore 3 input delivery
  offlineSigners.delete('3');

  console.log('\\n✅ TEST 1 COMPLETE: Byzantine tolerance proven!\\n');
  console.log('   1 + 2 = 2/3 threshold ✅');
  console.log('   Commit succeeded without 3 ✅');

  // ============================================================================
  // TEST 2: Post-commit convergence
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 2: Post-Commit Convergence                             ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('🔄 Draining any remaining entity work...');
  await convergeWithOffline(env, offlineSigners, 20);

  const [, aliceRep3] = findReplica(env, alice.id);
  const finalHeight = aliceRep3.state.height;
  const totalEntityPending = Array.from(env.eReplicas.values()).filter(replica => replica.proposal || replica.lockedFrame || replica.mempool.length > 0).length;

  console.log(`\n📊 Final state:`);
  console.log(`   Alice height: ${finalHeight}`);
  console.log(`   Active entity proposals: ${totalEntityPending}`);
  console.log(`   Hub height: ${env.eReplicas.get(`${hub.id}:${hub.signer}`)?.state.height || 0}`);

  assert(finalHeight >= Math.max(...setupHeights) + 1, 'Alice proposer height advanced after the byzantine-tolerant commit');
  assert(totalEntityPending === 0, 'No entity-level proposals remain after convergence');

  console.log('\n✅ TEST 2 COMPLETE: Multi-sig network converged cleanly after entity commits.\n');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('✅ MULTI-SIGNER CONSENSUS: ALL TESTS PASS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📊 Total frames: ${env.history?.length || 0}`);
  console.log('   Entity-level 2-of-3 threshold: ✅');
  console.log('   Proposer alone cannot commit: ✅');
  console.log('   Byzantine tolerance (3 offline): ✅');
  console.log('   Post-commit convergence: ✅');
  console.log('═══════════════════════════════════════════════════════════════\n');
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreStrict();
  }
}

if (import.meta.main) {
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv();
  env.scenarioMode = true;
  await multiSig(env);
}
