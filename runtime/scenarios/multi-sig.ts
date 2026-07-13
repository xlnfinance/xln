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

import type { ConsensusConfig, EntityReplica, Env } from '../types';
import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../entity/factory';
import { ensureJAdapter, getJAdapterMode, createJReplica, createJurisdictionConfig } from './boot';
import { findReplica, assert, processWithOffline, convergeWithOffline, enableStrictScenario, ensureSignerKeysFromSeed, requireRuntimeSeed, syncChain, commitRuntimeInput } from './helpers';

const USDC = 1;
const ONE = 10n ** 18n;
const usd = (amount: number | bigint) => BigInt(amount) * ONE;

const hasSuccessfulHankoBatch = (replica: EntityReplica): boolean =>
  (replica.state.jBlockChain || []).some((block) =>
    (block.events || []).some((event) => event.type === 'HankoBatchProcessed' && event.data?.success === true));

const importBoardReplicas = (
  entityId: string,
  config: ConsensusConfig,
  x: number,
) => config.validators.map((signerId, index) => ({
  type: 'importReplica' as const,
  entityId,
  signerId,
  data: {
    isProposer: index === 0,
    position: { x: x + index * 20, y: 0, z: 0 },
    config,
  },
}));

export async function multiSig(env: Env): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Multi-Sig');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  const { clearSignerKeys } = await import('../account/crypto');
  requireRuntimeSeed(env, 'Multi-Sig');
  const offlineSigners = new Set<string>();

  clearSignerKeys();
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], 'Multi-Sig');

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
  jReplica.jadapter = jadapter;
  jReplica.depositoryAddress = jadapter.addresses.depository;
  jReplica.entityProviderAddress = jadapter.addresses.entityProvider;
  jReplica.contracts = {
    depository: jadapter.addresses.depository,
    entityProvider: jadapter.addresses.entityProvider,
    account: jadapter.addresses.account,
    deltaTransformer: jadapter.addresses.deltaTransformer,
  };
  env.jAdapter = jadapter;
  jadapter.startWatching(env);
  const jurisdiction = createJurisdictionConfig(
    'MultiSig',
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
    jadapter.mode === 'browservm' ? 'browservm://' : (process.env['ANVIL_RPC'] || 'http://localhost:8545'),
    Number(jadapter.chainId),
  );
  console.log('✅ JAdapter ready\n');

  // ============================================================================
  // SETUP: Create lazy and registered 2-of-3 entities plus a lazy recipient
  // ============================================================================
  console.log('📦 Creating entities...');

  const aliceConfig: ConsensusConfig = {
    mode: 'proposer-based' as const,
    threshold: 2n, // CRITICAL: 2-of-3 threshold
    validators: ['1', '2', '3'],
    shares: { '1': 1n, '2': 1n, '3': 1n },
    jurisdiction,
  };
  const alice = {
    id: generateLazyEntityId(aliceConfig.validators, aliceConfig.threshold).toLowerCase(),
    validators: aliceConfig.validators,
  };
  assert(alice.id === hashBoard(encodeBoard(aliceConfig)).toLowerCase(), 'lazy entity ID commits exact validator order');

  const hubConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: ['4'],
    shares: { '4': 1n },
    jurisdiction,
  };
  const hub = {
    id: generateLazyEntityId(hubConfig.validators, hubConfig.threshold).toLowerCase(),
    validators: hubConfig.validators,
    signer: '4',
  };

  const registeredConfig: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 2n,
    validators: ['5', '6', '7'],
    shares: { '5': 1n, '6': 1n, '7': 1n },
    jurisdiction,
  };
  const registeredBoardHash = hashBoard(encodeBoard(registeredConfig));
  const nextEntityNumber = await jadapter.entityProvider.nextNumber();
  const registration = await jadapter.entityProvider.registerNumberedEntity(registeredBoardHash);
  const registrationReceipt = await registration.wait();
  assert(registrationReceipt?.status === 1, 'numbered multisig board registered on EntityProvider');
  const registered = {
    id: generateNumberedEntityId(Number(nextEntityNumber)).toLowerCase(),
    validators: registeredConfig.validators,
  };

  // CRITICAL: Multi-signer requires separate replica for EACH validator
  await commitRuntimeInput(env, {
    runtimeTxs: [
      ...importBoardReplicas(alice.id, aliceConfig, 0),
      ...importBoardReplicas(registered.id, registeredConfig, 100),
      ...importBoardReplicas(hub.id, hubConfig, 220),
    ],
    entityInputs: [],
  });

  console.log('  ✅ Alice: 2-of-3 validators (1, 2, 3)');
  console.log(`  ✅ Registered: ${registered.id.slice(-8)} with 2-of-3 validators (5, 6, 7)`);
  console.log('  ✅ Hub: lazy single validator\n');

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

  await processWithOffline(env, [{
    entityId: registered.id,
    signerId: '5',
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
    const pendingDetails = [
      replica?.proposal ? `proposal=${replica.proposal.hash.slice(0, 10)}` : null,
      replica?.lockedFrame ? `locked=${replica.lockedFrame.hash.slice(0, 10)}` : null,
      replica?.mempool.length ? `mempool=[${replica.mempool.map(tx => tx.type).join(',')}]` : null,
    ].filter(Boolean).join(' ');
    setupHeights.push(height);
    console.log(`  ${validator}: height=${height}, pending=${hasPending ? pendingDetails || 'yes' : 'no'}`);
    assert(height > 0, `Validator ${validator} committed the initial multi-sig entity tx`);
    assert(!hasPending, `Validator ${validator} is idle after the initial multi-sig commit`);
  }

  for (const validator of registered.validators) {
    const replica = env.eReplicas.get(`${registered.id}:${validator}`);
    assert((replica?.state.height || 0) > 0, `Registered validator ${validator} committed initial entity tx`);
    assert((replica?.state.reserves.get(USDC) || 0n) === usd(1_000), `Registered validator ${validator} finalized minted reserve`);
  }

  // Both entity forms must authorize a real Depository batch with their 2-of-3 Hanko.
  for (const board of [
    { name: 'lazy', id: alice.id, proposer: '1', validators: alice.validators, amount: usd(10) },
    { name: 'registered', id: registered.id, proposer: '5', validators: registered.validators, amount: usd(15) },
  ]) {
    await processWithOffline(env, [{
      entityId: board.id,
      signerId: board.proposer,
      entityTxs: [
        { type: 'r2r', data: { toEntityId: hub.id, tokenId: USDC, amount: board.amount } },
        { type: 'j_broadcast', data: {} },
      ],
    }], offlineSigners);
    await convergeWithOffline(env, offlineSigners, 20);
    await syncChain(env, 8);

    for (const validator of board.validators) {
      const replica = env.eReplicas.get(`${board.id}:${validator}`);
      assert(!!replica, `${board.name} validator ${validator} replica exists`);
      assert(hasSuccessfulHankoBatch(replica!), `${board.name} validator ${validator} finalized HankoBatchProcessed`);
      assert(!replica!.proposal && !replica!.lockedFrame && replica!.mempool.length === 0,
        `${board.name} validator ${validator} is idle after J finality`);
    }
  }

  // ============================================================================
  // TEST 0: NEGATIVE TEST - Proposer alone can't commit (threshold enforcement)
  // ============================================================================
  console.log('\\n═══════════════════════════════════════════════════════════════');
  console.log('  TEST 0: Negative Test - Threshold Enforcement                ');
  console.log('═══════════════════════════════════════════════════════════════\\n');

  console.log('🔒 Creating isolated 2-of-3 entity for negative test...');
  const testConfig: ConsensusConfig = {
    mode: 'proposer-based' as const,
    threshold: 2n,
    validators: ['8', '9', '10'],
    shares: { '8': 1n, '9': 1n, '10': 1n },
    jurisdiction,
  };
  const testEntity = {
    id: generateLazyEntityId(testConfig.validators, testConfig.threshold).toLowerCase(),
    validators: testConfig.validators,
  };

  // Create every validator replica, then take 9/10 offline. Missing replicas are
  // a topology error; this negative test is only about threshold enforcement.
  await commitRuntimeInput(env, {
    runtimeTxs: [
      ...importBoardReplicas(testEntity.id, testConfig, 340),
    ],
    entityInputs: [],
  });
  offlineSigners.add('9');
  offlineSigners.add('10');

  // Proposer creates a proposal (entity-level operation)
  await processWithOffline(env, [{
    entityId: testEntity.id,
    signerId: '8',
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC, amount: usd(10) }}],
  }], offlineSigners);

  await processWithOffline(env, undefined, offlineSigners); // Propagate proposal while validators 6/7 are offline

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
  offlineSigners.delete('9');
  offlineSigners.delete('10');
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
  console.log('   Lazy + registered on-chain Hanko: ✅');
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
