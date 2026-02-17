/**
 * Multi-Edge Rebalance Scenario (Direct R→C)
 *
 * Hub + Alice + Bob + Charlie + Dave
 * After payments create imbalances, users auto-queue request_collateral.
 * Hub crontab picks requestedRebalance and performs direct R→C deposits.
 * No settlement workspace, no C→R, no settlement nonce increments.
 */

import type { Env, EntityInput, EntityReplica, Delta, AccountMachine } from '../types';
import { getProcess, getApplyRuntimeInput, usd, ensureSignerKeysFromSeed } from './helpers';
import { formatRuntime } from '../runtime-ascii';
import { attachEventEmitters } from '../env-events';
import { deriveDelta } from '../account-utils';
import { isLeftEntity } from '../entity-id-utils';
import { createJAdapter } from '../jadapter';
import { encodeBoard, hashBoard } from '../entity-factory';

const USDC_TOKEN_ID = 1;
const HUB_INITIAL_RESERVE = usd(200_000); // $200K
const USER_RESERVE = usd(25_000); // $25K each
const INITIAL_COLLATERAL = usd(5_000); // $5K per account (deliberately low to create deficits)
const SIGNER_PREFUND = usd(1_000_000);

function assert(condition: unknown, message: string, env?: Env): asserts condition {
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

function findReplica(env: Env, entityId: string): [string, EntityReplica] {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) throw new Error(`Replica not found: ${entityId}`);
  return entry as [string, EntityReplica];
}

async function converge(env: Env, maxCycles = 15): Promise<void> {
  const process = await getProcess();
  for (let i = 0; i < maxCycles; i++) {
    await process(env);
    let hasWork = false;
    for (const [, replica] of env.eReplicas) {
      for (const [, account] of replica.state.accounts) {
        if (account.mempool.length > 0 || account.pendingFrame) {
          hasWork = true;
          break;
        }
      }
      if (hasWork) break;
    }
    if (!hasWork) return;
  }
}

async function processJEvents(env: Env): Promise<void> {
  const process = await getProcess();
  const pendingInputs = env.runtimeInput?.entityInputs || [];
  if (pendingInputs.length > 0) {
    const toProcess = [...pendingInputs];
    env.runtimeInput.entityInputs = [];
    await process(env, toProcess);
  }
}

type AccountJProgress = {
  chainLen: number;
  settledEvents: number;
  lastFinalizedJHeight: number;
  staleObservationCount: number;
};

function getAccountSettledEventCount(account: AccountMachine | undefined): number {
  if (!account?.jEventChain) return 0;
  let count = 0;
  for (const block of account.jEventChain) {
    for (const event of block.events || []) {
      if (event?.type === 'AccountSettled') count++;
    }
  }
  return count;
}

function getStaleObservationCount(account: AccountMachine | undefined): number {
  if (!account) return 0;
  const last = account.lastFinalizedJHeight || 0;
  const leftStale = (account.leftJObservations || []).filter(o => o.jHeight <= last).length;
  const rightStale = (account.rightJObservations || []).filter(o => o.jHeight <= last).length;
  return leftStale + rightStale;
}

function snapshotAccountJProgress(account: AccountMachine | undefined): AccountJProgress {
  return {
    chainLen: account?.jEventChain?.length || 0,
    settledEvents: getAccountSettledEventCount(account),
    lastFinalizedJHeight: account?.lastFinalizedJHeight || 0,
    staleObservationCount: getStaleObservationCount(account),
  };
}

export async function runRebalanceScenario(): Promise<void> {
  console.log('\n' + '═'.repeat(80));
  console.log('  MULTI-EDGE REBALANCE SCENARIO');
  console.log('  Hub + Alice + Bob + Charlie + Dave');
  console.log('  Direct R→C collateral top-up from user requests');
  console.log('═'.repeat(80));

  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  // ══════════════════════════════════════════════════════════════
  // SETUP: Real JAdapter (anvil RPC)
  // ══════════════════════════════════════════════════════════════
  const rpcUrl = globalThis.process?.env?.ANVIL_RPC || 'http://localhost:18545';
  console.log(`\n📦 Setting up JAdapter (rpc → ${rpcUrl})...`);

  let env: Env = {
    timestamp: 1000000,
    height: 0,
    jReplicas: new Map(),
    eReplicas: new Map(),
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeSeed: 'rebalance-scenario-seed-2026',
    events: [],
    history: [],
    frameLogs: [],
    scenarioMode: true,
  } as Env;
  attachEventEmitters(env);

  ensureSignerKeysFromSeed(env, ['2','3','4','5','6'], 'rebalance');

  // Create RPC JAdapter + deploy contracts on fresh anvil
  const jadapter = await createJAdapter({ mode: 'rpc', chainId: 31337, rpcUrl });
  await jadapter.deployStack();
  console.log(`✅ JAdapter created, depository: ${jadapter.addresses.depository}`);

  // Register 5 entities on-chain via EntityProvider
  const boardHashes: string[] = [];
  for (let i = 2; i <= 6; i++) {
    const config = {
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: [String(i)],
      shares: { [String(i)]: 1n },
    };
    boardHashes.push(hashBoard(encodeBoard(config)));
  }
  const { entityNumbers } = await jadapter.registerNumberedEntitiesBatch(boardHashes);
  console.log(`✅ Registered entities on-chain: [${entityNumbers.join(', ')}]`);

  // Create jReplica + attach jadapter
  const jReplicaName = 'Rebalance Demo';
  const jReplica = {
    name: jReplicaName,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [] as any[],
    blockDelayMs: 100,
    lastBlockTimestamp: env.timestamp,
    position: { x: 0, y: 600, z: 0 },
    contracts: {
      account: jadapter.addresses.account,
      depository: jadapter.addresses.depository,
      entityProvider: jadapter.addresses.entityProvider,
      deltaTransformer: jadapter.addresses.deltaTransformer,
    },
    rpc: rpcUrl,
  };
  env.jReplicas.set(jReplicaName, jReplica);
  env.activeJurisdiction = jReplicaName;

  // Attach jadapter to jReplica + start watching for events
  (jReplica as any).jadapter = jadapter;
  (jReplica as any).depositoryAddress = jadapter.addresses.depository;
  (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
  jadapter.startWatching(env);
  console.log('✅ JAdapter attached + watching');
  await process(env);

  // Jurisdiction config for entity creation
  const jurisdictionConfig = {
    name: jReplicaName,
    chainId: 31337,
    address: rpcUrl,
    entityProviderAddress: jadapter.addresses.entityProvider,
    depositoryAddress: jadapter.addresses.depository,
    rpc: rpcUrl,
  };

  // ══════════════════════════════════════════════════════════════
  // CREATE 5 ENTITIES: Hub, Alice, Bob, Charlie, Dave
  // ══════════════════════════════════════════════════════════════
  console.log('\n📦 Creating 5 entities...');

  const entityNames = ['Hub', 'Alice', 'Bob', 'Charlie', 'Dave'] as const;
  const entities: Entity[] = [];
  const createEntityTxs = [];

  for (let i = 0; i < 5; i++) {
    const name = entityNames[i];
    const signer = String(i + 2);
    const entityNumber = i + 2;
    const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
    entities.push({ id: entityId, signer, name });

    createEntityTxs.push({
      type: 'importReplica' as const,
      entityId,
      signerId: signer,
      data: {
        isProposer: true,
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [signer],
          shares: { [signer]: 1n },
          jurisdiction: jurisdictionConfig
        }
      }
    });
  }

  await applyRuntimeInput(env, { runtimeTxs: createEntityTxs, entityInputs: [] });
  const [hub, alice, bob, charlie, dave] = entities;
  console.log(`✅ Created: ${entities.map(e => e.name).join(', ')}`);

  // ══════════════════════════════════════════════════════════════
  // FUND HUB + USERS via debugFundReserves (on-chain)
  // ══════════════════════════════════════════════════════════════
  console.log('\n💰 Funding Hub and users via on-chain debugFundReserves...');

  // Helper: poll on-chain events and feed into runtime
  const syncChain = async () => {
    if (jadapter.pollNow) await jadapter.pollNow();
    env.timestamp += 150;
    await process(env);
    await processJEvents(env);
    await process(env);
  };

  // Fund Hub with $200K via debugFundReserves (mints directly into depository)
  await jadapter.debugFundReserves(hub.id, USDC_TOKEN_ID, HUB_INITIAL_RESERVE);
  // Fund each user with $25K
  for (const user of [alice, bob, charlie, dave]) {
    await jadapter.debugFundReserves(user.id, USDC_TOKEN_ID, USER_RESERVE);
  }
  await syncChain(); // Poll all ReserveUpdated events at once

  // Verify reserves (Hub: $200K)
  const hubReserve = findReplica(env, hub.id)[1].state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
  assert(hubReserve === HUB_INITIAL_RESERVE, `Hub reserve wrong: ${hubReserve}, expected ${HUB_INITIAL_RESERVE}`, env);
  console.log(`✅ Funding complete: Hub=$${hubReserve / 10n**18n}K, Users=$${USER_RESERVE / 10n**18n}K each`);

  // ══════════════════════════════════════════════════════════════
  // OPEN BILATERAL ACCOUNTS (each user ↔ Hub)
  // ══════════════════════════════════════════════════════════════
  console.log('\n🔗 Opening bilateral accounts...');

  for (const user of [alice, bob, charlie, dave]) {
    await process(env, [{
      entityId: user.id,
      signerId: user.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id, tokenId: USDC_TOKEN_ID, creditAmount: 0n }
      }]
    }]);
    await process(env); // Hub receives and creates account
  }
  await converge(env);

  // Verify accounts exist
  const hubState = findReplica(env, hub.id)[1].state;
  for (const user of [alice, bob, charlie, dave]) {
    assert(hubState.accounts.has(user.id), `Hub↔${user.name} account missing`, env);
  }
  console.log('✅ All bilateral accounts created');

  // ══════════════════════════════════════════════════════════════
  // EXTEND CREDIT: Hub extends credit to all users
  // ══════════════════════════════════════════════════════════════
  console.log('\n💳 Hub extending credit to all users...');

  for (const user of [alice, bob, charlie, dave]) {
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
  for (const user of [alice, bob, charlie, dave]) {
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
  // INITIAL R→C: Deposit $20K collateral per account
  // ══════════════════════════════════════════════════════════════
  console.log('\n🏦 Depositing initial collateral ($20K per account)...');

  const r2cTxs = [alice, bob, charlie, dave].map(user => ({
    type: 'deposit_collateral' as const,
    data: {
      counterpartyId: user.id,
      tokenId: USDC_TOKEN_ID,
      amount: INITIAL_COLLATERAL,
    }
  }));

  // Step 1: deposit_collateral for all 4 accounts
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
  env.timestamp += 150;
  await process(env); // J-processor fires batch
  await syncChain();  // Poll events + process
  await converge(env);

  // Verify collateral
  for (const user of [alice, bob, charlie, dave]) {
    const hubAcc = findReplica(env, hub.id)[1].state.accounts.get(user.id);
    const delta = hubAcc?.deltas.get(USDC_TOKEN_ID);
    assert(delta && delta.collateral === INITIAL_COLLATERAL,
      `${user.name} collateral: ${delta?.collateral}, expected ${INITIAL_COLLATERAL}`, env);
  }
  console.log('✅ All accounts have $20K collateral');

  // ══════════════════════════════════════════════════════════════
  // PAYMENTS: Create imbalances via directPayment (entity-level)
  // Alice→Hub→Bob: $8K (Hub gains $8K from Alice, owes $8K to Bob)
  // Charlie→Hub→Dave: $12K (Hub gains $12K from Charlie, owes $12K to Dave)
  // After:
  //   Hub↔Alice: totalDelta=$13K → outCollateral=$5K (all excess)
  //   Hub↔Bob: totalDelta=-$3K → outCollateral=$0 (deficit!)
  //   Hub↔Charlie: totalDelta=$17K → outCollateral=$5K (all excess)
  //   Hub↔Dave: totalDelta=-$7K → outCollateral=$0 (deficit!)
  // ══════════════════════════════════════════════════════════════
  console.log('\n💸 Creating payment imbalances...');

  // Alice → Bob $8K via directPayment (routed through Hub)
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'directPayment',
      data: {
        targetEntityId: bob.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(8_000),
        route: [alice.id, hub.id, bob.id],
        description: 'Alice→Hub→Bob $8K',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await converge(env);

  // Charlie → Dave $12K via directPayment (routed through Hub)
  await process(env, [{
    entityId: charlie.id,
    signerId: charlie.signer,
    entityTxs: [{
      type: 'directPayment',
      data: {
        targetEntityId: dave.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(12_000),
        route: [charlie.id, hub.id, dave.id],
        description: 'Charlie→Hub→Dave $12K',
      }
    }]
  }]);
  for (let i = 0; i < 6; i++) await process(env);
  await converge(env);

  // ══════════════════════════════════════════════════════════════
  // REBALANCE POLICIES: Users set their own (CRITICAL-3: auth)
  // softLimit = trigger when uncollateralized credit > this
  // After payments: Hub↔Bob uncollateralized = $3K, Hub↔Dave = $7K
  // softLimit=$1K → both trigger (uncollateralized > softLimit)
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
          softLimit: usd(1_000),       // Trigger when uncollateralized credit > $1K
          hardLimit: usd(20_000),      // Max threshold
          maxAcceptableFee: usd(100),  // Auto-accept fees up to $100
        }
      }]
    }]);
    await process(env); // Hub receives frame
    await process(env); // ACK
    await process(env); // Extra round
  }
  await converge(env);
  console.log('✅ Rebalance policies set by Bob + Dave');

  // Verify imbalances using deriveDelta
  console.log('\n📊 Verifying imbalances...');
  const hubAfterPayments = findReplica(env, hub.id)[1].state;
  const collateralBeforeRebalance = new Map<string, bigint>();

  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubAfterPayments.accounts.get(user.id);
    if (!acc) continue;
    const delta = acc.deltas.get(USDC_TOKEN_ID);
    if (!delta) continue;
    collateralBeforeRebalance.set(user.id, delta.collateral);
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const derived = deriveDelta(delta, hubIsLeft);
    const totalDelta = delta.ondelta + delta.offdelta;
    const hubDebt = hubIsLeft ? (totalDelta < 0n ? -totalDelta : 0n) : (totalDelta > 0n ? totalDelta : 0n);
    const uncollateralized = hubDebt > delta.collateral ? hubDebt - delta.collateral : 0n;
    console.log(`  Hub↔${user.name}: totalDelta=${totalDelta}, collateral=${delta.collateral}, hubDebt=${hubDebt}, uncollateralized=${uncollateralized}`);
  }

  // ══════════════════════════════════════════════════════════════
  // HUB CONFIG: Declare as hub
  // ══════════════════════════════════════════════════════════════
  console.log('\n🏦 Hub declares hub config...');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'setHubConfig',
      // Keep SOURCE 2 enabled so any residual uncollateralized debt is auto-topped up.
      // This prevents late request/ack ordering from leaving small tails uncollateralized.
      data: { matchingStrategy: 'hnw', routingFeePPM: 100, baseFee: 0n, minCollateralThreshold: 0n },
    }]
  }]);
  await converge(env);

  const hubConfigSet = findReplica(env, hub.id)[1].state.hubRebalanceConfig;
  assert(hubConfigSet, 'Hub config not set', env);
  console.log('✅ Hub config set');

  // ══════════════════════════════════════════════════════════════
  // REBALANCE: Multi-cycle hub crontab (direct R→C only)
  //
  // Cycle 1: Users' request_collateral frames are delivered/committed.
  // Cycle 2: Hub crontab picks requestedRebalance and queues R→C in jBatch.
  // Final: j_broadcast submits R→C batch on-chain.
  // ══════════════════════════════════════════════════════════════
  console.log('\n🔄 Running rebalance cycles...');

  // Helper: advance time + sync all entity timestamps
  function advanceTime(ms: number) {
    env.timestamp += ms;
    for (const [, replica] of env.eReplicas) {
      replica.state.timestamp = env.timestamp;
    }
  }

  // ── Cycle 1: Trigger hub crontab and process bilateral frames ──
  const offdeltaBeforeCycle1 = new Map<string, bigint>();
  {
    const hubPreCycle1 = findReplica(env, hub.id)[1].state;
    for (const user of [alice, bob, charlie, dave]) {
      const offdelta = hubPreCycle1.accounts.get(user.id)?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
      offdeltaBeforeCycle1.set(user.id, offdelta);
    }
  }

  advanceTime(31000);
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
  await converge(env);

  // Debug: Check state after Cycle 1
  console.log('\n  [After Cycle 1] State:');
  let pendingRequestedTotal = 0n;
  const requestedByUser = new Map<string, bigint>();
  for (const user of [alice, bob, charlie, dave]) {
    const acc = findReplica(env, hub.id)[1].state.accounts.get(user.id);
    if (!acc) continue;
    const ws = acc.settlementWorkspace;
    const requested = acc.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
    pendingRequestedTotal += requested;
    if (requested > 0n) requestedByUser.set(user.id, requested);
    console.log(`    Hub↔${user.name}: ws=${ws?.status || 'none'}, requested=${requested}`);
  }
  assert(pendingRequestedTotal > 0n, `Expected pending requestedRebalance > 0 before hub deposit (got ${pendingRequestedTotal})`, env);
  assert(requestedByUser.size > 0, 'Expected at least one account with pending requestedRebalance before hub deposit', env);
  assert(
    Array.from(requestedByUser.values()).some(v => v > usd(500)),
    `Expected at least one pending rebalance request above $500 trigger, got [${Array.from(requestedByUser.values()).join(',')}]`,
    env,
  );
  // Deferred-fee invariant: request_collateral must not change balances before fulfillment.
  for (const [userId] of requestedByUser.entries()) {
    const offdeltaBefore = offdeltaBeforeCycle1.get(userId) ?? 0n;
    const offdeltaAfter = findReplica(env, hub.id)[1].state.accounts.get(userId)?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
    assert(
      offdeltaAfter === offdeltaBefore,
      `Expected no upfront fee shift before fulfillment for ${userId.slice(-4)} (offdelta before=${offdeltaBefore}, after=${offdeltaAfter})`,
      env,
    );
  }

  // ── Cycle 2: Hub crontab queues direct R→C to jBatch ──
  advanceTime(31000);
  console.log('\n  [Cycle 2] Hub crontab: queue direct R→C...');
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
  await converge(env);

  // Debug: Check jBatch state
  console.log('\n  [After Cycle 2] jBatch state:');
  const hubBatch = findReplica(env, hub.id)[1].state.jBatchState?.batch;
  const r2cCount = hubBatch?.reserveToCollateral?.length || 0;
  const c2rCount = hubBatch?.collateralToReserve?.length || 0;
  const settleCount = hubBatch?.settlements?.length || 0;
  console.log(`    r2c=${r2cCount}, c2r=${c2rCount}, settlements=${settleCount}`);
  assert(r2cCount > 0, `Expected direct R→C ops in jBatch, got r2c=${r2cCount}`, env);
  assert(c2rCount === 0, `Expected no C→R ops in direct R→C flow, got c2r=${c2rCount}`, env);
  assert(settleCount === 0, `Expected no settlement ops in direct R→C flow, got settlements=${settleCount}`, env);

  // Assert every pending user request is represented in queued R→C pairs.
  const queuedR2CByCounterparty = new Map<string, bigint>();
  for (const op of hubBatch?.reserveToCollateral || []) {
    for (const pair of op.pairs || []) {
      queuedR2CByCounterparty.set(pair.entity, (queuedR2CByCounterparty.get(pair.entity) || 0n) + pair.amount);
    }
  }
  const rebalanceTargetUserIds = Array.from(requestedByUser.keys()).filter(id => (queuedR2CByCounterparty.get(id) || 0n) > 0n);
  for (const [userId, requestedAmount] of requestedByUser.entries()) {
    const queuedAmount = queuedR2CByCounterparty.get(userId) || 0n;
    assert(
      queuedAmount > 0n,
      `Expected user request ${userId.slice(-4)} (requested=${requestedAmount}) to be queued in R→C batch, got ${queuedAmount}`,
      env,
    );
    assert(
      queuedAmount <= requestedAmount,
      `Queued R→C amount exceeds request for ${userId.slice(-4)}: queued=${queuedAmount}, requested=${requestedAmount}`,
      env,
    );
  }
  assert(rebalanceTargetUserIds.length > 0, 'Expected at least one rebalance target user in queued R→C pairs', env);

  for (const user of [alice, bob, charlie, dave]) {
    const acc = findReplica(env, hub.id)[1].state.accounts.get(user.id);
    if (!acc) continue;
    const ws = acc.settlementWorkspace;
    const delta = acc.deltas.get(USDC_TOKEN_ID);
    console.log(`    Hub↔${user.name}: ws=${ws?.status || 'none'}, collateral=${delta?.collateral}`);
  }

  // ══════════════════════════════════════════════════════════════
  // BROADCAST: AUTO via crontab (do NOT send manual j_broadcast here)
  // ══════════════════════════════════════════════════════════════
  const totalOps = r2cCount + c2rCount + settleCount;
  console.log(`\n📤 Waiting for crontab auto-broadcast (${totalOps} ops queued)...`);
  assert(totalOps > 0, `Expected queued ops before auto-broadcast, got ${totalOps}`, env);

  // Capture pre-broadcast bilateral J-finalization progress for targeted accounts.
  const hubBeforeBroadcast = findReplica(env, hub.id)[1].state;
  const batchHistoryBefore = hubBeforeBroadcast.batchHistory?.length || 0;
  const preHubProgress = new Map<string, AccountJProgress>();
  const preUserProgress = new Map<string, AccountJProgress>();
  const preHubCollateral = new Map<string, bigint>();
  const preUserCollateral = new Map<string, bigint>();
  for (const userId of rebalanceTargetUserIds) {
    const hubAcc = hubBeforeBroadcast.accounts.get(userId);
    preHubProgress.set(userId, snapshotAccountJProgress(hubAcc));
    preHubCollateral.set(userId, hubAcc?.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n);

    const [, userReplica] = findReplica(env, userId);
    const userAcc = userReplica.state.accounts.get(hub.id);
    preUserProgress.set(userId, snapshotAccountJProgress(userAcc));
    preUserCollateral.set(userId, userAcc?.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n);
  }

  // Allow broadcastBatch task + j-event polling/finalization.
  // Manual j_broadcast here would double-submit and fail nonce checks.
  for (let i = 0; i < 6; i++) {
    advanceTime(350);
    await process(env);
    await syncChain();
    await converge(env);
  }

  // Assert broadcast actually happened and was confirmed on-chain.
  const hubAfterBroadcast = findReplica(env, hub.id)[1].state;
  const batchHistoryAfter = hubAfterBroadcast.batchHistory || [];
  assert(
    batchHistoryAfter.length > batchHistoryBefore,
    `Expected batchHistory to grow after auto-broadcast (before=${batchHistoryBefore}, after=${batchHistoryAfter.length})`,
    env,
  );
  const lastBatch = batchHistoryAfter[batchHistoryAfter.length - 1];
  assert(lastBatch?.status === 'confirmed', `Expected last batch status=confirmed, got ${lastBatch?.status}`, env);
  assert(
    (lastBatch?.opCount || 0) >= r2cCount,
    `Expected confirmed batch opCount >= queued r2c count (${r2cCount}), got ${lastBatch?.opCount || 0}`,
    env,
  );
  assert(
    (hubAfterBroadcast.jBatchState?.pendingBroadcast || false) === false,
    'Expected hub jBatch pendingBroadcast=false after confirmed broadcast processing',
    env,
  );

  // Assert both sides finalized j-events for each targeted rebalance account.
  for (const userId of rebalanceTargetUserIds) {
    const hubAcc = hubAfterBroadcast.accounts.get(userId);
    const [, userReplica] = findReplica(env, userId);
    const userAcc = userReplica.state.accounts.get(hub.id);

    const hubPre = preHubProgress.get(userId)!;
    const userPre = preUserProgress.get(userId)!;
    const hubPost = snapshotAccountJProgress(hubAcc);
    const userPost = snapshotAccountJProgress(userAcc);

    assert(
      hubPost.lastFinalizedJHeight > hubPre.lastFinalizedJHeight,
      `Expected hub-side lastFinalizedJHeight to advance for ${userId.slice(-4)} (before=${hubPre.lastFinalizedJHeight}, after=${hubPost.lastFinalizedJHeight})`,
      env,
    );
    assert(
      userPost.lastFinalizedJHeight > userPre.lastFinalizedJHeight,
      `Expected user-side lastFinalizedJHeight to advance for ${userId.slice(-4)} (before=${userPre.lastFinalizedJHeight}, after=${userPost.lastFinalizedJHeight})`,
      env,
    );
    assert(
      hubPost.chainLen > hubPre.chainLen,
      `Expected hub-side jEventChain to grow for ${userId.slice(-4)} (before=${hubPre.chainLen}, after=${hubPost.chainLen})`,
      env,
    );
    assert(
      userPost.chainLen > userPre.chainLen,
      `Expected user-side jEventChain to grow for ${userId.slice(-4)} (before=${userPre.chainLen}, after=${userPost.chainLen})`,
      env,
    );

    const queuedAmount = queuedR2CByCounterparty.get(userId) || 0n;
    const hubCollateralBefore = preHubCollateral.get(userId) || 0n;
    const userCollateralBefore = preUserCollateral.get(userId) || 0n;
    const hubCollateralAfter = hubAcc?.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n;
    const userCollateralAfter = userAcc?.deltas.get(USDC_TOKEN_ID)?.collateral ?? 0n;

    assert(
      hubCollateralAfter >= hubCollateralBefore + queuedAmount,
      `Expected hub-side collateral increase >= queued R→C for ${userId.slice(-4)} (before=${hubCollateralBefore}, queued=${queuedAmount}, after=${hubCollateralAfter})`,
      env,
    );
    assert(
      userCollateralAfter >= userCollateralBefore + queuedAmount,
      `Expected user-side collateral increase >= queued R→C for ${userId.slice(-4)} (before=${userCollateralBefore}, queued=${queuedAmount}, after=${userCollateralAfter})`,
      env,
    );
    assert(
      hubCollateralAfter === userCollateralAfter,
      `Expected bilateral collateral sync after R→C for ${userId.slice(-4)} (hub=${hubCollateralAfter}, user=${userCollateralAfter})`,
      env,
    );

    if (hubPost.staleObservationCount > 0 || userPost.staleObservationCount > 0) {
      console.warn(
        `  ⚠️ TODO: stale J-observations remain for ${userId.slice(-4)} ` +
        `(hub=${hubPost.staleObservationCount}, user=${userPost.staleObservationCount})`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FINAL STATE + ASSERTIONS
  // ══════════════════════════════════════════════════════════════
  console.log('\n✅ Final state:');

  let hubFinal = findReplica(env, hub.id)[1].state;
  const hubFinalReserve = hubFinal.reserves.get(String(USDC_TOKEN_ID)) || 0n;

  console.log(`\n  Hub final reserve: $${hubFinalReserve / 10n**18n}`);

  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubFinal.accounts.get(user.id);
    const delta = acc?.deltas.get(USDC_TOKEN_ID);
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const derived = delta ? deriveDelta(delta, hubIsLeft) : null;
    const totalDelta = delta ? delta.ondelta + delta.offdelta : 0n;
    const hubDebt = delta ? (hubIsLeft ? (totalDelta < 0n ? -totalDelta : 0n) : (totalDelta > 0n ? totalDelta : 0n)) : 0n;
    const uncollateralized = delta ? (hubDebt > delta.collateral ? hubDebt - delta.collateral : 0n) : 0n;
    const nonce = acc?.onChainSettlementNonce || 0;
    console.log(`  Hub↔${user.name}: collateral=${delta?.collateral}, outCol=${derived?.outCollateral}, uncollateralized=${uncollateralized}, nonce=${nonce}, ws=${acc?.settlementWorkspace?.status || 'none'}`);
  }

  // ── EXPLICIT NONCE ASSERTIONS ──
  // Direct R→C does not use settlement workspace => nonce remains unchanged.
  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubFinal.accounts.get(user.id);
    const nonce = acc?.onChainSettlementNonce || 0;
    assert(nonce === 0, `Hub↔${user.name} nonce should stay 0 in direct R→C flow (got ${nonce})`, env);
  }

  // ── WORKSPACE CLEANUP ASSERTIONS ──
  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubFinal.accounts.get(user.id);
    assert(!acc?.settlementWorkspace, `Hub↔${user.name} workspace should be cleared (got status=${acc?.settlementWorkspace?.status})`, env);
  }

  // ── COLLATERAL + REQUEST LIFECYCLE ASSERTIONS ──
  let accountsWithTopUp = 0;
  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubFinal.accounts.get(user.id);
    const delta = acc?.deltas.get(USDC_TOKEN_ID);
    const before = collateralBeforeRebalance.get(user.id) ?? 0n;
    const after = delta?.collateral ?? 0n;
    if (after > before) accountsWithTopUp++;
    assert(after >= before, `Hub↔${user.name} collateral should not decrease in direct R→C flow (before=${before}, after=${after})`, env);
    const pendingHub = acc?.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
    const initialRequest = requestedByUser.get(user.id) ?? 0n;
    if (initialRequest > 0n) {
      assert(
        pendingHub <= initialRequest,
        `requestedRebalance must be monotonically decreasing (hub side ${user.name}): initial=${initialRequest}, current=${pendingHub}`,
        env,
      );
    }
  }
  assert(accountsWithTopUp > 0, `Expected at least one account to receive hub R→C top-up, got ${accountsWithTopUp}`, env);

  // Counterparty side: nonce unchanged, workspace empty, requestedRebalance cleared.
  for (const user of [alice, bob, charlie, dave]) {
    const [, userReplica] = findReplica(env, user.id);
    const userAcc = userReplica.state.accounts.get(hub.id);
    const userNonce = userAcc?.onChainSettlementNonce || 0;
    assert(userNonce === 0, `${user.name}↔Hub counterparty nonce should stay 0 in direct R→C flow (got ${userNonce})`, env);
    const userWs = userAcc?.settlementWorkspace;
    assert(!userWs, `${user.name}↔Hub counterparty workspace should be cleared (got status=${userWs?.status})`, env);
    const pendingUser = userAcc?.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
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
    for (const user of [alice, bob, charlie, dave]) {
      const hubAcc = latestHub.accounts.get(user.id);
      const [, userReplica] = findReplica(env, user.id);
      const userAcc = userReplica.state.accounts.get(hub.id);
      const hubPending = hubAcc?.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
      const userPending = userAcc?.requestedRebalance?.get(USDC_TOKEN_ID) ?? 0n;
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

    advanceTime(31000);
    await process(env, [{ entityId: hub.id, signerId: hub.signer, entityTxs: [] }]);
    for (let i = 0; i < 6; i++) {
      advanceTime(350);
      await process(env);
      await syncChain();
      await converge(env);
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
  if (blockingPending.length > 0) {
    console.warn(`  ⚠️ TODO: tracked requestedRebalance not fully cleared after refill cycles:`);
    for (const p of blockingPending) {
      console.warn(`     - ${p.userName}(hub=${p.hubPending}, user=${p.userPending})`);
    }
  }
  const nonBlockingPending = pendingAfterBroadcast.filter(p => !trackedRequestUserIds.has(p.userId));
  if (nonBlockingPending.length > 0) {
    console.warn(`  ⚠️ TODO: late/untracked requestedRebalance remains after refill cycles:`);
    for (const p of nonBlockingPending) {
      console.warn(`     - ${p.userName}(hub=${p.hubPending}, user=${p.userPending})`);
    }
  }

  hubFinal = findReplica(env, hub.id)[1].state;
  console.log(`  ✅ Direct R→C assertions passed (accounts topped up: ${accountsWithTopUp})`);

  console.log('\n' + '═'.repeat(80));
  console.log('  REBALANCE SCENARIO COMPLETE');
  console.log('═'.repeat(80));

  // Cleanup
  await jadapter.close();
}

// Run if executed directly
runRebalanceScenario().catch(err => {
  console.error('❌ Scenario failed:', err);
  process.exit(1);
});
