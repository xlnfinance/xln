/**
 * Multi-Edge Rebalance Scenario (R→C + C→R)
 *
 * Hub + Alice + Bob + Charlie + Dave
 * After payments create imbalances, users auto-queue request_collateral.
 * Hub crontab can perform:
 * - direct R→C deposits for net receivers
 * - C→R settlement pullbacks for excess collateral
 *
 * Critical trigger invariant:
 * request_collateral is triggered by outPeerCredit >= r2cRequestSoftLimit (deriveDelta),
 * NOT by (outCollateral + outPeerCredit).
 * outCollateral is already secured value and must not inflate trigger metric.
 */

import type { RuntimeReplica } from '../../runtime/types';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import type { AccountState } from '../../types/account';
import {
  getProcess,
  usd,
  ensureSignerKeysFromSeed,
  converge,
  findReplica,
  processJEvents,
  setScenarioStorageEnabled,
  enableStrictScenario,
} from '../harness/helpers';
import { formatRuntime } from '../../qa/runtime-ascii';
import { deriveDelta } from '../../account/utils';
import { isLeftEntity } from '../../entity/id';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import { startRuntimeTraceForTesting } from '../../runtime/observability/runtime-trace';
import type { SentJBatch } from '../../jurisdiction/machine/batch';
import {
  bindScenarioJReplica,
  createJurisdictionConfig,
  ensureJAdapter,
  getJAdapterMode,
  registerEntities,
  resolveScenarioJurisdictionAddress,
} from '../harness/boot';

const USDC_TOKEN_ID = 1;
const HUB_INITIAL_RESERVE = usd(200_000); // $200K
const USER_RESERVE = usd(25_000); // $25K each
const INITIAL_COLLATERAL = usd(500); // Exact default C→R keep threshold; payments create the later imbalance.

function assert(condition: unknown, message: string, env?: RuntimeReplica): asserts condition {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 5 }));
    }
    throw new Error(`ASSERT: ${message}`);
  }
}

type Entity = { id: string; signer: string; name: string };

const requireEntity = (entity: Entity | undefined, name: string): Entity => {
  if (!entity) {
    throw new Error(`REBALANCE_SCENARIO_MISSING_ENTITY:${name}`);
  }
  return entity;
};

const convergeScenario = (env: RuntimeReplica, maxCycles = 15) => converge(env, maxCycles);

type AccountJProgress = {
  lastFinalizedJHeight: number;
  pendingClaimCount: bigint;
};

function snapshotAccountJProgress(account: AccountState | undefined): AccountJProgress {
  return {
    lastFinalizedJHeight: account?.lastFinalizedJHeight || 0,
    pendingClaimCount: (account?.leftPendingJClaims.count ?? 0n) + (account?.rightPendingJClaims.count ?? 0n),
  };
}

export async function runRebalanceScenario(env: RuntimeReplica): Promise<RuntimeReplica> {
  console.log('\n' + '═'.repeat(80));
  console.log('  MULTI-EDGE REBALANCE SCENARIO');
  console.log('  Hub + Alice + Bob + Charlie + Dave');
  console.log('  Direct R→C collateral top-up from user requests');
  console.log('═'.repeat(80));

  const process = await getProcess();

  // ══════════════════════════════════════════════════════════════
  // SETUP: JAdapter (BrowserVM or RPC)
  // ══════════════════════════════════════════════════════════════
  const jMode = getJAdapterMode();
  const rpcUrl = resolveScenarioJurisdictionAddress(jMode);
  const transportLabel = jMode === 'browservm' ? 'browservm' : `rpc → ${rpcUrl}`;
  console.log(`\n📦 Setting up JAdapter (${transportLabel})...`);

  env.state.timestamp = 1000000;
  env.scenarioMode = true;
  setScenarioStorageEnabled(env, false);
  const restoreStrict = enableStrictScenario(env, 'rebalance');

  ensureSignerKeysFromSeed(env, ['2','3','4','5','6'], 'rebalance');

  // Create JAdapter + deploy contracts via shared boot path
  const jadapter = await ensureJAdapter(env, jMode, { deployStack: true });
  console.log(`✅ JAdapter created, depository: ${jadapter.addresses.depository}`);

  // Create jReplica + attach jadapter
  const jReplicaName = 'Rebalance Demo';
  const jReplica = {
    name: jReplicaName,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 100,
    lastBlockTimestamp: env.state.timestamp,
    position: { x: 0, y: 600, z: 0 },
    contracts: {
      account: jadapter.addresses.account,
      depository: jadapter.addresses.depository,
      entityProvider: jadapter.addresses.entityProvider,
      deltaTransformer: jadapter.addresses.deltaTransformer,
    },
    rpcs: [jMode === 'browservm' ? 'browservm://' : rpcUrl],
  };
  env.state.jReplicas.set(jReplicaName, jReplica);
  env.activeJurisdiction = jReplicaName;

  // Attach the same trusted local policy used by Runtime jurisdiction import.
  bindScenarioJReplica(env, jReplica, jadapter);
  jadapter.startWatching(env);
  console.log('✅ JAdapter attached + watching');

  // Jurisdiction config for entity creation
  const jurisdictionConfig = createJurisdictionConfig(
    jReplicaName,
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
    resolveScenarioJurisdictionAddress(jMode),
  );

  // ══════════════════════════════════════════════════════════════
  // CREATE 5 ENTITIES: Hub, Alice, Bob, Charlie, Dave
  // ══════════════════════════════════════════════════════════════
  console.log('\n📦 Creating 5 entities...');

  const entityNames = ['Hub', 'Alice', 'Bob', 'Charlie', 'Dave'] as const;
  const entities: Entity[] = await registerEntities(
    env,
    jadapter,
    entityNames.map((name, index) => ({
      name,
      signer: String(index + 2),
      position: { x: 0, y: 0, z: 0 },
    })),
    jurisdictionConfig,
  );
  const hub = requireEntity(entities[0], 'Hub');
  const alice = requireEntity(entities[1], 'Alice');
  const bob = requireEntity(entities[2], 'Bob');
  const charlie = requireEntity(entities[3], 'Charlie');
  const dave = requireEntity(entities[4], 'Dave');
  const users = [alice, bob, charlie, dave];
  console.log(`✅ Created: ${entities.map(e => e.name).join(', ')}`);

  // ══════════════════════════════════════════════════════════════
  // FUND HUB + USERS via debugFundReserves (on-chain)
  // ══════════════════════════════════════════════════════════════
  console.log('\n💰 Funding Hub and users via on-chain debugFundReserves...');

  // Helper: poll on-chain events and feed into runtime
  const syncChain = async () => {
    env.state.timestamp += 150;
    await process(env);
    await processJEvents(env);
    await process(env);
  };

  const waitForHubCollateral = async (counterpartyId: string, expected: bigint, label: string, maxRounds = 20): Promise<void> => {
    for (let i = 0; i < maxRounds; i++) {
      const current =
        findReplica(env, hub.id)[1].state.accounts.get(counterpartyId)?.state.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
      if (current === expected) return;
      await syncChain();
      await convergeScenario(env);
    }
    const current =
      findReplica(env, hub.id)[1].state.accounts.get(counterpartyId)?.state.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
    assert(current === expected, `${label}: ${current}, expected ${expected}`, env);
  };

  // Fund Hub with $200K via debugFundReserves (mints directly into depository)
  await jadapter.debugFundReserves(hub.id, USDC_TOKEN_ID, HUB_INITIAL_RESERVE);
  // Fund each user with $25K
  for (const user of users) {
    await jadapter.debugFundReserves(user.id, USDC_TOKEN_ID, USER_RESERVE);
  }
  await syncChain(); // Poll all ReserveUpdated events at once

  // Verify reserves (Hub: $200K)
  const hubReserve = findReplica(env, hub.id)[1].state.reserves.get(USDC_TOKEN_ID) || 0n;
  assert(hubReserve === HUB_INITIAL_RESERVE, `Hub reserve wrong: ${hubReserve}, expected ${HUB_INITIAL_RESERVE}`, env);
  console.log(`✅ Funding complete: Hub=$${hubReserve / usd(1_000)}K, Users=$${USER_RESERVE / usd(1_000)}K each`);

  // ══════════════════════════════════════════════════════════════
  // OPEN BILATERAL ACCOUNTS (each user ↔ Hub)
  // ══════════════════════════════════════════════════════════════
  console.log('\n🔗 Opening bilateral accounts...');

  for (const user of users) {
    await process(env, [{
      entityId: user.id,
      signerId: user.signer,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: hub.id,
          disputeConfig: defaultAccountDisputeConfigForParties(user.id, false, hub.id, true),
          tokenId: USDC_TOKEN_ID,
          creditAmount: 0n,
          // Disable automatic R→C during setup. Bob and Dave explicitly opt in
          // after the payments create their unsecured exposure below.
          rebalancePolicy: {
            r2cRequestSoftLimit: usd(20_000),
            hardLimit: usd(20_000),
            maxAcceptableFee: usd(100),
          },
        }
      }]
    }]);
    await process(env); // Hub receives and creates account
  }
  await convergeScenario(env);

  // Verify accounts exist
  const hubState = findReplica(env, hub.id)[1].state;
  for (const user of users) {
    assert(hubState.accounts.has(user.id), `Hub↔${user.name} account missing`, env);
  }
  console.log('✅ All bilateral accounts created');

  // Set hub policy before payment flow so user-side auto-rebalance can price requests from hub config.
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'setHubConfig',
      data: {
        matchingStrategy: 'amount',
        routingFeePPM: 1,
        baseFee: 0n,
        minCollateralThreshold: 0n,
        rebalanceLiquidityFeeBps: 1n,
        rebalanceTimeoutMs: 10 * 60 * 1000,
      },
    }],
  }]);
  await convergeScenario(env);

  // ══════════════════════════════════════════════════════════════
  // EXTEND CREDIT: Hub extends credit to all users
  // ══════════════════════════════════════════════════════════════
  console.log('\n💳 Hub extending credit to all users...');

  for (const user of users) {
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: user.id,
          tokenId: USDC_TOKEN_ID,
          amount: usd(50_000),
        }
      }]
    }]);
    await process(env); // Counterparty receives + ACKs
    await process(env); // Hub commits frame
    await process(env); // Extra tick for delivery
  }
  console.log('✅ Hub extended $50K credit to all users');

  // Users extend credit back to Hub (so Hub can route payments through them)
  console.log('\n💳 Users extending credit to Hub...');
  for (const user of users) {
    await process(env, [{
      entityId: user.id,
      signerId: user.signer,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: hub.id,
          tokenId: USDC_TOKEN_ID,
          amount: usd(50_000),
        }
      }]
    }]);
    await process(env);
    await process(env);
    await process(env);
  }
  console.log('✅ Users extended $50K credit to Hub');

  // ══════════════════════════════════════════════════════════════
  // INITIAL R→C: Deposit $500 collateral per account
  // ══════════════════════════════════════════════════════════════
  console.log('\n🏦 Depositing initial collateral ($500 per account)...');

  const r2cTxs = users.map(user => ({
    type: 'r2c' as const,
    data: {
      counterpartyId: user.id,
      tokenId: USDC_TOKEN_ID,
      amount: INITIAL_COLLATERAL,
    }
  }));

  // Step 1: r2c for all 4 accounts
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: r2cTxs,
  }]);

  // Step 2: broadcast (separate tick)
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{ type: 'j_broadcast' as const, data: {} }],
  }]);

  // Step 3: J-processor → on-chain tx → poll events
  env.state.timestamp += 150;
  await process(env); // J-processor fires batch
  await syncChain();  // Poll events + process
  await convergeScenario(env);

  // Wait for the finalized AccountSettled J-events to land in bilateral state before asserting.
  // The on-chain R→C batch can be mined before the runtime ingests and finalizes its resulting J-events.
  for (const user of users) {
    await waitForHubCollateral(user.id, INITIAL_COLLATERAL, `${user.name} collateral`);
  }
  console.log('✅ All accounts have $500 collateral');

  // ══════════════════════════════════════════════════════════════
  // PAYMENTS: Create imbalances via atomic HTLC payments (entity-level)
  // Alice→Hub→Bob: $8K (Hub gains $8K from Alice, owes $8K to Bob)
  // Charlie→Hub→Dave: $12K (Hub gains $12K from Charlie, owes $12K to Dave)
  // After: source accounts become over-collateralized while Bob and Dave need R→C top-ups.
  // ══════════════════════════════════════════════════════════════
  console.log('\n💸 Creating payment imbalances...');

  // Alice → Bob $8K atomically through Hub
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'htlcPayment',
      data: {
        targetEntityId: bob.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(8_000),
        maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [alice.id, hub.id, bob.id], USDC_TOKEN_ID, usd(8_000)).senderLockAmount,
        route: [alice.id, hub.id, bob.id],
        deliveryMode: 'instant',
        description: 'Alice→Hub→Bob $8K',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await convergeScenario(env);

  // Charlie → Dave $12K atomically through Hub
  await process(env, [{
    entityId: charlie.id,
    signerId: charlie.signer,
    entityTxs: [{
      type: 'htlcPayment',
      data: {
        targetEntityId: dave.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(12_000),
        maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [charlie.id, hub.id, dave.id], USDC_TOKEN_ID, usd(12_000)).senderLockAmount,
        route: [charlie.id, hub.id, dave.id],
        deliveryMode: 'instant',
        description: 'Charlie→Hub→Dave $12K',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await convergeScenario(env);

  // Freeze evidence before automatic R→C is enabled. Any later collateral
  // growth must come from Bob/Dave's explicit policy transition.
  console.log('\n📊 Verifying user-side unsecured exposure...');
  const hubAfterPayments = findReplica(env, hub.id)[1].state;
  const collateralBeforeRebalance = new Map<string, bigint>();
  const preRebalanceJProgress = new Map<string, { hub: AccountJProgress; user: AccountJProgress }>();
  const expectedRebalanceUserIds = new Set([bob.id, dave.id]);

  for (const user of users) {
    const hubAccount = hubAfterPayments.accounts.get(user.id);
    const delta = hubAccount?.state.deltas.get(USDC_TOKEN_ID);
    assert(!!hubAccount && !!delta, `Missing Hub↔${user.name} balance before rebalance`, env);
    const [, userReplica] = findReplica(env, user.id);
    const userAccount = userReplica.state.accounts.get(hub.id);
    collateralBeforeRebalance.set(user.id, delta!.collateral);
    preRebalanceJProgress.set(user.id, {
      hub: snapshotAccountJProgress(hubAccount!.state),
      user: snapshotAccountJProgress(userAccount?.state),
    });

    const userView = deriveDelta(delta!, isLeftEntity(user.id, hub.id));
    const totalExposure = userView.outCollateral + userView.outPeerCredit;
    console.log(
      `  ${user.name}↔Hub: totalExposure=${totalExposure}, secured=${userView.outCollateral}, unsecured=${userView.outPeerCredit}`,
    );
    if (expectedRebalanceUserIds.has(user.id)) {
      assert(
        userView.outPeerCredit >= usd(1_000),
        `${user.name} must exceed the automatic R→C threshold (got ${userView.outPeerCredit})`,
        env,
      );
    }
  }

  const batchNonceBeforeRebalance = hubAfterPayments.jBatchState?.entityNonce ?? 0;
  const rebalanceTrace = startRuntimeTraceForTesting(env);

  // ══════════════════════════════════════════════════════════════
  // REBALANCE POLICIES: Users set their own (CRITICAL-3: auth)
  // r2cRequestSoftLimit = trigger when uncollateralized credit >= this
  // After payments: Hub↔Bob unsecured = $7.5K, Hub↔Dave = $11.5K.
  // r2cRequestSoftLimit=$1K → both trigger.
  // ══════════════════════════════════════════════════════════════
  console.log('\n📋 Users setting rebalance policies...');
  for (const user of [bob, dave]) {
    await process(env, [{
      entityId: user.id,
      signerId: user.signer,
      entityTxs: [{
        type: 'setRebalancePolicy',
        data: {
          counterpartyEntityId: hub.id,
          tokenId: USDC_TOKEN_ID,
          r2cRequestSoftLimit: usd(1_000),       // Trigger when unsecured credit reaches $1K
          hardLimit: usd(20_000),      // Max threshold
          maxAcceptableFee: usd(100),  // Auto-accept fees up to $100
        }
      }]
    }]);
    await process(env); // Hub receives frame
    await process(env); // ACK
    await process(env); // Extra round
  }
  await convergeScenario(env);
  console.log('✅ Rebalance policies set by Bob + Dave');

  const hubConfigSet = findReplica(env, hub.id)[1].state.hubRebalanceConfig;
  assert(hubConfigSet, 'Hub config not set', env);

  // ══════════════════════════════════════════════════════════════
  // REBALANCE: Multi-cycle hub crontab (direct R→C only)
  //
  // Cycle 1: users' request_collateral frames are delivered/committed.
  // Cycle 2: hub crontab consumes prepaid requests and broadcasts immediately.
  // ══════════════════════════════════════════════════════════════
  console.log('\n🔄 Running rebalance cycles...');
  // Entity timestamps advance only through committed frames.
  function advanceTime(ms: number) {
    env.state.timestamp += ms;
  }

  // ── Cycle 1: Trigger hub crontab and process bilateral frames ──
  advanceTime(3100);
  console.log('\n  [Cycle 1] Hub crontab + bilateral processing...');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [] // Ping to trigger crontab
  }]);

  // Process bilateral frames (request_collateral delivery + ACK/commit)
  for (let i = 0; i < 30; i++) {
    advanceTime(100);
    await process(env);
  }
  await convergeScenario(env);

  // Debug: Check state after Cycle 1
  console.log('\n  [After Cycle 1] State:');
  let pendingRequestedTotal = 0n;
  for (const user of users) {
    const acc = findReplica(env, hub.id)[1].state.accounts.get(user.id);
    if (!acc) continue;
    const ws = acc.state.settlementWorkspace;
    const requested = acc.state.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
    pendingRequestedTotal += requested;
    console.log(`    Hub↔${user.name}: ws=${ws?.status || 'none'}, requested=${requested}`);
  }
  if (pendingRequestedTotal === 0n) {
    console.log('  ℹ️ No pending requests after cycle 1 (may have been consumed quickly)');
  }

  // ── Cycle 2: Hub crontab deposits R→C and broadcasts immediately ──
  advanceTime(3100);
  console.log('\n  [Cycle 2] Hub crontab: deposit + broadcast...');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [] // Ping to trigger crontab
  }]);

  // Process bilateral frames + local queues
  for (let i = 0; i < 30; i++) {
    advanceTime(100);
    await process(env);
  }
  await convergeScenario(env);

  // Let watcher + bilateral j_event_claim consensus finalize AccountSettled on both sides.
  for (let i = 0; i < 6; i++) {
    advanceTime(350);
    await process(env);
    await syncChain();
    await convergeScenario(env);
  }

  let hubAfterBroadcast = findReplica(env, hub.id)[1].state;
  const batchNonceAfterCycle2 = hubAfterBroadcast.jBatchState?.entityNonce ?? 0;
  const rebalanceExecuted = batchNonceAfterCycle2 > batchNonceBeforeRebalance;
  assert(rebalanceExecuted, 'Expected the automatic R→C batch to advance the hub Entity nonce', env);
  assert(
    !hubAfterBroadcast.jBatchState?.sentBatch,
    'Expected hub sentBatch cleared after confirmed broadcast processing',
    env,
  );

  const getRebalanceTargets = (state: typeof hubAfterBroadcast) =>
    [alice.id, bob.id, charlie.id, dave.id].filter(userId => {
      const after = state.accounts.get(userId)?.state.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
      const before = collateralBeforeRebalance.get(userId) ?? INITIAL_COLLATERAL;
      return after > before;
    });
  let rebalanceTargetUserIds = getRebalanceTargets(hubAfterBroadcast);
  if (rebalanceTargetUserIds.length === 0) {
    // Race guard: confirmed batch can precede local bilateral j-event apply by one tick.
    await syncChain();
    await convergeScenario(env);
    hubAfterBroadcast = findReplica(env, hub.id)[1].state;
    rebalanceTargetUserIds = getRebalanceTargets(hubAfterBroadcast);
  }
  assert(
    rebalanceTargetUserIds.length === expectedRebalanceUserIds.size &&
      rebalanceTargetUserIds.every(userId => expectedRebalanceUserIds.has(userId)),
    `Expected only Bob + Dave to be collateralized by auto-rebalance (got ${rebalanceTargetUserIds.map(id => id.slice(-4)).join(',')})`,
    env,
  );

  const traceLogs = rebalanceTrace.snapshots.flatMap(snapshot => snapshot.logs ?? []);
  const requestedByUser = new Map<string, bigint>();
  for (const user of [bob, dave]) {
    const receipts = traceLogs.filter(log => {
      const data = (log.data ?? {}) as Record<string, unknown>;
      return log.message === 'request_collateral_committed' &&
        String(data['entityId'] ?? '').toLowerCase() === user.id.toLowerCase() &&
        String(data['accountId'] ?? '').toLowerCase() === hub.id.toLowerCase() &&
        Number(data['tokenId']) === USDC_TOKEN_ID;
    });
    assert(receipts.length === 1, `${user.name} must commit exactly one collateral request (got ${receipts.length})`, env);
    const requestedAmount = BigInt(String(receipts[0]!.data?.['requestedAmount'] ?? '0'));
    assert(requestedAmount > 0n, `${user.name} committed request amount must be positive`, env);
    requestedByUser.set(user.id, requestedAmount);
  }

  // Assert both sides finalized j-events for each account whose collateral increased.
  for (const userId of rebalanceTargetUserIds) {
    const hubAcc = hubAfterBroadcast.accounts.get(userId);
    const [, userReplica] = findReplica(env, userId);
    const userAcc = userReplica.state.accounts.get(hub.id);

    const hubPost = snapshotAccountJProgress(hubAcc?.state);
    const userPost = snapshotAccountJProgress(userAcc?.state);
    const pre = preRebalanceJProgress.get(userId);
    assert(!!pre, `Missing pre-rebalance J-progress snapshot for ${userId.slice(-4)}`, env);
    const preHub = pre!.hub;
    const preUser = pre!.user;

    assert(
      hubPost.lastFinalizedJHeight > 0,
      `Expected hub-side lastFinalizedJHeight > 0 for ${userId.slice(-4)} (got ${hubPost.lastFinalizedJHeight})`,
      env,
    );
    assert(
      userPost.lastFinalizedJHeight > 0,
      `Expected user-side lastFinalizedJHeight > 0 for ${userId.slice(-4)} (got ${userPost.lastFinalizedJHeight})`,
      env,
    );
    assert(
      hubPost.lastFinalizedJHeight > preHub.lastFinalizedJHeight,
      `Expected hub-side jHeight growth for ${userId.slice(-4)} (before=${preHub.lastFinalizedJHeight}, after=${hubPost.lastFinalizedJHeight})`,
      env,
    );
    assert(
      userPost.lastFinalizedJHeight > preUser.lastFinalizedJHeight,
      `Expected user-side jHeight growth for ${userId.slice(-4)} (before=${preUser.lastFinalizedJHeight}, after=${userPost.lastFinalizedJHeight})`,
      env,
    );
    assert(
      hubPost.lastFinalizedJHeight === userPost.lastFinalizedJHeight,
      `Expected bilateral jHeight equality for ${userId.slice(-4)} (hub=${hubPost.lastFinalizedJHeight}, user=${userPost.lastFinalizedJHeight})`,
      env,
    );

    const hubCollateralAfter = hubAcc?.state.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n;
    const userCollateralAfter = userAcc?.state.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n;
    const collateralBefore = collateralBeforeRebalance.get(userId) ?? 0n;
    const requestedAmount = requestedByUser.get(userId) ?? 0n;

    assert(
      hubCollateralAfter === collateralBefore + requestedAmount,
      `Expected exact hub-side R→C amount for ${userId.slice(-4)} (before=${collateralBefore}, requested=${requestedAmount}, after=${hubCollateralAfter})`,
      env,
    );
    assert(
      userCollateralAfter === collateralBefore + requestedAmount,
      `Expected exact user-side R→C amount for ${userId.slice(-4)} (before=${collateralBefore}, requested=${requestedAmount}, after=${userCollateralAfter})`,
      env,
    );
    assert(
      hubCollateralAfter === userCollateralAfter,
      `Expected bilateral collateral sync for ${userId.slice(-4)} (hub=${hubCollateralAfter}, user=${userCollateralAfter})`,
      env,
    );

    assert(
      hubPost.pendingClaimCount === 0n && userPost.pendingClaimCount === 0n,
      `Expected no pending J-claims for ${userId.slice(-4)} (hub=${hubPost.pendingClaimCount}, user=${userPost.pendingClaimCount})`,
      env,
    );
  }

  // ══════════════════════════════════════════════════════════════
  // FINAL STATE + ASSERTIONS
  // ══════════════════════════════════════════════════════════════
  console.log('\n✅ Final state:');

  let hubFinal = findReplica(env, hub.id)[1].state;
  const hubFinalReserve = hubFinal.reserves.get(USDC_TOKEN_ID) || 0n;

  console.log(`\n  Hub final reserve: $${hubFinalReserve / usd(1)}`);

  for (const user of users) {
    const acc = hubFinal.accounts.get(user.id);
    const delta = acc?.state.deltas.get(USDC_TOKEN_ID);
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const derived = delta ? deriveDelta(delta, hubIsLeft) : null;
    const unsecured = derived?.outPeerCredit ?? 0n;
    const hubOutCollateral = derived?.outCollateral ?? 0n;
    const hubExposure = hubOutCollateral + unsecured;
    const nonce = acc?.state.jNonce || 0;
    console.log(
      `  Hub↔${user.name}: delta=${derived?.delta ?? 0n}, outCollateral=${hubOutCollateral}, hubExposure=${hubExposure}, unsecured=${unsecured}, nonce=${nonce}, ws=${acc?.state.settlementWorkspace?.status || 'none'}`,
    );
  }

  // ── NONCE ASSERTIONS ──
  // Mixed rebalance may include C→R settlements, so nonce can increase.
  // Invariant: nonce is bilateral-equal for each account.
  for (const user of users) {
    const hubAcc = hubFinal.accounts.get(user.id);
    const hubNonce = hubAcc?.state.jNonce || 0;
    assert(hubNonce >= 0, `Hub↔${user.name} nonce must be non-negative (got ${hubNonce})`, env);
    const [, userReplica] = findReplica(env, user.id);
    const userAcc = userReplica.state.accounts.get(hub.id);
    const userNonce = userAcc?.state.jNonce || 0;
    assert(
      hubNonce === userNonce,
      `Hub↔${user.name} nonce must match counterparty view (hub=${hubNonce}, user=${userNonce})`,
      env,
    );
  }

  // ── WORKSPACE ASSERTIONS ──
  // For C→R path, workspace can legitimately remain at awaiting_counterparty
  // if user signature was not provided during this scenario.
  for (const user of users) {
    const acc = hubFinal.accounts.get(user.id);
    const ws = acc?.state.settlementWorkspace;
    if (ws) {
      assert(
        ws.status === 'awaiting_counterparty',
        `Hub↔${user.name} workspace should be awaiting_counterparty when present (got status=${ws.status})`,
        env,
      );
      assert(
        ws.ops.every(op => op.type === 'c2r'),
        `Hub↔${user.name} workspace should contain only c2r ops`,
        env,
      );
    }
  }

  // ── COLLATERAL + REQUEST LIFECYCLE ASSERTIONS ──
  let accountsWithTopUp = 0;
  for (const user of users) {
    const acc = hubFinal.accounts.get(user.id);
    const delta = acc?.state.deltas.get(USDC_TOKEN_ID);
    const before = collateralBeforeRebalance.get(user.id) ?? 0n;
    const after = delta?.collateral ?? 0n;
    if (after > before) accountsWithTopUp++;
    const pendingHub = acc?.state.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
    const initialRequest = requestedByUser.get(user.id) ?? 0n;
    if (initialRequest > 0n) {
      assert(
        pendingHub <= initialRequest,
        `requestedRebalance must be monotonically decreasing (hub side ${user.name}): initial=${initialRequest}, current=${pendingHub}`,
        env,
      );
    }
  }
  assert(accountsWithTopUp > 0, `Expected at least one account to receive collateral top-up, got ${accountsWithTopUp}`, env);

  // Counterparty side: workspace cleared, requestedRebalance converges.
  for (const user of users) {
    const [, userReplica] = findReplica(env, user.id);
    const userAcc = userReplica.state.accounts.get(hub.id);
    const userWs = userAcc?.state.settlementWorkspace;
    if (userWs) {
      assert(
        userWs.status === 'awaiting_counterparty',
        `${user.name}↔Hub workspace should be awaiting_counterparty when present (got status=${userWs?.status})`,
        env,
      );
      assert(
        userWs.ops.every(op => op.type === 'c2r'),
        `${user.name}↔Hub workspace should contain only c2r ops`,
        env,
      );
    }
    const pendingUser = userAcc?.state.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
    const initialRequest = requestedByUser.get(user.id) ?? 0n;
    if (initialRequest > 0n) {
      assert(
        pendingUser <= initialRequest,
        `requestedRebalance must be monotonically decreasing (user side ${user.name}): initial=${initialRequest}, current=${pendingUser}`,
        env,
      );
    }
  }

  const trackedRequestUserIds = new Set(Array.from(requestedByUser.keys()));
  const getPendingRequests = (): Array<{ userId: string; userName: string; hubPending: bigint; userPending: bigint }> => {
    const pending: Array<{ userId: string; userName: string; hubPending: bigint; userPending: bigint }> = [];
    const latestHub = findReplica(env, hub.id)[1].state;
    for (const user of users) {
      const hubAcc = latestHub.accounts.get(user.id);
      const [, userReplica] = findReplica(env, user.id);
      const userAcc = userReplica.state.accounts.get(hub.id);
      const hubPending = hubAcc?.state.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
      const userPending = userAcc?.state.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
      if (hubPending > 0n || userPending > 0n) {
        pending.push({ userId: user.id, userName: user.name, hubPending, userPending });
      }
    }
    return pending;
  };

  let pendingAfterBroadcast = getPendingRequests();
  if (pendingAfterBroadcast.length > 0) {
    console.log(`  ℹ️ Pending requestedRebalance remains after first top-up cycle; running clear cycles...`);
  }

  for (let cycle = 1; cycle <= 3 && pendingAfterBroadcast.length > 0; cycle++) {
    const beforeByUser = new Map<string, { userId: string; hubPending: bigint; userPending: bigint }>();
    for (const p of pendingAfterBroadcast) {
      beforeByUser.set(p.userName, { userId: p.userId, hubPending: p.hubPending, userPending: p.userPending });
    }

    advanceTime(3100);
    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [] }]);
    for (let i = 0; i < 6; i++) {
      advanceTime(350);
      await process(env);
      await syncChain();
      await convergeScenario(env);
    }

    const after = getPendingRequests();
    const afterByUser = new Map<string, { userId: string; hubPending: bigint; userPending: bigint }>();
    for (const p of after) {
      afterByUser.set(p.userName, { userId: p.userId, hubPending: p.hubPending, userPending: p.userPending });
    }

    for (const [userName, before] of beforeByUser.entries()) {
      const now = afterByUser.get(userName) || { userId: before.userId, hubPending: 0n, userPending: 0n };
      assert(
        now.hubPending <= before.hubPending,
        `clear-cycle ${cycle}: hub pending request must not increase for ${userName} (before=${before.hubPending}, after=${now.hubPending})`,
        env,
      );
      assert(
        now.userPending <= before.userPending,
        `clear-cycle ${cycle}: user pending request must not increase for ${userName} (before=${before.userPending}, after=${now.userPending})`,
        env,
      );
    }

    pendingAfterBroadcast = after;
  }

  const blockingPending = pendingAfterBroadcast.filter(p => trackedRequestUserIds.has(p.userId));
  assert(blockingPending.length === 0, 'Tracked requestedRebalance must clear after bilateral finality', env);
  assert(pendingAfterBroadcast.length === 0, 'No requestedRebalance may remain after the completed cycle', env);

  hubFinal = findReplica(env, hub.id)[1].state;
  const finalTraceLogs = rebalanceTrace.snapshots.flatMap(snapshot => snapshot.logs ?? []);
  const allRequestReceipts = finalTraceLogs.filter(log => {
    const data = (log.data ?? {}) as Record<string, unknown>;
    return log.message === 'request_collateral_committed' &&
      String(data['accountId'] ?? '').toLowerCase() === hub.id.toLowerCase() &&
      Number(data['tokenId']) === USDC_TOKEN_ID;
  });
  assert(allRequestReceipts.length === 2, `Expected only Bob + Dave collateral requests (got ${allRequestReceipts.length})`, env);

  const sentBatches = new Map<string, SentJBatch>();
  for (const snapshot of rebalanceTrace.snapshots) {
    const hubReplica = Array.from(snapshot.state.eReplicas.values()).find(
      replica => replica.entityId.toLowerCase() === hub.id.toLowerCase(),
    );
    const sent = hubReplica?.state.jBatchState?.sentBatch;
    if (sent) sentBatches.set(`${sent.batchHash.toLowerCase()}:${sent.entityNonce}`, sent);
  }
  const r2cPairs = Array.from(sentBatches.values()).flatMap(sent =>
    sent.batch.reserveToCollateral
      .filter(op => op.receivingEntity.toLowerCase() === hub.id.toLowerCase() && op.tokenId === USDC_TOKEN_ID)
      .flatMap(op => op.pairs.map(pair => ({ sent, pair }))),
  );
  assert(r2cPairs.length === 2, `Expected exactly two R→C legs across the full run (got ${r2cPairs.length})`, env);

  const matchedBatches = new Map<string, SentJBatch>();
  for (const [userId, requestedAmount] of requestedByUser) {
    const matches = r2cPairs.filter(({ pair }) =>
      pair.entity.toLowerCase() === userId.toLowerCase() && pair.amount === requestedAmount,
    );
    assert(matches.length === 1, `Expected one exact R→C leg for ${userId.slice(-4)} (got ${matches.length})`, env);
    const sent = matches[0]!.sent;
    matchedBatches.set(`${sent.batchHash.toLowerCase()}:${sent.entityNonce}`, sent);

    const hubAccount = hubFinal.accounts.get(userId);
    const [, userReplica] = findReplica(env, userId);
    const userAccount = userReplica.state.accounts.get(hub.id);
    const before = collateralBeforeRebalance.get(userId) ?? 0n;
    const expected = before + requestedAmount;
    const hubCollateral = hubAccount?.state.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n;
    const userCollateral = userAccount?.state.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n;
    assert(hubCollateral === expected, `Final hub collateral changed after exact R→C for ${userId.slice(-4)}`, env);
    assert(userCollateral === expected, `Final user collateral changed after exact R→C for ${userId.slice(-4)}`, env);
    const hubProgress = snapshotAccountJProgress(hubAccount?.state);
    const userProgress = snapshotAccountJProgress(userAccount?.state);
    assert(
      hubProgress.lastFinalizedJHeight === userProgress.lastFinalizedJHeight &&
        hubProgress.pendingClaimCount === 0n && userProgress.pendingClaimCount === 0n,
      `Final bilateral J state diverged for ${userId.slice(-4)}`,
      env,
    );
  }
  assert(typeof jadapter.hasProcessedBatch === 'function', 'JAdapter must expose exact batch receipt lookup', env);
  for (const sent of matchedBatches.values()) {
    const processed = await jadapter.hasProcessedBatch!(hub.id, sent.batchHash, BigInt(sent.entityNonce));
    assert(processed, `Missing exact HankoBatchProcessed for nonce ${sent.entityNonce}`, env);
  }
  rebalanceTrace.stop();
  console.log(`  ✅ Collateral assertions passed (accounts topped up: ${accountsWithTopUp}, rebalanceExecuted=yes)`);

  console.log('\n' + '═'.repeat(80));
  console.log('  REBALANCE SCENARIO COMPLETE');
  console.log('═'.repeat(80));

  // Cleanup
  await jadapter.close();
  restoreStrict();
  return env;
}
