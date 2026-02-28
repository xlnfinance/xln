/**
 * Settlement Workspace Test Scenario
 *
 * Tests the bilateral settlement workspace negotiation flow:
 * 1. Alice proposes settlement to Hub
 * 2. Hub updates the proposal
 * 3. Both parties approve
 * 4. Settlement is executed via jBatch
 *
 * Also tests auto-approve logic and conservation law validation.
 */

import type { Env, EntityInput, EntityReplica, SettlementDiff, SettlementOp } from '../types';
import { compileOps } from '../settlement-ops';
import { snap, checkSolvency, assertRuntimeIdle, enableStrictScenario, advanceScenarioTime, ensureSignerKeysFromSeed, requireRuntimeSeed, getProcess, getApplyRuntimeInput, processJEvents as processJEventsHelper, converge as convergeHelper, syncChain as syncChainHelper } from './helpers';
import { ensureJAdapter, getScenarioJAdapter, createJReplica, createJurisdictionConfig, registerEntities as bootRegisterEntities } from './boot';
import type { JAdapter } from '../jadapter/types';
import { formatRuntime } from '../runtime-ascii';
import { createGossipLayer } from '../networking/gossip';
import { userAutoApprove, canAutoApproveWorkspace } from '../entity-tx/handlers/settle';
import { isLeftEntity } from '../entity-id-utils';

const USDC_TOKEN_ID = 1;
const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;

const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

const JURISDICTION = 'Settle Test';
const ENTITY_NAME_MAP = new Map<string, string>();
const getEntityName = (entityId: string): string => ENTITY_NAME_MAP.get(entityId) || entityId.slice(-4);

type ReplicaEntry = [string, EntityReplica];

function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`SETTLE: Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
}

function assert(condition: unknown, message: string, env?: Env): asserts condition {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED - FULL RUNTIME STATE:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20 }));
      console.log('='.repeat(80) + '\n');
    }
    throw new Error(`ASSERT: ${message}`);
  }
}


async function processJEvents(env: Env): Promise<void> {
  for (const [, jReplica] of env.jReplicas) {
    const ja = (jReplica as any).jadapter;
    if (ja?.pollNow) await ja.pollNow();
  }

  const process = await getProcess();
  const pendingInputs = env.runtimeInput?.entityInputs || [];
  if (pendingInputs.length > 0) {
    const toProcess = [...pendingInputs];
    env.runtimeInput.entityInputs = [];
    await process(env, toProcess);
  }
}

async function processUntil(
  env: Env,
  predicate: () => boolean,
  maxRounds: number = 10,
  label: string = 'condition'
): Promise<void> {
  const process = await getProcess();
  for (let round = 0; round < maxRounds; round++) {
    if (predicate()) return;
    await process(env);
    advanceScenarioTime(env);
  }
  if (!predicate()) {
    throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
  }
}

export async function runSettleScenario(existingEnv?: Env): Promise<Env> {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                    SETTLEMENT WORKSPACE TEST SCENARIO                          ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  // ══════════════════════════════════════════════════════════════════════════════
  // PHASE 0: SETUP
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 PHASE 0: SETUP');

  // DETERMINISTIC: Use fixed timestamp for scenario init (scenarioMode advances it manually)
  const SCENARIO_START_TIMESTAMP = 1700000000000; // Fixed epoch for reproducibility
  let env: Env = existingEnv || {
    eReplicas: new Map(),
    jReplicas: new Map(),
    height: 0,
    timestamp: SCENARIO_START_TIMESTAMP,
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    history: [],
    gossip: null,
    frameLogs: [],
    log: (msg: string) => console.log(msg),
    info: () => {},
    warn: () => {},
    error: () => {},
    emit: () => {},
  };

  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  if (env.runtimeSeed === undefined || env.runtimeSeed === null) {
    env.runtimeSeed = '';
  }

  // Suppress console.log for cleaner output
  const originalLog = console.log;
  const quietLog = (...args: any[]) => {
    const msg = args[0]?.toString() || '';
    // Only show key events
    if (msg.includes('ASSERT') || msg.includes('✅') || msg.includes('❌') ||
        msg.includes('PHASE') || msg.includes('TEST') || msg.includes('settle_') ||
        msg.includes('═══') || msg.includes('HOLD CHECK') ||
        msg.includes('JAdapter') || msg.includes('📡') || msg.includes('📮')) {
      originalLog(...args);
    }
  };
  console.log = quietLog;
  env.scenarioLogLevel = 'info'; // Allow info-level logs through strict scenario filter
  const cleanupStrictMode = enableStrictScenario(env, 'settle');

  // Ensure signer keys BEFORE entity registration (needed to compute board hash)
  ensureSignerKeysFromSeed(env, ['2', '3'], 'settle');

  // Setup JAdapter (browservm or rpc, depending on JADAPTER_MODE)
  let jadapter: JAdapter;
  try {
    jadapter = getScenarioJAdapter(env);
  } catch {
    jadapter = await ensureJAdapter(env);
    const jReplica = createJReplica(env, JURISDICTION, jadapter.addresses.depository);
    (jReplica as any).jadapter = jadapter;
    (jReplica as any).depositoryAddress = jadapter.addresses.depository;
    (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
    jadapter.startWatching(env);
  }

  // Initialize gossip
  env.gossip = createGossipLayer();

  const jurisdiction = createJurisdictionConfig(JURISDICTION, jadapter.addresses.depository, jadapter.addresses.entityProvider);

  // Register entities: Alice(signer=2) and Hub(signer=3)
  const registered = await bootRegisterEntities(env, jadapter, [
    { name: 'Alice', signer: '2', position: { x: -30, y: -30, z: 0 } },
    { name: 'Hub',   signer: '3', position: { x: 30, y: -30, z: 0 } },
  ], jurisdiction);

  const ALICE_ID = registered[0].id;
  const HUB_ID = registered[1].id;

  ENTITY_NAME_MAP.set(ALICE_ID, 'Alice');
  ENTITY_NAME_MAP.set(HUB_ID, 'Hub');

  console.log(`✅ Created Alice (${ALICE_ID.slice(-4)}) and Hub (${HUB_ID.slice(-4)})`);

  snap(env, 'Entities Created', {
    description: 'Alice and Hub entities initialized',
    phase: 'setup'
  });

  // Mint reserves
  await process(env, [{
    entityId: ALICE_ID,
    signerId: '2',
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC_TOKEN_ID, amount: usd(1000) } }]
  }]);

  await process(env, [{
    entityId: HUB_ID,
    signerId: '3',
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC_TOKEN_ID, amount: usd(1000) } }]
  }]);

  // Process J-events from minting
  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await processJEvents(env);
  }

  // Open account between Alice and Hub
  await process(env, [{
    entityId: ALICE_ID,
    signerId: '2',
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: HUB_ID, creditAmount: 0n } }]
  }]);

  // Let account setup complete
  for (let i = 0; i < 10; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  console.log(`✅ Account opened between Alice and Hub`);

  snap(env, 'Account Opened', {
    description: 'Bilateral account between Alice and Hub',
    phase: 'setup'
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 1: CONSERVATION LAW VALIDATION
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 1: Conservation Law Validation');

  // Good diff (sum = 0)
  const validDiff: SettlementDiff = {
    tokenId: USDC_TOKEN_ID,
    leftDiff: -100n,
    rightDiff: 50n,
    collateralDiff: 50n,
    ondeltaDiff: 0n
  };
  assert(
    validDiff.leftDiff + validDiff.rightDiff + validDiff.collateralDiff === 0n,
    'Valid diff should satisfy conservation law'
  );
  console.log(`✅ Valid diff: ${validDiff.leftDiff} + ${validDiff.rightDiff} + ${validDiff.collateralDiff} = 0`);

  // Bad diff (sum != 0)
  const invalidDiff: SettlementDiff = {
    tokenId: USDC_TOKEN_ID,
    leftDiff: -100n,
    rightDiff: 50n,
    collateralDiff: 40n, // Sum = -10
    ondeltaDiff: 0n
  };
  assert(
    invalidDiff.leftDiff + invalidDiff.rightDiff + invalidDiff.collateralDiff !== 0n,
    'Invalid diff should violate conservation law'
  );
  console.log(`✅ Invalid diff: ${invalidDiff.leftDiff} + ${invalidDiff.rightDiff} + ${invalidDiff.collateralDiff} = ${invalidDiff.leftDiff + invalidDiff.rightDiff + invalidDiff.collateralDiff}`);

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 2: AUTO-APPROVE LOGIC
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 2: Auto-Approve Logic');

  // Scenario: Hub withdraws from Hub's collateral share (should auto-approve for end user)
  // IMPORTANT: ondelta rules - Right operations do NOT change ondelta
  // If Hub (Right) withdraws from collateral, ondelta stays unchanged
  const hubWithdrawsDiff: SettlementDiff = {
    tokenId: USDC_TOKEN_ID,
    leftDiff: 0n,           // Alice's reserve unchanged
    rightDiff: 100n,        // Hub gets 100 to reserve
    collateralDiff: -100n,  // From collateral
    ondeltaDiff: 0n         // ondelta UNCHANGED because Right is operating
  };

  // Alice is LEFT in Alice-Hub account
  const aliceAutoApproves = userAutoApprove(hubWithdrawsDiff, true);
  console.log(`   Hub withdraws from collateral: aliceAutoApproves=${aliceAutoApproves}`);
  assert(aliceAutoApproves, 'Alice should auto-approve when Hub withdraws from Hub share');

  // Scenario: Hub tries to take from Alice's reserve (should NOT auto-approve)
  const hubTakesFromAlice: SettlementDiff = {
    tokenId: USDC_TOKEN_ID,
    leftDiff: -100n,        // Alice loses 100
    rightDiff: 100n,        // Hub gains 100
    collateralDiff: 0n,
    ondeltaDiff: 0n
  };
  const aliceRejects = userAutoApprove(hubTakesFromAlice, true);
  console.log(`   Hub takes from Alice: aliceAutoApproves=${aliceRejects}`);
  assert(!aliceRejects, 'Alice should NOT auto-approve when losing reserve');

  // Scenario: Hub sends to Alice (should auto-approve)
  const hubSendsToAlice: SettlementDiff = {
    tokenId: USDC_TOKEN_ID,
    leftDiff: 100n,         // Alice gains 100
    rightDiff: -100n,       // Hub loses 100
    collateralDiff: 0n,
    ondeltaDiff: 0n
  };
  const aliceAccepts = userAutoApprove(hubSendsToAlice, true);
  console.log(`   Hub sends to Alice: aliceAutoApproves=${aliceAccepts}`);
  assert(aliceAccepts, 'Alice should auto-approve when gaining reserve');

  console.log(`✅ Auto-approve logic works correctly`);

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 3: SETTLEMENT WORKSPACE PROPOSE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 3: Settlement Workspace Propose');

  // Alice proposes settlement: deposit 100 USDC into collateral
  const depositOps: SettlementOp[] = [{ type: 'r2c', tokenId: USDC_TOKEN_ID, amount: usd(100) }];

  await process(env, [{
    entityId: ALICE_ID,
    signerId: '2',
    entityTxs: [{
      type: 'settle_propose',
      data: {
        counterpartyEntityId: HUB_ID,
        ops: depositOps,
        memo: 'Alice deposits collateral'
      }
    }]
  }]);

  // Process message delivery
  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  // Verify workspace created on both sides
  const [, aliceReplica] = findReplica(env, ALICE_ID);
  const [, hubReplica] = findReplica(env, HUB_ID);

  const aliceAccount = aliceReplica.state.accounts.get(HUB_ID);
  const hubAccount = hubReplica.state.accounts.get(ALICE_ID);

  assert(aliceAccount?.settlementWorkspace, 'Alice should have settlement workspace', env);
  assert(hubAccount?.settlementWorkspace, 'Hub should have settlement workspace', env);
  assert(aliceAccount.settlementWorkspace.version === 1, 'Workspace should be version 1');
  assert(aliceAccount.settlementWorkspace.lastModifiedByLeft === true, 'Alice (left) should be lastModifier');

  // TEST: Verify settlement holds are set via frame consensus
  // Alice proposes r2c (proposer=Alice) — compiled diff takes from Alice's reserve side
  const usdcDelta = aliceAccount.deltas.get(USDC_TOKEN_ID);
  assert(usdcDelta, 'USDC delta should exist', env);
  const aliceIsLeft = aliceAccount.leftEntity === ALICE_ID;
  const holdField = aliceIsLeft ? 'leftHold' : 'rightHold';
  const actualHold = aliceIsLeft ? (usdcDelta.leftHold || 0n) : (usdcDelta.rightHold || 0n);
  const expectedHold = usd(100);
  console.log(`   HOLD CHECK: ${holdField}=${actualHold}, expected=${expectedHold}`);
  assert(actualHold === expectedHold, `Settlement hold not set: expected ${expectedHold}, got ${actualHold}`, env);

  console.log(`✅ Settlement proposed: Alice → Hub`);
  console.log(`   Workspace version: ${aliceAccount.settlementWorkspace.version}`);
  console.log(`   Status: ${aliceAccount.settlementWorkspace.status}`);

  snap(env, 'Settlement Proposed', {
    description: 'Alice proposes $100 deposit to collateral',
    phase: 'propose',
    holdAmount: expectedHold.toString()
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 4: SETTLEMENT WORKSPACE UPDATE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 4: Settlement Workspace Update');

  // Hub counter-proposes: different amount
  const counterOps: SettlementOp[] = [{ type: 'r2c', tokenId: USDC_TOKEN_ID, amount: usd(50) }];

  await process(env, [{
    entityId: HUB_ID,
    signerId: '3',
    entityTxs: [{
      type: 'settle_update',
      data: {
        counterpartyEntityId: ALICE_ID,
        ops: counterOps,
        memo: 'Hub counter: 50 instead of 100'
      }
    }]
  }]);

  // Process message delivery
  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  // Verify update
  const aliceAccount2 = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID);
  assert(aliceAccount2?.settlementWorkspace?.version === 2, 'Version should be 2 after update', env);
  // Verify compiled ops match expected values
  const { diffs: compiledDiffs } = compileOps(aliceAccount2.settlementWorkspace.ops, aliceAccount2.settlementWorkspace.lastModifiedByLeft);
  // Hub is RIGHT, so r2c compiles to rightDiff = -amount
  assert(compiledDiffs[0].rightDiff === -usd(50), 'Compiled diff should reflect update (Hub rightDiff)');

  console.log(`✅ Settlement updated by Hub`);
  console.log(`   New version: ${aliceAccount2.settlementWorkspace.version}`);

  snap(env, 'Settlement Updated', {
    description: 'Hub counter-proposes $50 instead of $100',
    phase: 'update'
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 5: SETTLEMENT APPROVE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 5: Settlement Approve');

  // Alice approves (counterparty of Hub's update — only counterparty of lastModifier can approve)
  await process(env, [{
    entityId: ALICE_ID,
    signerId: '2',
    entityTxs: [{
      type: 'settle_approve',
      data: { counterpartyEntityId: HUB_ID }
    }]
  }]);

  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  // Verify Alice's hanko is set on both sides (via bilateral frame consensus)
  const aliceAccount3 = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID);
  const aliceHankoField3 = aliceIsLeft ? 'leftHanko' : 'rightHanko';
  assert(aliceAccount3?.settlementWorkspace?.[aliceHankoField3], 'Alice should have signed', env);

  // Hub receives Alice's hanko
  const hubAccount3 = findReplica(env, HUB_ID)[1].state.accounts.get(ALICE_ID);
  assert(hubAccount3?.settlementWorkspace?.[aliceHankoField3], 'Hub should have received Alice hanko', env);

  console.log(`✅ Alice approved settlement`);
  console.log(`   Alice hanko (${aliceHankoField3}): ${aliceAccount3.settlementWorkspace[aliceHankoField3]?.slice(0, 20)}...`);

  snap(env, 'Settlement Approved', {
    description: 'Both parties signed - ready to submit',
    phase: 'approve'
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 6: SETTLEMENT EXECUTE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 6: Settlement Execute');

  // Hub executes (lastModifier has counterparty's hanko → can submit to jBatch)
  await process(env, [{
    entityId: HUB_ID,
    signerId: '3',
    entityTxs: [{
      type: 'settle_execute',
      data: { counterpartyEntityId: ALICE_ID }
    }]
  }]);

  for (let i = 0; i < 3; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  // Broadcast the jBatch to chain
  await process(env, [{
    entityId: HUB_ID,
    signerId: '3',
    entityTxs: [{ type: 'j_broadcast', data: {} }]
  }]);

  // Sync chain events — poll JAdapter + process events through runtime
  await syncChainHelper(env, 5);

  const aliceState = findReplica(env, ALICE_ID)[1].state;
  assert(!aliceState.accounts.get(HUB_ID)?.settlementWorkspace, 'Workspace should be cleared after execute', env);

  console.log(`✅ Settlement executed + on-chain confirmed`);

  snap(env, 'Settlement Executed', {
    description: 'Settlement added to jBatch for on-chain commit',
    phase: 'execute'
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 7: SETTLEMENT REJECT
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 7: Settlement Reject');

  // Create another proposal
  await process(env, [{
    entityId: ALICE_ID,
    signerId: '2',
    entityTxs: [{
      type: 'settle_propose',
      data: {
        counterpartyEntityId: HUB_ID,
        ops: depositOps,
        memo: 'Another proposal'
      }
    }]
  }]);

  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  // Hub rejects
  await process(env, [{
    entityId: HUB_ID,
    signerId: '3',
    entityTxs: [{
      type: 'settle_reject',
      data: {
        counterpartyEntityId: ALICE_ID,
        reason: 'Not interested'
      }
    }]
  }]);

  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  const aliceAccount5 = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID);
  assert(!aliceAccount5?.settlementWorkspace, 'Workspace should be cleared after reject', env);

  console.log(`✅ Settlement rejected - workspace cleared`);

  snap(env, 'Settlement Rejected', {
    description: 'Hub rejected - workspace cleared, holds released',
    phase: 'reject'
  });

  snap(env, 'Scenario Complete', {
    description: 'All settlement tests passed',
    phase: 'complete'
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════════════════════
  // Restore console.log
  console.log = originalLog;
  console.log('\n📋 CLEANUP');


  cleanupStrictMode();

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                    ✅ ALL SETTLEMENT TESTS PASSED                              ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  return env;
}

// Run if executed directly
if (import.meta.main) {
  runSettleScenario()
    .then(() => {
      console.log('Scenario completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Scenario failed:', err);
      process.exit(1);
    });
}
