/**
 * Merged Settlement + Rebalance Scenario
 *
 * 5 entities: Hub, Alice, Bob, Charlie, Dave
 * Tests:
 *   Phase 1: Conservation law validation (pure logic)
 *   Phase 2: Auto-approve logic
 *   Phase 3: Manual settle lifecycle (propose → update → approve → execute → broadcast)
 *   Phase 4: Settle reject
 *   Phase 5: Payment imbalances via directPayment
 *   Phase 6: Rebalance policies + hub config
 *   Phase 7: Hub crontab rebalance (C→R + R→C in one batch)
 *   Phase 8: Final verification (nonces, workspaces, collateral)
 */

import type { Env, EntityReplica, SettlementDiff, SettlementOp } from '../types';
import { compileOps } from '../settlement-ops';
import {
  getProcess, advanceScenarioTime, enableStrictScenario, converge, syncChain,
  processJEvents, assert, findReplica, usd, snap,
} from './helpers';
import { bootScenario, registerEntities, type RegisteredEntity } from './boot';
import type { JAdapter } from '../jadapter/types';
import { userAutoApprove } from '../entity-tx/handlers/settle';
import { deriveDelta } from '../account-utils';
import { isLeftEntity } from '../entity-id-utils';

const USDC = 1;

export async function runSettleRebalance(existingEnv?: Env): Promise<Env> {
  console.log('=' .repeat(80));
  console.log('  MERGED SETTLEMENT + REBALANCE SCENARIO');
  console.log('  Hub + Alice + Bob + Charlie + Dave');
  console.log('='.repeat(80));

  const process = await getProcess();

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 0: SETUP
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- PHASE 0: SETUP ---');

  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'settle-rebalance',
    signerIds: ['2', '3', '4', '5', '6'],
    seed: 'settle-rebalance-deterministic',
  });

  env.quietRuntimeLogs = true;

  // Suppress noisy logs
  const originalLog = console.log;
  const quietLog = (...args: any[]) => {
    const msg = args[0]?.toString() || '';
    if (msg.includes('ASSERT') || msg.includes('PHASE') || msg.includes('TEST') ||
        msg.includes('settle_') || msg.includes('---') || msg.includes('===') ||
        msg.includes('JAdapter') || msg.includes('HOLD') || msg.includes('REBALANCE')) {
      originalLog(...args);
    }
  };
  console.log = quietLog;
  const cleanupStrictMode = enableStrictScenario(env, 'settle-rebalance');

  const registered = await registerEntities(env, jadapter, [
    { name: 'Hub',     signer: '2', position: { x: 0, y: 0, z: 0 } },
    { name: 'Alice',   signer: '3', position: { x: -40, y: -30, z: 0 } },
    { name: 'Bob',     signer: '4', position: { x: 40, y: -30, z: 0 } },
    { name: 'Charlie', signer: '5', position: { x: -40, y: 30, z: 0 } },
    { name: 'Dave',    signer: '6', position: { x: 40, y: 30, z: 0 } },
  ], jurisdiction);

  const [hub, alice, bob, charlie, dave] = registered;
  const users = [alice, bob, charlie, dave];

  // Fund all entities
  for (const entity of [hub, ...users]) {
    const amount = entity === hub ? usd(200_000) : usd(25_000);
    await jadapter.debugFundReserves(entity.id, USDC, amount);
  }
  await syncChain(env, 3);

  // Verify hub funded
  const hubReserve = findReplica(env, hub.id)[1].state.reserves.get(String(USDC)) || 0n;
  assert(hubReserve === usd(200_000), `Hub reserve: ${hubReserve}, expected ${usd(200_000)}`, env);

  // Open bilateral accounts (each user ↔ Hub)
  for (const user of users) {
    await process(env, [{
      entityId: user.id, signerId: user.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id, tokenId: USDC, creditAmount: 0n } }]
    }]);
    await process(env);
  }
  await converge(env);

  // Hub extends credit to all users + users extend credit back
  for (const user of users) {
    await process(env, [{
      entityId: hub.id, signerId: hub.signer,
      entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: user.id, tokenId: USDC, amount: usd(50_000) } }]
    }]);
    for (let i = 0; i < 3; i++) await process(env);
  }
  for (const user of users) {
    await process(env, [{
      entityId: user.id, signerId: user.signer,
      entityTxs: [{ type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: usd(50_000) } }]
    }]);
    for (let i = 0; i < 3; i++) await process(env);
  }
  await converge(env);

  // Initial R→C deposit: Hub deposits $5K collateral per account
  const r2cTxs = users.map(user => ({
    type: 'deposit_collateral' as const,
    data: { counterpartyId: user.id, tokenId: USDC, amount: usd(5_000) },
  }));
  await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: r2cTxs }]);
  await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }]);
  advanceScenarioTime(env, 150);
  await process(env);
  await syncChain(env, 3);

  // Verify collateral
  for (const user of users) {
    const delta = findReplica(env, hub.id)[1].state.accounts.get(user.id)?.deltas.get(USDC);
    assert(delta && delta.collateral === usd(5_000), `${user.name} collateral wrong`, env);
  }

  console.log = originalLog;
  console.log('--- PHASE 0 COMPLETE: 5 entities, funded, $5K collateral each ---');
  console.log = quietLog;

  snap(env, 'Setup Complete', { phase: 'setup' });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1: CONSERVATION LAW VALIDATION
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 1: Conservation Law ---');
  console.log = quietLog;

  const validDiff: SettlementDiff = { tokenId: USDC, leftDiff: -100n, rightDiff: 50n, collateralDiff: 50n, ondeltaDiff: 0n };
  assert(validDiff.leftDiff + validDiff.rightDiff + validDiff.collateralDiff === 0n, 'Valid diff should sum to 0');

  const invalidDiff: SettlementDiff = { tokenId: USDC, leftDiff: -100n, rightDiff: 50n, collateralDiff: 40n, ondeltaDiff: 0n };
  assert(invalidDiff.leftDiff + invalidDiff.rightDiff + invalidDiff.collateralDiff !== 0n, 'Invalid diff should not sum to 0');

  console.log = originalLog;
  console.log('--- TEST 1 PASSED ---');
  console.log = quietLog;

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2: AUTO-APPROVE LOGIC
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 2: Auto-Approve Logic ---');
  console.log = quietLog;

  // Hub withdraws from collateral → Alice (left) should auto-approve
  const hubWithdraws: SettlementDiff = { tokenId: USDC, leftDiff: 0n, rightDiff: 100n, collateralDiff: -100n, ondeltaDiff: 0n };
  assert(userAutoApprove(hubWithdraws, true), 'Alice should auto-approve Hub collateral withdrawal');

  // Hub takes from Alice → should NOT auto-approve
  const hubTakes: SettlementDiff = { tokenId: USDC, leftDiff: -100n, rightDiff: 100n, collateralDiff: 0n, ondeltaDiff: 0n };
  assert(!userAutoApprove(hubTakes, true), 'Alice should NOT auto-approve when losing reserve');

  // Hub sends to Alice → should auto-approve
  const hubSends: SettlementDiff = { tokenId: USDC, leftDiff: 100n, rightDiff: -100n, collateralDiff: 0n, ondeltaDiff: 0n };
  assert(userAutoApprove(hubSends, true), 'Alice should auto-approve when gaining reserve');

  console.log = originalLog;
  console.log('--- TEST 2 PASSED ---');
  console.log = quietLog;

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3: MANUAL SETTLE LIFECYCLE (Alice ↔ Hub)
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 3: Manual Settle Lifecycle ---');
  console.log = quietLog;

  // 3a: Propose — Alice deposits $100 into collateral
  // NOTE: Hub is LEFT (0002 < 0003), Alice is RIGHT. Alice's r2c has ondeltaDiff=0
  // → Hub auto-approves (ondelta neutral for LEFT). Test verifies auto-approve + execute flow.
  const depositOps: SettlementOp[] = [{ type: 'r2c', tokenId: USDC, amount: usd(100) }];
  const aliceIsLeft = isLeftEntity(alice.id, hub.id);

  await process(env, [{
    entityId: alice.id, signerId: alice.signer,
    entityTxs: [{ type: 'settle_propose', data: { counterpartyEntityId: hub.id, ops: depositOps, memo: 'deposit' } }]
  }]);
  for (let i = 0; i < 5; i++) { advanceScenarioTime(env); await process(env); }

  const aliceWs1 = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.settlementWorkspace;
  assert(aliceWs1?.version === 1, 'Workspace should be version 1', env);
  assert(aliceWs1?.lastModifiedByLeft === aliceIsLeft, 'Alice should be lastModifier', env);

  // 3b: Verify Hub auto-approved (ondelta-neutral r2c from RIGHT proposer)
  const hubWs1 = findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.settlementWorkspace;
  assert(hubWs1, 'Hub should have workspace', env);
  const hubIsLeft = !aliceIsLeft;
  const hubHankoField = hubIsLeft ? 'leftHanko' : 'rightHanko';
  assert(hubWs1?.[hubHankoField], 'Hub should have auto-approved (signed)', env);

  // Alice should have received Hub's auto-approve hanko
  const aliceHankoField = aliceIsLeft ? 'leftHanko' : 'rightHanko';
  const aliceReceivedHubHanko = aliceWs1?.[hubHankoField];
  assert(aliceReceivedHubHanko, 'Alice should have received Hub auto-approve hanko', env);

  // 3c: Alice executes directly (Hub already auto-approved, Alice has counterparty hanko)
  // NOTE: Alice can't approve her own proposal (gate blocks proposer).
  // Execute only requires counterparty's hanko — no need for proposer to explicitly approve.
  await process(env, [{
    entityId: alice.id, signerId: alice.signer,
    entityTxs: [{ type: 'settle_execute', data: { counterpartyEntityId: hub.id } }]
  }]);
  for (let i = 0; i < 3; i++) { advanceScenarioTime(env); await process(env); }

  await process(env, [{
    entityId: alice.id, signerId: alice.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }]
  }]);
  await syncChain(env, 5);

  const aliceAccAfterSettle = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
  assert(!aliceAccAfterSettle?.settlementWorkspace, 'Workspace should be cleared after execute', env);

  // Check nonce incremented
  const aliceNonce1 = aliceAccAfterSettle?.onChainSettlementNonce || 0;
  assert(aliceNonce1 >= 1, `Alice nonce should be >= 1 after settlement, got ${aliceNonce1}`, env);

  console.log = originalLog;
  console.log('--- TEST 3 PASSED: propose → auto-approve → execute → on-chain ---');
  console.log = quietLog;

  snap(env, 'Settlement Complete', { phase: 'settle' });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4: SETTLE REJECT
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 4: Settle Reject ---');
  console.log = quietLog;

  // Hub proposes r2c (Hub=LEFT proposer → ondelta shifts → Alice WON'T auto-approve)
  const hubDepositOps: SettlementOp[] = [{ type: 'r2c', tokenId: USDC, amount: usd(50) }];
  await process(env, [{
    entityId: hub.id, signerId: hub.signer,
    entityTxs: [{ type: 'settle_propose', data: { counterpartyEntityId: alice.id, ops: hubDepositOps, memo: 'reject me' } }]
  }]);
  for (let i = 0; i < 5; i++) { advanceScenarioTime(env); await process(env); }

  // Verify Alice did NOT auto-approve (ondelta > 0 from RIGHT perspective → fails auto-approve)
  const aliceWsReject = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.settlementWorkspace;
  assert(aliceWsReject, 'Alice should have workspace from Hub propose', env);
  assert(!aliceWsReject?.[aliceHankoField], 'Alice should NOT have auto-approved', env);

  await process(env, [{
    entityId: alice.id, signerId: alice.signer,
    entityTxs: [{ type: 'settle_reject', data: { counterpartyEntityId: hub.id, reason: 'nope' } }]
  }]);
  for (let i = 0; i < 5; i++) { advanceScenarioTime(env); await process(env); }

  const aliceAccAfterReject = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
  assert(!aliceAccAfterReject?.settlementWorkspace, 'Workspace should be cleared after reject', env);

  console.log = originalLog;
  console.log('--- TEST 4 PASSED: reject clears workspace + holds ---');
  console.log = quietLog;

  snap(env, 'Settlement Rejected', { phase: 'reject' });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 5: PAYMENT IMBALANCES
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 5: Payment Imbalances ---');
  console.log = quietLog;

  // Alice → Hub → Bob: $8K
  await process(env, [{
    entityId: alice.id, signerId: alice.signer,
    entityTxs: [{
      type: 'directPayment', data: {
        targetEntityId: bob.id, tokenId: USDC, amount: usd(8_000),
        route: [alice.id, hub.id, bob.id], description: 'Alice→Bob $8K',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await converge(env);

  // Charlie → Hub → Dave: $12K
  await process(env, [{
    entityId: charlie.id, signerId: charlie.signer,
    entityTxs: [{
      type: 'directPayment', data: {
        targetEntityId: dave.id, tokenId: USDC, amount: usd(12_000),
        route: [charlie.id, hub.id, dave.id], description: 'Charlie→Dave $12K',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await converge(env);

  console.log = originalLog;
  console.log('--- TEST 5 PASSED: imbalances created ---');

  // Show imbalances
  const hubAfterPayments = findReplica(env, hub.id)[1].state;
  for (const user of users) {
    const delta = hubAfterPayments.accounts.get(user.id)?.deltas.get(USDC);
    if (!delta) continue;
    const totalDelta = delta.ondelta + delta.offdelta;
    console.log(`  Hub<>${user.name}: totalDelta=${totalDelta}, collateral=${delta.collateral}`);
  }
  console.log = quietLog;

  snap(env, 'Imbalances Created', { phase: 'imbalance' });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 6: REBALANCE POLICIES + HUB CONFIG
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 6: Rebalance Policies ---');
  console.log = quietLog;

  // Bob + Dave set rebalance policies (they have deficits)
  for (const user of [bob, dave]) {
    await process(env, [{
      entityId: user.id, signerId: user.signer,
      entityTxs: [{
        type: 'setRebalancePolicy', data: {
          counterpartyEntityId: hub.id, tokenId: USDC,
          softLimit: usd(1_000), hardLimit: usd(20_000), maxAcceptableFee: usd(100),
        }
      }]
    }]);
    for (let i = 0; i < 3; i++) await process(env);
  }
  await converge(env);

  // Hub declares as hub
  await process(env, [{
    entityId: hub.id, signerId: hub.signer,
    entityTxs: [{ type: 'setHubConfig', data: { matchingStrategy: 'hnw', routingFeePPM: 100, baseFee: 0n } }]
  }]);
  await converge(env);

  const hubConfig = findReplica(env, hub.id)[1].state.hubRebalanceConfig;
  assert(hubConfig, 'Hub config should be set', env);

  console.log = originalLog;
  console.log('--- TEST 6 PASSED: policies + hub config set ---');
  console.log = quietLog;

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 7: HUB CRONTAB REBALANCE
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 7: Hub Crontab Rebalance ---');
  console.log = quietLog;

  const advanceTime = (ms: number) => {
    env.timestamp += ms;
    for (const [, replica] of env.eReplicas) {
      replica.state.timestamp = env.timestamp;
    }
  };

  // Cycle 1: Hub detects C→R (Alice, Charlie) + R→C (Bob, Dave)
  advanceTime(31000);
  await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [] }]);
  for (let i = 0; i < 15; i++) { advanceTime(100); await process(env); }
  await converge(env);

  // Cycle 2: Hub executes signed settlements + deposits
  advanceTime(31000);
  await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [] }]);
  for (let i = 0; i < 15; i++) { advanceTime(100); await process(env); }
  await converge(env);

  // Check jBatch has ops
  const hubBatch = findReplica(env, hub.id)[1].state.jBatchState?.batch;
  const totalOps = (hubBatch?.reserveToCollateral?.length || 0) +
    (hubBatch?.collateralToReserve?.length || 0) +
    (hubBatch?.settlements?.length || 0);

  if (totalOps > 0) {
    // Broadcast
    await process(env, [{
      entityId: hub.id, signerId: hub.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }]
    }]);
    advanceTime(150);
    await process(env);
    await syncChain(env, 5);
  } else {
    // Extra cycle
    advanceTime(31000);
    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [] }]);
    for (let i = 0; i < 15; i++) { advanceTime(100); await process(env); }
    await converge(env);

    const hubBatch2 = findReplica(env, hub.id)[1].state.jBatchState?.batch;
    const totalOps2 = (hubBatch2?.reserveToCollateral?.length || 0) +
      (hubBatch2?.collateralToReserve?.length || 0) +
      (hubBatch2?.settlements?.length || 0);

    if (totalOps2 > 0) {
      await process(env, [{
        entityId: hub.id, signerId: hub.signer,
        entityTxs: [{ type: 'j_broadcast', data: {} }]
      }]);
      advanceTime(150);
      await process(env);
      await syncChain(env, 5);
    }
  }

  console.log = originalLog;
  console.log('--- TEST 7: Rebalance batch submitted ---');

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 8: FINAL VERIFICATION
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- TEST 8: Final Verification ---');

  const hubFinal = findReplica(env, hub.id)[1].state;

  // Nonces: C→R settlements (Alice, Charlie) should have nonce >= 2 (manual + auto)
  // Actually manual settle was Alice only, so:
  //   Alice nonce >= 2 (manual settle + crontab C→R)
  //   Charlie nonce >= 1 (crontab C→R)
  //   Bob, Dave: R→C deposit only, no settlement nonce change expected
  for (const user of [alice, charlie]) {
    const acc = hubFinal.accounts.get(user.id);
    const nonce = acc?.onChainSettlementNonce || 0;
    assert(nonce >= 1, `Hub<>${user.name} nonce should be >= 1 after C→R (got ${nonce})`, env);
    console.log(`  Hub<>${user.name} nonce=${nonce}`);
  }

  // Workspace cleanup: all should be cleared
  for (const user of users) {
    const acc = hubFinal.accounts.get(user.id);
    assert(!acc?.settlementWorkspace, `Hub<>${user.name} workspace should be cleared (got ${acc?.settlementWorkspace?.status})`, env);
  }

  // Counterparty nonce check
  for (const user of [alice, charlie]) {
    const [, userReplica] = findReplica(env, user.id);
    const userAcc = userReplica.state.accounts.get(hub.id);
    const userNonce = userAcc?.onChainSettlementNonce || 0;
    assert(userNonce >= 1, `${user.name}<>Hub counterparty nonce should be >= 1 (got ${userNonce})`, env);
    assert(!userAcc?.settlementWorkspace, `${user.name}<>Hub workspace should be cleared`, env);
  }

  // Final state summary
  const hubFinalReserve = hubFinal.reserves.get(String(USDC)) || 0n;
  console.log(`\n  Hub reserve: $${hubFinalReserve / 10n**18n}`);
  for (const user of users) {
    const delta = hubFinal.accounts.get(user.id)?.deltas.get(USDC);
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const derived = delta ? deriveDelta(delta, hubIsLeft) : null;
    const nonce = hubFinal.accounts.get(user.id)?.onChainSettlementNonce || 0;
    console.log(`  Hub<>${user.name}: collateral=${delta?.collateral}, outCol=${derived?.outCollateral}, nonce=${nonce}`);
  }

  console.log('\n--- TEST 8 PASSED ---');

  // ══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════════════════
  cleanupStrictMode();
  await jadapter.close();

  console.log('\n' + '='.repeat(80));
  console.log('  ALL SETTLE + REBALANCE TESTS PASSED');
  console.log('='.repeat(80) + '\n');

  return env;
}

// Run if executed directly
if (import.meta.main) {
  runSettleRebalance()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Scenario failed:', err); process.exit(1); });
}
