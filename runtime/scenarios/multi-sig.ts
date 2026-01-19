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
import { ensureBrowserVM, createJReplica } from './boot';
import { findReplica, assert, processWithOffline, convergeWithOffline, enableStrictScenario, ensureSignerKeysFromSeed, requireRuntimeSeed } from './helpers';

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
  // SETUP: BrowserVM
  // ============================================================================
  console.log('🏛️  Setting up BrowserVM...');
  const browserVM = await ensureBrowserVM(env);
  const depositoryAddress = browserVM.getDepositoryAddress();
  createJReplica(env, 'MultiSig', depositoryAddress, { x: 0, y: 600, z: 0 }); // Match ahb.ts positioning
  console.log('✅ BrowserVM ready\n');

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
  // SETUP: Open bilateral account (multi-sig needs all validators to sign)
  // ============================================================================
  console.log('🔗 Opening Alice-Hub account (multi-sig)...');

  // 1 proposes openAccount
  await processWithOffline(env, [{
    entityId: alice.id,
    signerId: '1',
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
  }], offlineSigners);

  // Multi-sig: wait for 2, 3 to sign, then commit
  await convergeWithOffline(env, offlineSigners, 20);

  // Verify account exists (check all validators)
  console.log('\\n🔍 Checking account state across all validators...');
  for (const validator of alice.validators) {
    const key = `${alice.id}:${validator}`;
    const replica = env.eReplicas.get(key);
    if (!replica) {
      console.log(`  ❌ ${validator}: replica not found`);
      continue;
    }
    const hasAccount = replica.state.accounts.has(hub.id);
    const accountCount = replica.state.accounts.size;
    console.log(`  ${validator}: ${hasAccount ? '✅' : '❌'} account with Hub (total accounts: ${accountCount})`);
    if (hasAccount) {
      const account = replica.state.accounts.get(hub.id)!;
      console.log(`    → Account height: ${account.height}, mempool: ${account.mempool.length}, pending: ${!!account.pendingFrame}`);
    }
  }

  const [replicaKey, aliceCheck] = findReplica(env, alice.id);
  const hasAccount = aliceCheck.state.accounts.has(hub.id);
  console.log(`\\n  Using replica: ${replicaKey}`);
  console.log(`  Account opened: ${hasAccount ? '✅' : '❌ FAILED'}\\n`);

  if (!hasAccount) {
    throw new Error('Account opening failed - multi-sig not working');
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

  // Proposer creates a proposal (dummy operation)
  await processWithOffline(env, [{
    entityId: testEntity.id,
    signerId: '5',
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id }}],
  }], offlineSigners);

  await processWithOffline(env, undefined, offlineSigners); // Propagate proposal (but no validators exist to sign)

  const [, t1Rep] = findReplica(env, testEntity.id);
  assert(t1Rep.proposal, 'Proposer should have proposal');
  assert(t1Rep.proposal!.signatures.size === 1, `Only proposer signature, got ${t1Rep.proposal!.signatures.size}`);

  const heightBefore = t1Rep.state.height;

  // Process multiple rounds - proposal should NOT commit with only 1/3 signatures
  await processWithOffline(env, undefined, offlineSigners);
  await processWithOffline(env, undefined, offlineSigners);
  await processWithOffline(env, undefined, offlineSigners);
  const [, t1AfterWait] = findReplica(env, testEntity.id);
  assert(t1AfterWait.state.height === heightBefore, `Height should NOT change with only 1/3 signatures: ${t1AfterWait.state.height} === ${heightBefore}`);
  assert(t1AfterWait.proposal, 'Proposal should still exist (not committed)');
  assert(t1AfterWait.proposal!.signatures.size === 1, 'Should still have only 1 signature');

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
  for (const [, replica] of env.eReplicas) {
    if (replica.state.accounts.has(testEntity.id)) {
      replica.state.accounts.delete(testEntity.id);
    }
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

  console.log('💼 1 proposes: extendCredit to Hub (2-of-3, 3 offline)');
  const heightBeforeOffline = (await findReplica(env, alice.id))[1].state.height;

  await processWithOffline(env, [{
    entityId: alice.id,
    signerId: '1',
    entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: usd(10_000) } }],
  }], offlineSigners);

  // Converge - only 1 and 2 available
  await convergeWithOffline(env, offlineSigners, 10, '3-offline');

  const [, s1AfterOffline] = findReplica(env, alice.id);
  assert(s1AfterOffline.state.height > heightBeforeOffline, `Frame should commit with 2/3 (1+2): ${s1AfterOffline.state.height} > ${heightBeforeOffline}`);
  assert(!s1AfterOffline.proposal, 'Proposal should be cleared after commit');
  console.log(`   ✅ Frame committed with 3 offline (height ${heightBeforeOffline} → ${s1AfterOffline.state.height})`);

  // Restore 3 input delivery
  offlineSigners.delete('3');

  console.log('\\n✅ TEST 1 COMPLETE: Byzantine tolerance proven!\\n');
  console.log('   1 + 2 = 2/3 threshold ✅');
  console.log('   Commit succeeded without 3 ✅');

  // ============================================================================
  // SETUP: Credit
  // ============================================================================
  console.log('💳 Setting up credit...');

  await processWithOffline(env, [
    {
      entityId: alice.id,
      signerId: '1',
      entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: usd(1_000_000) } }],
    },
    {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: USDC, amount: usd(1_000_000) } }],
    },
  ], offlineSigners);

  await convergeWithOffline(env, offlineSigners, 50); // More rounds for multi-sig + bilateral

  // Verify credit was applied
  const [, aliceAfterCredit] = findReplica(env, alice.id);
  console.log(`\\n🔍 Alice entity state after credit:`);
  console.log(`   Height: ${aliceAfterCredit.state.height}`);
  console.log(`   Mempool: ${aliceAfterCredit.mempool.length}`);
  console.log(`   Proposal: ${aliceAfterCredit.proposal ? 'present' : 'none'}`);
  console.log(`   LockedFrame: ${aliceAfterCredit.lockedFrame ? 'present' : 'none'}`);

  const accountAfterCredit = aliceAfterCredit.state.accounts.get(hub.id);
  if (!accountAfterCredit) {
    throw new Error('Account with Hub not found after credit');
  }

  console.log(`\\n🔍 Alice-Hub account state:`);
  console.log(`   Account height: ${accountAfterCredit.height}`);
  console.log(`   Mempool: ${accountAfterCredit.mempool.length}`);
  console.log(`   PendingFrame: ${accountAfterCredit.pendingFrame ? 'yes' : 'no'}`);

  const deltaAfterCredit = accountAfterCredit.deltas.get(USDC);
  console.log(`\\n  💳 Credit limits:`);
  console.log(`     Alice→Hub leftCreditLimit: ${deltaAfterCredit?.leftCreditLimit || 0n}`);
  console.log(`     Alice→Hub rightCreditLimit: ${deltaAfterCredit?.rightCreditLimit || 0n}\\n`);

  // Check Hub's side
  const [, hubAfterCredit] = findReplica(env, hub.id);
  const hubAccount = hubAfterCredit.state.accounts.get(alice.id);
  console.log(`🔍 Hub-Alice account state:`);
  console.log(`   Account height: ${hubAccount?.height}`);
  console.log(`   Mempool: ${hubAccount?.mempool.length || 0}`);
  console.log(`   PendingFrame: ${hubAccount?.pendingFrame ? 'yes' : 'no'}\\n`);

  if (!deltaAfterCredit || deltaAfterCredit.rightCreditLimit === 0n) {
    throw new Error('Multi-sig credit not applied - bilateral consensus is broken');
  }

  // If credit works, we'll test bilateral consensus with multi-signer
  // ============================================================================
  // TEST 2: directPayment with multi-sig (2-of-3) + bilateral consensus
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST 2: directPayment with 2-of-3 Consensus                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const paymentAmount = usd(1000);

  console.log('💸 1 proposes: Alice→Hub $1000');
  await processWithOffline(env, [{
    entityId: alice.id,
    signerId: '1', // Proposer
    entityTxs: [{
      type: 'directPayment',
      data: {
        targetEntityId: hub.id,
        tokenId: USDC,
        amount: paymentAmount,
        route: [alice.id, hub.id],
        description: 'Multi-sig test payment',
      },
    }],
  }], offlineSigners);

  // ASSERTION 1: After proposal, 1 should have proposal with 1 signature (self)
  await processWithOffline(env, undefined, offlineSigners); // Let proposal propagate to other validators

  const [, s1AfterPropose] = findReplica(env, alice.id);
  assert(s1AfterPropose.proposal, 'Proposer should have proposal after mempool tx');
  assert(s1AfterPropose.proposal!.signatures.size === 1, `Proposal should have 1 sig (self), got ${s1AfterPropose.proposal!.signatures.size}`);
  console.log(`   ✅ Proposal created with 1 signature (proposer self-sign)`);

  // ASSERTION 2: 2 and 3 should have lockedFrame (not proposal)
  const s2Replica = env.eReplicas.get(`${alice.id}:2`);
  const s3Replica = env.eReplicas.get(`${alice.id}:3`);
  assert(s2Replica?.lockedFrame, '2 should have lockedFrame after receiving proposal');
  assert(s3Replica?.lockedFrame, '3 should have lockedFrame after receiving proposal');
  console.log(`   ✅ Validators 2, 3 locked proposal`);

  // ASSERTION 3: Collect precommits (allow a few rounds for commit/proposal ordering)
  const heightBeforeProposalCommit = s1AfterPropose.state.height;
  let s1AfterPrecommits = findReplica(env, alice.id)[1];
  let sigCount = s1AfterPrecommits.proposal?.signatures.size || 0;
  for (let i = 0; i < 5 && sigCount < 3; i++) {
    await processWithOffline(env, undefined, offlineSigners);
    s1AfterPrecommits = findReplica(env, alice.id)[1];
    sigCount = s1AfterPrecommits.proposal?.signatures.size || 0;
  }
  console.log(`   Signatures collected: ${sigCount}/3`);

  if (s1AfterPrecommits.proposal) {
    assert(sigCount === 3, `Should have 3 signatures (threshold met), got ${sigCount}`);
    console.log(`   ✅ Threshold reached: 3/3 signatures collected`);
  } else if (s1AfterPrecommits.state.height > heightBeforeProposalCommit) {
    console.log(`   ✅ Commit completed during precommit collection`);
  }

  // ASSERTION 4: Commit can lag a few ticks (due to proposal/commit ordering)
  const heightBeforeCommit = heightBeforeProposalCommit;
  let s1PostCommit = s1AfterPrecommits;
  if (s1PostCommit.state.height === heightBeforeCommit) {
    for (let i = 0; i < 6 && s1PostCommit.state.height === heightBeforeCommit; i++) {
      await processWithOffline(env, undefined, offlineSigners);
      s1PostCommit = findReplica(env, alice.id)[1];
    }
  }
  assert(
    s1PostCommit.state.height > heightBeforeCommit,
    `Height should increment after commit: ${s1PostCommit.state.height} vs ${heightBeforeCommit + 1}`
  );
  assert(!s1PostCommit.proposal, 'Proposal should be cleared after commit');
  console.log(`   ✅ Frame committed: height ${heightBeforeCommit} → ${s1PostCommit.state.height}`);

  console.log('  ✅ Multi-sig consensus verified!\n');

  // Converge bilateral account consensus
  console.log('🔄 Converging bilateral accounts...');
  await convergeWithOffline(env, offlineSigners, 20);

  // Verify payment applied
  const [, aliceRep3] = findReplica(env, alice.id);
  const account = aliceRep3.state.accounts.get(hub.id);
  const delta = account?.deltas.get(USDC);
  const offdelta = delta?.offdelta || 0n;

  console.log(`\n📊 Final state:`);
  console.log(`   Alice-Hub offdelta: ${offdelta}`);
  assert(offdelta === -paymentAmount, `Payment applied: ${offdelta} === -${paymentAmount}`);

  console.log('\n✅ TEST 2 COMPLETE: Multi-sig + bilateral consensus works!\n');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('✅ MULTI-SIGNER CONSENSUS: ALL TESTS PASS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📊 Total frames: ${env.history?.length || 0}`);
  console.log('   Entity-level 2-of-3 threshold: ✅');
  console.log('   Proposer alone cannot commit: ✅');
  console.log('   Byzantine tolerance (3 offline): ✅');
  console.log('   Bilateral consensus with multi-sig: ✅');
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
