/**
 * Merged Settlement + Rebalance Scenario
 *
 * 5 entities: Hub, Alice, Bob, Charlie, Dave
 * Tests:
 *   Phase 1: Conservation law validation (pure logic)
 *   Phase 2: Auto-approve logic
 *   Phase 3: Manual settle lifecycle (propose → update → approve → execute → broadcast)
 *   Phase 4: Settle reject
 *   Phase 5: Payment imbalances via atomic HTLC payments
 *   Phase 6: Rebalance policies + hub config
 *   Phase 7: Hub crontab rebalance (C→R + R→C in one batch)
 *   Phase 8: Final verification (nonces, workspaces, collateral)
 *
 * Rebalance trigger invariant:
 * - Trigger request_collateral only when deriveDelta(...).outPeerCredit > r2cRequestSoftLimit.
 * - Never trigger from (outCollateral + outPeerCredit), otherwise post-topup spam appears.
 */

import type { RuntimeReplica } from '../../runtime/types';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import type { SettlementDiff, SettlementOp } from '../../types/account';
import {
  getProcess, advanceScenarioTime, enableStrictScenario, converge, syncChain,
  assert, findReplica, usd, snap,
} from '../harness/helpers';
import { bootScenario, registerEntities, type RegisteredEntity } from '../harness/boot';
import { userAutoApprove } from '../../entity/tx/handlers/payments/settle';
import { deriveDelta } from '../../account/utils';
import { getDefaultRebalancePolicyForToken } from '../../account/config/defaults';
import { isLeftEntity } from '../../entity/id';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { withDeterministicHtlcTestSecret } from '../../protocol/htlc/test-secret-capability';
import { openRuntimeTraceScopeForTesting } from '../../runtime/observability/runtime-trace';
import { ethers } from 'ethers';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import type { SentJBatch } from '../../jurisdiction/machine/batch';

const USDC = 1;
const convergeScenario = (env: RuntimeReplica, maxCycles = 15): Promise<void> => converge(env, maxCycles);

const requireRegisteredEntity = (
  entity: RegisteredEntity | undefined,
  name: string,
): RegisteredEntity => {
  if (!entity) {
    throw new Error(`SETTLE_REBALANCE_MISSING_ENTITY:${name}`);
  }
  return entity;
};

export async function runSettleRebalance(runtimeReplica: RuntimeReplica): Promise<RuntimeReplica> {
  console.log('=' .repeat(80));
  console.log('  MERGED SETTLEMENT + REBALANCE SCENARIO');
  console.log('  Hub + Alice + Bob + Charlie + Dave');
  console.log('='.repeat(80));

  const process = await getProcess();
  const advanceTime = (ms: number) => advanceScenarioTime(env, ms, true);

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 0: SETUP
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- PHASE 0: SETUP ---');

  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'settle-rebalance',
    signerIds: ['2', '3', '4', '5', '6'],
    runtimeReplica,
  });

  env.quietRuntimeLogs = true;

  // Suppress noisy logs
  const originalLog = console.log;
  const quietLog = (...args: unknown[]) => {
    const msg = args[0]?.toString() || '';
    if (msg.includes('ASSERT') || msg.includes('PHASE') || msg.includes('TEST') ||
        msg.includes('settle_') || msg.includes('---') || msg.includes('===') ||
        msg.includes('JAdapter') || msg.includes('HOLD') || msg.includes('REBALANCE')) {
      originalLog(...args);
    }
  };
  console.log = quietLog;
  const cleanupStrictMode = enableStrictScenario(env, 'settle-rebalance');
  try {

  const registered = await registerEntities(env, jadapter, [
    { name: 'Hub',     signer: '2', position: { x: 0, y: 0, z: 0 } },
    { name: 'Alice',   signer: '3', position: { x: -40, y: -30, z: 0 } },
    { name: 'Bob',     signer: '4', position: { x: 40, y: -30, z: 0 } },
    { name: 'Charlie', signer: '5', position: { x: -40, y: 30, z: 0 } },
    { name: 'Dave',    signer: '6', position: { x: 40, y: 30, z: 0 } },
  ], jurisdiction);

  const hub = requireRegisteredEntity(registered[0], 'Hub');
  const alice = requireRegisteredEntity(registered[1], 'Alice');
  const bob = requireRegisteredEntity(registered[2], 'Bob');
  const charlie = requireRegisteredEntity(registered[3], 'Charlie');
  const dave = requireRegisteredEntity(registered[4], 'Dave');
  const users = [alice, bob, charlie, dave];

  const waitForNoSentBatch = async (label: string, maxRounds = 30): Promise<void> => {
    for (let i = 0; i < maxRounds; i++) {
      const hubState = findReplica(env, hub.id)[1].state;
      if (!hubState.jBatchState?.sentBatch) return;

      await syncChain(env, 1);
      advanceTime(200);
      await process(env);
    }
    const hubState = findReplica(env, hub.id)[1].state;
    assert(
      !hubState.jBatchState?.sentBatch,
      `${label}: expected hub sentBatch to clear before proceeding`,
      env,
    );
  };

  const waitForHubCollateral = async (counterpartyId: string, expected: bigint, label: string, maxRounds = 20): Promise<void> => {
    for (let i = 0; i < maxRounds; i++) {
      const current =
        findReplica(env, hub.id)[1].state.accounts.get(counterpartyId)?.state.deltas.get(USDC)?.collateral || 0n;
      if (current === expected) return;
      await syncChain(env, 1);
      advanceTime(200);
      await process(env);
    }
    const current =
      findReplica(env, hub.id)[1].state.accounts.get(counterpartyId)?.state.deltas.get(USDC)?.collateral || 0n;
    assert(current === expected, `${label}: collateral ${current}, expected ${expected}`, env);
  };

  // Fund all entities
  for (const entity of [hub, ...users]) {
    const amount = entity === hub ? usd(200_000) : usd(25_000);
    await jadapter.debugFundReserves(entity.id, USDC, amount);
  }
  await syncChain(env, 3);

  // Verify hub funded
  const hubReserve = findReplica(env, hub.id)[1].state.reserves.get(USDC) || 0n;
  assert(hubReserve === usd(200_000), `Hub reserve: ${hubReserve}, expected ${usd(200_000)}`, env);

  // Open bilateral accounts (each user ↔ Hub)
  for (const user of users) {
    await process(env, [{
      entityId: user.id, signerId: user.signer,
      entityTxs: [{ type: 'openAccount', data: {
        targetEntityId: hub.id,
        disputeConfig: defaultAccountDisputeConfigForParties(user.id, false, hub.id, true),
        tokenId: USDC,
        creditAmount: 0n,
      } }]
    }]);
    await process(env);
  }
  await convergeScenario(env);

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
  await convergeScenario(env);

  // Initial R→C deposit: Hub deposits $5K collateral per account
  const r2cTxs = users.map(user => ({
    type: 'r2c' as const,
    data: { counterpartyId: user.id, tokenId: USDC, amount: usd(5_000) },
  }));
  await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: r2cTxs }]);
  await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [{ type: 'j_broadcast', data: {} }] }]);
  advanceScenarioTime(env, 150);
  await process(env);
  await syncChain(env, 3);

  // Verify collateral
  for (const user of users) {
    await waitForHubCollateral(user.id, usd(5_000), `${user.name} collateral wrong`);
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
  await convergeScenario(env);

  const aliceWs1 = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.state.settlementWorkspace;
  assert(aliceWs1?.revision === 1, 'Workspace should be revision 1', env);
  assert(aliceWs1?.lastModifiedByLeft === aliceIsLeft, 'Alice should be lastModifier', env);

  // 3b: Verify Hub auto-approved (ondelta-neutral r2c from RIGHT proposer)
  const hubWs1 = findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.state.settlementWorkspace;
  assert(hubWs1, 'Hub should have workspace', env);
  const hubIsLeft = !aliceIsLeft;
  const hubHankoField = hubIsLeft ? 'leftHanko' : 'rightHanko';
  assert(hubWs1?.[hubHankoField], 'Hub should have auto-approved (signed)', env);

  // Alice should have received Hub's auto-approve hanko
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
  assert(!aliceAccAfterSettle?.state.settlementWorkspace, 'Workspace should be cleared after execute', env);

  // Check nonce counter
  const aliceNonce1 = aliceAccAfterSettle?.state.jNonce || 0;
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

  // Hub proposes taking Alice's reserve. That cannot auto-authorize on Alice's
  // behalf, so the unsigned workspace remains explicitly rejectable.
  const hubTakeOps: SettlementOp[] = [{
    type: 'rawDiff',
    tokenId: USDC,
    leftDiff: usd(50),
    rightDiff: -usd(50),
    collateralDiff: 0n,
    ondeltaDiff: 0n,
  }];
  await process(env, [{
    entityId: hub.id, signerId: hub.signer,
    entityTxs: [{ type: 'settle_propose', data: { counterpartyEntityId: alice.id, ops: hubTakeOps, memo: 'reject me' } }]
  }]);
  await convergeScenario(env);

  // Workspace must exist on Alice side before explicit reject.
  const aliceWsReject = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.state.settlementWorkspace;
  assert(aliceWsReject, 'Alice should have workspace from Hub propose', env);

  await process(env, [{
    entityId: alice.id, signerId: alice.signer,
    entityTxs: [{ type: 'settle_reject', data: { counterpartyEntityId: hub.id, reason: 'nope' } }]
  }]);
  await convergeScenario(env);

  const aliceAccAfterReject = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
  assert(!aliceAccAfterReject?.state.settlementWorkspace, 'Workspace should be cleared after reject', env);

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
      type: 'htlcPayment', data: {
        targetEntityId: bob.id, tokenId: USDC, amount: usd(8_000),
        maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [alice.id, hub.id, bob.id], USDC, usd(8_000)).senderLockAmount,
        route: [alice.id, hub.id, bob.id], description: 'Alice→Bob $8K',
        deliveryMode: 'instant',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await convergeScenario(env);

  // Charlie → Hub → Dave: $12K
  await process(env, [{
    entityId: charlie.id, signerId: charlie.signer,
    entityTxs: [{
      type: 'htlcPayment', data: {
        targetEntityId: dave.id, tokenId: USDC, amount: usd(12_000),
        maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [charlie.id, hub.id, dave.id], USDC, usd(12_000)).senderLockAmount,
        route: [charlie.id, hub.id, dave.id], description: 'Charlie→Dave $12K',
        deliveryMode: 'instant',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await convergeScenario(env);

  console.log = originalLog;
  console.log('--- TEST 5 PASSED: imbalances created ---');

  // Show imbalances
  const hubAfterPayments = findReplica(env, hub.id)[1].state;
  for (const user of users) {
    const delta = hubAfterPayments.accounts.get(user.id)?.state.deltas.get(USDC);
    if (!delta) continue;
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const derived = deriveDelta(delta, hubIsLeft);
    console.log(
      `  Hub<>${user.name}: delta=${derived.delta}, outCollateral=${derived.outCollateral}, outPeerCredit=${derived.outPeerCredit}`,
    );
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
          r2cRequestSoftLimit: usd(1_000), hardLimit: usd(20_000), maxAcceptableFee: usd(100),
        }
      }]
    }]);
    for (let i = 0; i < 3; i++) await process(env);
  }
  await convergeScenario(env);

  const hubBeforeMixedRebalance = findReplica(env, hub.id)[1].state;
  const hubReserveBeforeMixedRebalance = hubBeforeMixedRebalance.reserves.get(USDC) || 0n;
  const rebalanceEvidenceBefore = new Map(users.map(user => {
    const account = hubBeforeMixedRebalance.accounts.get(user.id);
    const delta = account?.state.deltas.get(USDC);
    assert(account && delta, `Missing Hub<>${user.name} baseline`, env);
    return [user.id, {
      collateral: delta.collateral,
      ondelta: delta.ondelta,
      jNonce: account.state.jNonce,
      lastFinalizedJHeight: account.state.lastFinalizedJHeight || 0,
    }] as const;
  }));
  const expectedC2R = new Map<string, bigint>();
  const c2rSoftLimit = getDefaultRebalancePolicyForToken(USDC).r2cRequestSoftLimit;
  for (const user of [alice, charlie]) {
    const account = hubBeforeMixedRebalance.accounts.get(user.id);
    const delta = account?.state.deltas.get(USDC);
    assert(delta, `Missing C→R baseline for ${user.name}`, env);
    const derived = deriveDelta(delta, isLeftEntity(hub.id, user.id));
    assert(derived.outTotalHold !== undefined, `Missing C→R hold for ${user.name}`, env);
    const free = derived.outCollateral > derived.outTotalHold
      ? derived.outCollateral - derived.outTotalHold
      : 0n;
    assert(free > c2rSoftLimit, `${user.name} must qualify for C→R`, env);
    expectedC2R.set(user.id, free);
  }
  assert(expectedC2R.get(alice.id) === usd(5_100), 'Alice exact C→R fixture changed', env);
  assert(expectedC2R.get(charlie.id) === usd(5_000), 'Charlie exact C→R fixture changed', env);

  // Enabling the hub is the causal boundary: no earlier convergence can
  // consume the mixed rebalance while this trace is active.
  const mixedRebalanceTrace = openRuntimeTraceScopeForTesting(env);
  try {
    await process(env, [{
      entityId: hub.id, signerId: hub.signer,
      entityTxs: [{ type: 'setHubConfig', data: { matchingStrategy: 'amount', routingFeePPM: 100, baseFee: 0n } }]
    }]);
    await convergeScenario(env, 30);
    await waitForNoSentBatch('mixed-rebalance');
    await syncChain(env, 2);
    await convergeScenario(env, 30);
  } finally {
    mixedRebalanceTrace.stop();
  }

  const hubConfig = findReplica(env, hub.id)[1].state.hubRebalanceConfig;
  assert(hubConfig, 'Hub config should be set', env);

  const mixedSnapshots = mixedRebalanceTrace.snapshots.slice(mixedRebalanceTrace.startIndex);
  const mixedTraceLogs = mixedSnapshots.flatMap(snapshot => snapshot.logs ?? []);
  const requestedByUser = new Map<string, bigint>();
  for (const user of [bob, dave]) {
    const receipts = mixedTraceLogs.filter(log => {
      const data = (log.data ?? {}) as Record<string, unknown>;
      return log.message === 'request_collateral_committed' &&
        String(data['entityId'] ?? '').toLowerCase() === user.id.toLowerCase() &&
        String(data['accountId'] ?? '').toLowerCase() === hub.id.toLowerCase() &&
        Number(data['tokenId']) === USDC;
    });
    assert(receipts.length === 1, `${user.name} must commit exactly one collateral request`, env);
    requestedByUser.set(user.id, BigInt(String(receipts[0]?.data?.['requestedAmount'] ?? '0')));
  }
  assert(requestedByUser.get(bob.id) === 2_999_600_000n, 'Bob exact R→C fixture changed', env);
  assert(requestedByUser.get(dave.id) === 6_999_200_000n, 'Dave exact R→C fixture changed', env);

  const sentBatches = new Map<string, SentJBatch>();
  for (const snapshot of mixedSnapshots) {
    const hubReplica = [...snapshot.state.eReplicas.values()].find(
      replica => replica.entityId.toLowerCase() === hub.id.toLowerCase(),
    );
    const sent = hubReplica?.state.jBatchState?.sentBatch;
    if (sent) sentBatches.set(`${sent.batchHash.toLowerCase()}:${sent.entityNonce}`, sent);
  }
  assert(sentBatches.size > 0, 'PHASE7_NO_FRESH_J_BATCH', env);
  const sentValues = [...sentBatches.values()];
  const r2cPairs = sentValues.flatMap(sent => sent.batch.reserveToCollateral
    .filter(op => op.receivingEntity.toLowerCase() === hub.id.toLowerCase() && op.tokenId === USDC)
    .flatMap(op => op.pairs.map(pair => ({ sent, pair }))));
  const c2rOps = sentValues.flatMap(sent => sent.batch.collateralToReserve
    .filter(op => op.tokenId === USDC)
    .map(op => ({ sent, op })));
  assert(r2cPairs.length === requestedByUser.size, `Expected ${requestedByUser.size} exact R→C legs`, env);
  assert(c2rOps.length === expectedC2R.size, `Expected ${expectedC2R.size} exact C→R legs`, env);
  for (const [userId, amount] of requestedByUser) {
    assert(
      r2cPairs.filter(({ pair }) => pair.entity.toLowerCase() === userId.toLowerCase() && pair.amount === amount).length === 1,
      `Missing unique exact R→C leg for ${userId.slice(-4)}`,
      env,
    );
  }
  for (const [userId, amount] of expectedC2R) {
    assert(
      c2rOps.filter(({ op }) => op.counterparty.toLowerCase() === userId.toLowerCase() && op.amount === amount).length === 1,
      `Missing unique exact C→R leg for ${userId.slice(-4)}`,
      env,
    );
  }
  assert(
    sentValues.every(sent => sent.batch.settlements.length === 0),
    'Pure C→R must use only the compressed collateralToReserve lane',
    env,
  );
  assert(typeof jadapter.hasProcessedBatch === 'function', 'Exact batch receipt lookup required', env);
  for (const sent of sentValues) {
    assert(
      await jadapter.hasProcessedBatch(hub.id, sent.batchHash, BigInt(sent.entityNonce)),
      `Missing processed receipt for batch nonce ${sent.entityNonce}`,
      env,
    );
  }

  const hubAfterMixedRebalance = findReplica(env, hub.id)[1].state;
  const totalR2C = [...requestedByUser.values()].reduce((sum, amount) => sum + amount, 0n);
  const totalC2R = [...expectedC2R.values()].reduce((sum, amount) => sum + amount, 0n);
  assert(
    (hubAfterMixedRebalance.reserves.get(USDC) || 0n) ===
      hubReserveBeforeMixedRebalance - totalR2C + totalC2R,
    'Hub reserve must conserve exact mixed rebalance legs',
    env,
  );
  for (const user of users) {
    const before = rebalanceEvidenceBefore.get(user.id);
    assert(before, `Missing rebalance baseline for ${user.name}`, env);
    const hubAccount = hubAfterMixedRebalance.accounts.get(user.id);
    const [, userReplica] = findReplica(env, user.id);
    const userAccount = userReplica.state.accounts.get(hub.id);
    const expectedCollateral = before.collateral +
      (requestedByUser.get(user.id) || 0n) - (expectedC2R.get(user.id) || 0n);
    const hubDelta = hubAccount?.state.deltas.get(USDC);
    const userDelta = userAccount?.state.deltas.get(USDC);
    assert(hubDelta?.collateral === expectedCollateral, `${user.name} hub collateral mismatch`, env);
    assert(userDelta?.collateral === expectedCollateral, `${user.name} peer collateral mismatch`, env);
    assert(hubDelta?.ondelta === userDelta?.ondelta, `${user.name} bilateral ondelta mismatch`, env);
    assert(hubAccount?.state.jNonce === userAccount?.state.jNonce, `${user.name} bilateral nonce mismatch`, env);
    assert(!hubAccount?.state.settlementWorkspace && !userAccount?.state.settlementWorkspace,
      `${user.name} settlement workspace must clear`, env);
    if (expectedC2R.has(user.id)) {
      assert((hubAccount?.state.jNonce || 0) > before.jNonce, `${user.name} C→R nonce must advance`, env);
    }
    if (requestedByUser.has(user.id)) {
      assert((hubAccount?.state.requestedRebalance.get(USDC) || 0n) === 0n,
        `${user.name} request must clear`, env);
      assert(!hubAccount?.state.requestedRebalanceFeeState.has(USDC),
        `${user.name} fee state must clear`, env);
      assert(!hubAccount?.shadow.rebalance.submittedAtByToken.has(USDC),
        `${user.name} exact-once latch must clear`, env);
      assert((hubAccount?.state.lastFinalizedJHeight || 0) > before.lastFinalizedJHeight,
        `${user.name} finalized J height must advance`, env);
    }
  }

  console.log = originalLog;
  console.log('--- TEST 6 PASSED: exact mixed R→C + C→R batch finalized ---');
  console.log = quietLog;

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 6.5: HTLC RESOLVE -> AUTO-REBALANCE REQUEST
  // Keep this in sync with:
  // - core/account/consensus/index.ts::runPostFrameAutoRebalanceCheck
  // - tests/e2e/payments/e2e-rebalance-bar.spec.ts cycle assertions
  // ══════════════════════════════════════════════════════════════════════════
  console.log = originalLog;
  console.log('\n--- TEST 6.5: HTLC resolve triggers auto request_collateral ---');
  console.log = quietLog;

  const daveCollateralBeforeHtlc =
    findReplica(env, dave.id)[1].state.accounts.get(hub.id)?.state.deltas.get(USDC)?.collateral || 0n;
  const htlcSecret = ethers.keccak256(ethers.toUtf8Bytes('settle-rebalance-htlc-phase-6-5'));
  const htlcHashlock = hashHtlcSecret(htlcSecret);
  let daveAccountAfterHtlc = findReplica(env, dave.id)[1].state.accounts.get(hub.id);
  let daveRequestedAfterHtlc = 0n;
  let daveCollateralAfterHtlc = daveCollateralBeforeHtlc;
  let phase65HtlcReceived = false;
  let phase65HtlcFinalized = false;
  let phase65RequestCollateralCommitted = false;

  // Production history is intentionally bounded to one snapshot. This
  // scenario owns the multi-frame trace only for the causal assertion below.
  const phase65Trace = openRuntimeTraceScopeForTesting(env);
  try {
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [withDeterministicHtlcTestSecret({
        type: 'htlcPayment',
        data: {
          targetEntityId: dave.id,
          tokenId: USDC,
          amount: usd(2_000),
          maxSenderDebit: usd(2_000),
          route: [hub.id, dave.id],
          deliveryMode: 'async',
          description: 'hub->dave htlc rebalance trigger',
          hashlock: htlcHashlock,
        },
      }, htlcSecret)],
    }]);

    // Wait for the full off-chain ACK chain, not a fixed tick count. Runtime
    // may insert a J-event-only frame between submit and local follow-ups; the
    // invariant here is the observed sequence, not a specific frame number.
    for (let i = 0; i < 80; i++) {
      advanceTime(i < 20 ? 50 : 100);
      await process(env);
      await syncChain(env, 1);
      daveAccountAfterHtlc = findReplica(env, dave.id)[1].state.accounts.get(hub.id);
      daveRequestedAfterHtlc = daveAccountAfterHtlc?.state.requestedRebalance.get(USDC) || 0n;
      daveCollateralAfterHtlc = daveAccountAfterHtlc?.state.deltas.get(USDC)?.collateral || 0n;
      const phase65Logs = phase65Trace.snapshots
        .slice(phase65Trace.startIndex)
        .flatMap((snapshot) => snapshot.logs ?? []);
      phase65HtlcReceived = phase65Logs.some((log) => {
        const data = (log.data ?? {}) as Record<string, unknown>;
        return log.message === 'HtlcReceived' &&
          String(data['entityId'] || '').toLowerCase() === dave.id.toLowerCase() &&
          String(data['hashlock'] || '').toLowerCase() === htlcHashlock.toLowerCase();
      });
      phase65HtlcFinalized = phase65Logs.some((log) => {
        const data = (log.data ?? {}) as Record<string, unknown>;
        return log.message === 'HtlcFinalized' &&
          String(data['hashlock'] || '').toLowerCase() === htlcHashlock.toLowerCase();
      });
      phase65RequestCollateralCommitted = phase65Logs.some((log) => {
        const data = (log.data ?? {}) as Record<string, unknown>;
        return log.message === 'request_collateral_committed' &&
          String(data['entityId'] || '').toLowerCase() === dave.id.toLowerCase() &&
          Number(data['tokenId']) === USDC;
      });
      const hubSentBatch = findReplica(env, hub.id)[1].state.jBatchState?.sentBatch;
      if (phase65HtlcReceived && phase65HtlcFinalized && phase65RequestCollateralCommitted &&
        daveRequestedAfterHtlc === 0n && daveCollateralAfterHtlc > daveCollateralBeforeHtlc &&
        !hubSentBatch) {
        break;
      }
    }
  } finally {
    phase65Trace.stop();
  }

  assert(phase65HtlcReceived, 'Expected Dave to receive HTLC before request_collateral', env);
  assert(phase65HtlcFinalized, 'Expected HTLC to finalize before request_collateral', env);
  assert(
    phase65RequestCollateralCommitted,
    'Expected request_collateral commit after HTLC resolve (auto-rebalance trigger)',
    env,
  );
  assert(
    daveRequestedAfterHtlc === 0n && daveCollateralAfterHtlc > daveCollateralBeforeHtlc,
    `Expected finalized top-up after HTLC resolve (requested=${daveRequestedAfterHtlc}, collateral ${daveCollateralBeforeHtlc}->${daveCollateralAfterHtlc})`,
    env,
  );
  const phase65Snapshots = phase65Trace.snapshots.slice(phase65Trace.startIndex);
  const phase65Receipts = phase65Snapshots.flatMap(snapshot => snapshot.logs ?? []).filter(log => {
    const data = (log.data ?? {}) as Record<string, unknown>;
    return log.message === 'request_collateral_committed' &&
      String(data['entityId'] ?? '').toLowerCase() === dave.id.toLowerCase() &&
      String(data['accountId'] ?? '').toLowerCase() === hub.id.toLowerCase() &&
      Number(data['tokenId']) === USDC;
  });
  assert(phase65Receipts.length === 1, 'Expected one exact post-HTLC collateral request', env);
  const phase65RequestedAmount = BigInt(String(phase65Receipts[0]?.data?.['requestedAmount'] ?? '0'));
  assert(
    daveCollateralAfterHtlc === daveCollateralBeforeHtlc + phase65RequestedAmount,
    'Post-HTLC R→C amount must equal its committed request',
    env,
  );
  const phase65SentBatches = new Map<string, SentJBatch>();
  for (const snapshot of phase65Snapshots) {
    const hubReplica = [...snapshot.state.eReplicas.values()].find(
      replica => replica.entityId.toLowerCase() === hub.id.toLowerCase(),
    );
    const sent = hubReplica?.state.jBatchState?.sentBatch;
    if (sent) phase65SentBatches.set(`${sent.batchHash.toLowerCase()}:${sent.entityNonce}`, sent);
  }
  const phase65Pairs = [...phase65SentBatches.values()].flatMap(sent =>
    sent.batch.reserveToCollateral
      .filter(op => op.receivingEntity.toLowerCase() === hub.id.toLowerCase() && op.tokenId === USDC)
      .flatMap(op => op.pairs.map(pair => ({ sent, pair }))),
  );
  assert(
    phase65Pairs.filter(({ pair }) =>
      pair.entity.toLowerCase() === dave.id.toLowerCase() && pair.amount === phase65RequestedAmount).length === 1,
    'Expected one exact post-HTLC R→C batch leg',
    env,
  );
  const hubDaveAfterHtlc = findReplica(env, hub.id)[1].state.accounts.get(dave.id);
  assert(
    hubDaveAfterHtlc?.state.deltas.get(USDC)?.collateral === daveCollateralAfterHtlc,
    'Post-HTLC collateral must be bilateral-equal',
    env,
  );
  assert(!hubDaveAfterHtlc?.state.requestedRebalance.has(USDC), 'Post-HTLC request must clear', env);
  assert(!hubDaveAfterHtlc?.state.requestedRebalanceFeeState.has(USDC), 'Post-HTLC fee state must clear', env);
  assert(!hubDaveAfterHtlc?.shadow.rebalance.submittedAtByToken.has(USDC), 'Post-HTLC latch must clear', env);

  console.log = originalLog;
  console.log('--- TEST 6.5 PASSED ---');
  console.log = quietLog;

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 7: FINAL VERIFICATION
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- TEST 7: Final Verification ---');

  const hubFinal = findReplica(env, hub.id)[1].state;

  const aliceNonce = hubFinal.accounts.get(alice.id)?.state.jNonce || 0;
  assert(aliceNonce >= 1, `Hub<>Alice nonce should be >= 1 after manual settlement (got ${aliceNonce})`, env);
  console.log(`  Hub<>Alice nonce=${aliceNonce}`);
  for (const user of [bob, charlie, dave]) {
    const nonce = hubFinal.accounts.get(user.id)?.state.jNonce || 0;
    console.log(`  Hub<>${user.name} nonce=${nonce}`);
  }

  // Workspace cleanup: all should be cleared
  for (const user of users) {
    const acc = hubFinal.accounts.get(user.id);
    assert(!acc?.state.settlementWorkspace, `Hub<>${user.name} workspace should be cleared (got ${acc?.state.settlementWorkspace?.status})`, env);
  }

  // Counterparty nonce check mirrors hub side.
  const [, aliceReplica] = findReplica(env, alice.id);
  const aliceAcc = aliceReplica.state.accounts.get(hub.id);
  assert((aliceAcc?.state.jNonce || 0) >= 1, `Alice<>Hub nonce should be >= 1 after manual settlement`, env);
  assert(!aliceAcc?.state.settlementWorkspace, `Alice<>Hub workspace should be cleared`, env);
  for (const user of [bob, charlie, dave]) {
    const [, userReplica] = findReplica(env, user.id);
    const userAcc = userReplica.state.accounts.get(hub.id);
    const hubNonce = hubFinal.accounts.get(user.id)?.state.jNonce || 0;
    const userNonce = userAcc?.state.jNonce || 0;
    assert(
      userNonce === hubNonce,
      `${user.name}<>Hub counterparty nonce should match hub view (user=${userNonce}, hub=${hubNonce})`,
      env,
    );
    assert(!userAcc?.state.settlementWorkspace, `${user.name}<>Hub workspace should be cleared`, env);
  }

  // Final state summary
  const hubFinalReserve = hubFinal.reserves.get(USDC) || 0n;
  console.log(`\n  Hub reserve: $${hubFinalReserve / usd(1)}`);
  for (const user of users) {
    const delta = hubFinal.accounts.get(user.id)?.state.deltas.get(USDC);
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const derived = delta ? deriveDelta(delta, hubIsLeft) : null;
    const nonce = hubFinal.accounts.get(user.id)?.state.jNonce || 0;
    console.log(`  Hub<>${user.name}: collateral=${delta?.collateral}, outCol=${derived?.outCollateral}, nonce=${nonce}`);
  }

  console.log('\n--- TEST 7 PASSED ---');

  // ══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('  ALL SETTLE + REBALANCE TESTS PASSED');
  console.log('='.repeat(80) + '\n');

  return env;
  } finally {
    try {
      await jadapter.close();
    } finally {
      cleanupStrictMode();
      console.log = originalLog;
    }
  }
}
