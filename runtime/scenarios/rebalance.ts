/**
 * Multi-Edge Rebalance Scenario
 *
 * Hub + Alice + Bob + Charlie + Dave
 * After payments create imbalances:
 *   - Hub↔Alice: Hub has excess collateral → C→R (withdraw $5K)
 *   - Hub↔Charlie: Hub has excess collateral → C→R (withdraw $10K)
 *   - Hub↔Bob: Hub owes collateral → R→C (deposit $5K)
 *   - Hub↔Dave: Hub owes collateral → R→C (deposit $10K)
 *
 * All in ONE processBatch with proper hanko signatures.
 */

import type { Env, EntityInput, EntityReplica, Delta } from '../types';
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

export async function runRebalanceScenario(): Promise<void> {
  console.log('\n' + '═'.repeat(80));
  console.log('  MULTI-EDGE REBALANCE SCENARIO');
  console.log('  Hub + Alice + Bob + Charlie + Dave');
  console.log('  C→R (withdraw excess) + R→C (deposit needed) in ONE batch');
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
      depository: jadapter.addresses.depository,
      entityProvider: jadapter.addresses.entityProvider,
    },
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

  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubAfterPayments.accounts.get(user.id);
    if (!acc) continue;
    const delta = acc.deltas.get(USDC_TOKEN_ID);
    if (!delta) continue;
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
      data: { matchingStrategy: 'hnw', routingFeePPM: 100, baseFee: 0n },
    }]
  }]);
  await converge(env);

  const hubConfigSet = findReplica(env, hub.id)[1].state.hubRebalanceConfig;
  assert(hubConfigSet, 'Hub config not set', env);
  console.log('✅ Hub config set');

  // ══════════════════════════════════════════════════════════════
  // REBALANCE: Multi-cycle hub crontab
  //
  // Cycle 1: Hub crontab detects:
  //   C→R: Alice + Charlie have outCollateral > 0 → settle_propose
  //   R→C: Bob + Dave have uncollateralized credit > softLimit → sendRebalanceQuote
  //
  // Cycle 2: Process bilateral frames:
  //   - settle_propose delivered → counterparty auto-approves → hanko back
  //   - rebalance_quote delivered → auto-accepted (fee < maxAcceptableFee)
  //
  // Cycle 3: Hub crontab detects:
  //   - Counterparty hankos present → settle_execute → C→R in jBatch
  //   - Accepted quotes → deposit_collateral → R→C in jBatch
  //
  // Final: j_broadcast → one processBatch with C→R + R→C
  // ══════════════════════════════════════════════════════════════
  console.log('\n🔄 Running rebalance cycles...');

  // Helper: advance time + sync all entity timestamps
  function advanceTime(ms: number) {
    env.timestamp += ms;
    for (const [, replica] of env.eReplicas) {
      replica.state.timestamp = env.timestamp;
    }
  }

  // ── Cycle 1: Initial Hub crontab (>30s since last) ──
  advanceTime(31000);
  console.log('\n  [Cycle 1] Hub crontab: detect C→R + R→C...');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [] // Ping to trigger crontab
  }]);

  // Process bilateral frames (settle_propose + rebalance_quote delivery)
  for (let i = 0; i < 15; i++) {
    advanceTime(100);
    await process(env);
  }
  await converge(env);

  // Debug: Check state after Cycle 1
  console.log('\n  [After Cycle 1] State:');
  for (const user of [alice, bob, charlie, dave]) {
    const acc = findReplica(env, hub.id)[1].state.accounts.get(user.id);
    if (!acc) continue;
    const ws = acc.settlementWorkspace;
    const q = acc.activeRebalanceQuote;
    const hubIsLeft = isLeftEntity(hub.id, user.id);
    const counterpartyHanko = ws ? (hubIsLeft ? ws.rightHanko : ws.leftHanko) : undefined;
    console.log(`    Hub↔${user.name}: ws=${ws?.status || 'none'}, cpHanko=${!!counterpartyHanko}, quote=${q ? (q.accepted ? 'accepted' : 'pending') : 'none'}`);
  }

  // ── Cycle 2: Hub crontab detects signed settlements + accepted quotes ──
  advanceTime(31000);
  console.log('\n  [Cycle 2] Hub crontab: execute C→R + deposit R→C...');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [] // Ping to trigger crontab
  }]);

  // Process bilateral frames for settle_execute + deposit_collateral delivery
  for (let i = 0; i < 15; i++) {
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

  for (const user of [alice, bob, charlie, dave]) {
    const acc = findReplica(env, hub.id)[1].state.accounts.get(user.id);
    if (!acc) continue;
    const ws = acc.settlementWorkspace;
    const delta = acc.deltas.get(USDC_TOKEN_ID);
    console.log(`    Hub↔${user.name}: ws=${ws?.status || 'none'}, collateral=${delta?.collateral}`);
  }

  // ══════════════════════════════════════════════════════════════
  // BROADCAST: One processBatch with C→R + R→C
  // ══════════════════════════════════════════════════════════════
  const totalOps = r2cCount + c2rCount + settleCount;
  console.log(`\n📤 Broadcasting combined batch (${totalOps} ops)...`);

  if (totalOps > 0) {
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }]
    }]);

    // Process J-block: processor → on-chain tx → poll events
    advanceTime(150);
    await process(env); // J-processor fires on-chain tx
    await syncChain();  // Poll events + process
    await converge(env);
  } else {
    console.log('  ⚠️  jBatch empty — running one more cycle...');

    // Extra cycle in case timing didn't align
    advanceTime(31000);
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: []
    }]);
    for (let i = 0; i < 15; i++) {
      advanceTime(100);
      await process(env);
    }
    await converge(env);

    const hubBatch2 = findReplica(env, hub.id)[1].state.jBatchState?.batch;
    const totalOps2 = (hubBatch2?.reserveToCollateral?.length || 0) +
      (hubBatch2?.collateralToReserve?.length || 0) +
      (hubBatch2?.settlements?.length || 0);
    console.log(`    After extra cycle: jBatch ops=${totalOps2}`);

    if (totalOps2 > 0) {
      await process(env, [{
        entityId: hub.id,
        signerId: hub.signer,
        entityTxs: [{ type: 'j_broadcast', data: {} }]
      }]);
      advanceTime(150);
      await process(env); // J-processor fires on-chain tx
      await syncChain();  // Poll events + process
      await converge(env);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FINAL STATE + ASSERTIONS
  // ══════════════════════════════════════════════════════════════
  console.log('\n✅ Final state:');

  const hubFinal = findReplica(env, hub.id)[1].state;
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
  // C→R settlements (Alice, Charlie) must have incremented nonce to 1
  // R→C deposits (Bob, Dave) don't use settlement workspace → nonce stays 0
  for (const user of [alice, charlie]) {
    const acc = hubFinal.accounts.get(user.id);
    const nonce = acc?.onChainSettlementNonce || 0;
    assert(nonce >= 1, `Hub↔${user.name} nonce should be >= 1 after C→R (got ${nonce})`, env);
  }
  for (const user of [bob, dave]) {
    const acc = hubFinal.accounts.get(user.id);
    const nonce = acc?.onChainSettlementNonce || 0;
    // R→C uses deposit_collateral, not settlement — nonce unchanged
    console.log(`  ✅ Hub↔${user.name} nonce=${nonce} (R→C, no settlement nonce change expected)`);
  }

  // ── WORKSPACE CLEANUP ASSERTIONS ──
  for (const user of [alice, bob, charlie, dave]) {
    const acc = hubFinal.accounts.get(user.id);
    assert(!acc?.settlementWorkspace, `Hub↔${user.name} workspace should be cleared (got status=${acc?.settlementWorkspace?.status})`, env);
  }

  // ── COUNTERPARTY NONCE ASSERTIONS ──
  // Verify the counterparty side also incremented nonce (fixes Q5)
  for (const user of [alice, charlie]) {
    const [, userReplica] = findReplica(env, user.id);
    const userAcc = userReplica.state.accounts.get(hub.id);
    const userNonce = userAcc?.onChainSettlementNonce || 0;
    assert(userNonce >= 1, `${user.name}↔Hub counterparty nonce should be >= 1 after C→R (got ${userNonce})`, env);
    const userWs = userAcc?.settlementWorkspace;
    assert(!userWs, `${user.name}↔Hub counterparty workspace should be cleared (got status=${userWs?.status})`, env);
  }

  console.log('  ✅ All nonce + workspace assertions passed');

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
