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

import type { RuntimeReplica } from '../../runtime/types';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import type { SettlementDiff, SettlementOp } from '../../types/account';
import { compileOps } from '../../protocol/settlement/operations';
import { snap, enableStrictScenario, advanceScenarioTime, ensureSignerKeysFromSeed, getProcess, syncChain, findReplica, setScenarioStorageEnabled, converge, processUntil, processJEvents, usd, formatTokenMoney } from '../harness/helpers';
import { tell } from '../harness/narration';
import { SETTLEMENT_ASSET } from '../harness/story';
import { deriveDelta } from '../../account/utils';
import { bindScenarioJReplica, ensureJAdapter, getScenarioJAdapter, isScenarioJAdapterMissingError, createJReplica, createJurisdictionConfig, DEMO_JURISDICTION_NAME, registerEntities } from '../harness/boot';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import { formatRuntime } from '../../qa/runtime-ascii';
import { createGossipLayer } from '../../network/p2p/gossip';
import { userAutoApprove } from '../../entity/tx/handlers/payments/settle';
import { createRuntimeConfig } from '../../runtime/loop/loop-environment';

const USDC_TOKEN_ID = 1;
const usdc = (amount: bigint): string => formatTokenMoney(USDC_TOKEN_ID, amount);
// Presentation amounts, in whole USDC: same order of magnitude as the other parts.
const RESERVE = usd(1_000_000);
const CREDIT = usd(200_000);
const COLLATERAL = usd(200_000);
const ALICE_PAYS = usd(60_000);
const HUB_PAYS = usd(20_000);
const NET_OWED = ALICE_PAYS - HUB_PAYS;
const PARTIAL_OFFER = usd(20_000);
const REJECTED_ASK = usd(1_000);

const JURISDICTION = DEMO_JURISDICTION_NAME;
const ENTITY_NAME_MAP = new Map<string, string>();

function assert(condition: unknown, message: string, env?: RuntimeReplica): asserts condition {
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

export async function runSettleScenario(existingEnv?: RuntimeReplica): Promise<RuntimeReplica> {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                    SETTLEMENT WORKSPACE TEST SCENARIO                          ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  const process = await getProcess();

  // ══════════════════════════════════════════════════════════════════════════════
  // PHASE 0: SETUP
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 PHASE 0: SETUP');

  // DETERMINISTIC: Use fixed timestamp for scenario init (scenarioMode advances it manually)
  const SCENARIO_START_TIMESTAMP = 1700000000000; // Fixed epoch for reproducibility
  let env: RuntimeReplica;
  if (existingEnv) {
    env = existingEnv;
  } else {
    env = {
      state: {
        eReplicas: new Map(),
        jReplicas: new Map(),
        height: 0,
        timestamp: SCENARIO_START_TIMESTAMP,
      },
      runtimeMempool: { runtimeTxs: [], entityInputs: [] },
      runtimeConfig: createRuntimeConfig(),
      gossip: createGossipLayer(),
      log: (msg: string) => console.log(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
      emit: () => {},
    };
  }

  env.scenarioMode = true;
  setScenarioStorageEnabled(env, false);
  env.quietRuntimeLogs = true;
  if (env.runtimeSeed === undefined || env.runtimeSeed === null) {
    env.runtimeSeed = '';
  }

  // Suppress console.log for cleaner output
  const originalLog = console.log;
  const quietLog = (...args: unknown[]) => {
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
  try {

  // Ensure signer keys BEFORE entity registration (needed to compute board hash)
  ensureSignerKeysFromSeed(env, ['2', '3'], 'settle');

  // Setup JAdapter (browservm or rpc, depending on JADAPTER_MODE)
  let jadapter: JAdapter;
  try {
    jadapter = getScenarioJAdapter(env);
  } catch (error) {
    if (!isScenarioJAdapterMissingError(error)) throw error;
    jadapter = await ensureJAdapter(env);
    bindScenarioJReplica(
      env,
      createJReplica(env, JURISDICTION, jadapter.addresses.depository),
      jadapter,
    );
    jadapter.startWatching(env);
  }

  // Initialize gossip
  env.gossip = createGossipLayer();

  const jurisdiction = createJurisdictionConfig(JURISDICTION, jadapter.addresses.depository, jadapter.addresses.entityProvider);

  snap(env, 'Two banks join the Depository', {
    description: 'Alice and Hub register on the Depository',
    phase: 'setup',
    what: 'Alice, a commercial bank, and Hub, a dealer bank, register as entities on the Depository contract. Each entity is controlled by its own signing board.',
    why: 'Registration gives each bank an identity the Depository can verify. After it, payments between Alice and Hub happen in their bilateral account; only collateral and settlement go on-chain.',
    tradfiParallel: 'Opening an account in the settlement system before a bank can settle there.',
    keyMetrics: ['Participants: 2', `Jurisdiction: ${JURISDICTION}`],
  });

  // Register entities: Alice(signer=2) and Hub(signer=3)
  const registered = await registerEntities(env, jadapter, [
    { name: 'Alice', signer: '2', position: { x: -40, y: -30, z: 0 } },
    { name: 'Hub',   signer: '3', position: { x: 40, y: -30, z: 0 } },
  ], jurisdiction);

  const aliceRegistration = registered[0];
  const hubRegistration = registered[1];
  assert(aliceRegistration && hubRegistration, 'Alice and Hub should be registered', env);
  const ALICE_ID = aliceRegistration.id;
  const HUB_ID = hubRegistration.id;
  const ALICE_SIGNER = aliceRegistration.signer;
  const HUB_SIGNER = hubRegistration.signer;

  ENTITY_NAME_MAP.set(ALICE_ID, 'Alice');
  ENTITY_NAME_MAP.set(HUB_ID, 'Hub');

  console.log(`✅ Created Alice (${ALICE_ID.slice(-4)}) and Hub (${HUB_ID.slice(-4)})`);

  snap(env, 'Test balances credited on the Depository', {
    description: 'Alice and Hub receive test balances',
    phase: 'setup',
    what: `Alice and Hub each receive ${usdc(RESERVE)} of test balance as reserves on the Depository.`,
    why: 'Only reserves moved into an account as collateral back bilateral exposure; the rest stays freely usable.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: [`Alice reserve: ${usdc(RESERVE)}`, `Hub reserve: ${usdc(RESERVE)}`],
  });

  // Mint reserves
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC_TOKEN_ID, amount: RESERVE } }]
  }]);

  await process(env, [{
    entityId: HUB_ID,
    signerId: HUB_SIGNER,
    entityTxs: [{ type: 'mintReserves', data: { tokenId: USDC_TOKEN_ID, amount: RESERVE } }]
  }]);

  // Process J-events from minting
  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await processJEvents(env);
  }

  snap(env, 'Bilateral account opened', {
    description: 'Alice opens an account with Hub',
    phase: 'setup',
    what: 'Alice opens one bilateral account with Hub. Both sides keep an identical copy of its state, and every change is a frame both of them sign.',
    why: 'No network-wide registration and no shared ledger: the account involves exactly the two parties who carry its risk.',
    tradfiParallel: 'A bilateral correspondent relationship, but with one co-signed record instead of two reconciled ledgers.',
  });

  // Open account between Alice and Hub
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'openAccount', data: {
      targetEntityId: HUB_ID,
      disputeConfig: defaultAccountDisputeConfigForParties(ALICE_ID, false, HUB_ID, true),
      creditAmount: 0n,
    } }]
  }]);

  // Let account setup complete
  for (let i = 0; i < 10; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  console.log(`✅ Account opened between Alice and Hub`);

  snap(env, 'Credit lines in both directions', {
    description: 'Alice and Hub extend credit to each other',
    phase: 'setup',
    what: `Alice and Hub each grant the other a ${usdc(CREDIT)} credit line inside the account.`,
    why: 'Each bank sets the limit on what the other may owe it, and can lower it at any time; nothing is deposited.',
    tradfiParallel: 'A bilateral credit limit, set by the bank that carries the risk.',
    keyMetrics: [`Credit Alice → Hub: ${usdc(CREDIT)}`, `Credit Hub → Alice: ${usdc(CREDIT)}`],
  });

  // Fund both directions with real bilateral credit so the manual settlement
  // negotiation below can reserve either side without mutating Account state.
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{
      type: 'extendCredit',
      data: { counterpartyEntityId: HUB_ID, tokenId: USDC_TOKEN_ID, amount: CREDIT },
    }],
  }]);
  await process(env, [{
    entityId: HUB_ID,
    signerId: HUB_SIGNER,
    entityTxs: [{
      type: 'extendCredit',
      data: { counterpartyEntityId: ALICE_ID, tokenId: USDC_TOKEN_ID, amount: CREDIT },
    }],
  }]);
  await converge(env, 20);

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

  // Alice proposes settlement: deposit collateral
  const depositOps: SettlementOp[] = [{ type: 'r2c', tokenId: USDC_TOKEN_ID, amount: COLLATERAL }];
  const readMoveMoney = () => Promise.all([
    jadapter.getReserves(ALICE_ID, USDC_TOKEN_ID),
    jadapter.getReserves(HUB_ID, USDC_TOKEN_ID),
    jadapter.getCollateral(ALICE_ID, HUB_ID, USDC_TOKEN_ID),
  ] as const);
  const moveBefore = await readMoveMoney();

  snap(env, 'Settlement proposed: reserve into collateral', {
    description: `Alice proposes to move ${usdc(COLLATERAL)} into collateral`,
    phase: 'propose',
    what: `Alice proposes a settlement: move ${usdc(COLLATERAL)} of her reserve into the account as collateral. This adds collateral and does not reserve existing Account payment capacity. The chain enforces the reserve debit when the signed settlement executes.`,
    why: 'Hub\'s position only improves, so Hub signs automatically. A settlement is a shared proposal both banks must sign before anything reaches the chain.',
    tradfiParallel: 'A signed instruction to transfer reserve into pledged collateral.',
    keyMetrics: ['Account hold: 0', `Proposed collateral deposit: ${usdc(COLLATERAL)}`],
  });

  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{
      type: 'settle_propose',
      data: {
        counterpartyEntityId: HUB_ID,
        ops: depositOps,
        memo: 'Alice deposits collateral'
      }
    }]
  }]);

  // Drain both Entity delivery and bilateral Account consensus. Reliable
  // transport adds bounded hops; a fixed tick count can observe a valid h2
  // proposal before the counterparty durably commits it.
  await converge(env, 20);

  // Verify workspace created on both sides
  const [, aliceReplica] = findReplica(env, ALICE_ID);
  const [, hubReplica] = findReplica(env, HUB_ID);

  const aliceAccount = aliceReplica.state.accounts.get(HUB_ID);
  const hubAccount = hubReplica.state.accounts.get(ALICE_ID);

  assert(aliceAccount?.state.settlementWorkspace, 'Alice should have settlement workspace', env);
  assert(hubAccount?.state.settlementWorkspace, 'Hub should have settlement workspace', env);
  assert(aliceAccount.state.settlementWorkspace.revision === 1, 'Workspace should be revision 1');
  assert(aliceAccount.state.settlementWorkspace.lastModifiedByLeft === true, 'Alice (left) should be lastModifier');

  // R2C adds collateral; it must not lock existing bilateral payment capacity.
  // C2R below exercises the opposite case through the same signed consensus path.
  const usdcDelta = aliceAccount.state.deltas.get(USDC_TOKEN_ID);
  assert(usdcDelta, 'USDC delta should exist', env);
  const aliceIsLeft = aliceAccount.state.leftEntity === ALICE_ID;
  assert(usdcDelta.leftHold === 0n && usdcDelta.rightHold === 0n,
    'R2C must not create an Account hold', env);

  console.log(`✅ Settlement proposed: Alice → Hub`);
  console.log(`   Workspace revision: ${aliceAccount.state.settlementWorkspace.revision}`);
  console.log(`   Status: ${aliceAccount.state.settlementWorkspace.status}`);
  const hubHankoField = aliceIsLeft ? 'rightHanko' : 'leftHanko';
  const initialAutoApproved = Boolean(aliceAccount.state.settlementWorkspace[hubHankoField]);
  console.log(`   Auto-approved by Hub: ${initialAutoApproved ? 'yes' : 'no'}`);

  // A signed workspace is durable authorization and cannot be cleared as a
  // test reset. Complete the real auto-approved path on-chain before starting
  // a distinct manual negotiation on the now-settled Account.
  assert(
    aliceAccount.state.settlementWorkspace.status === 'ready_to_submit',
    'Auto-approved workspace should be fully Hanko-authorized before execution',
    env,
  );
  snap(env, 'Collateral posted on-chain', {
    description: 'Alice submits the signed settlement',
    phase: 'execute',
    what: `Alice submits the signed settlement to the Depository. One transaction debits her reserve by ${usdc(COLLATERAL)} and credits the account\'s collateral by the same amount.`,
    why: 'The account now holds collateral that covers what Alice may owe Hub. The chain checks the signatures and that the amounts net to zero.',
    tradfiParallel: 'Delivery of collateral against a signed instruction: final on-chain once the block is final; legal finality depends on system designation.',
    keyMetrics: [`Submitted, reserve → collateral: ${usdc(COLLATERAL)}`],
  });
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'settle_execute', data: { counterpartyEntityId: HUB_ID } }],
  }]);
  await converge(env, 20);
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
  await syncChain(env, 5);
  const clearedAccount = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID);
  assert(!clearedAccount?.state.settlementWorkspace, 'Executed auto-approved workspace should finalize and clear', env);
  const moveFunded = await readMoveMoney();
  assert(moveFunded[0] === moveBefore[0] - COLLATERAL, 'R2C must debit exactly the collateral amount from reserve', env);
  assert(moveFunded[1] === moveBefore[1], 'R2C must preserve peer reserve', env);
  assert(moveFunded[2] === moveBefore[2] + COLLATERAL, 'R2C must credit exactly the collateral amount', env);

  snap(env, 'Collateral returned to reserve', {
    description: 'Alice withdraws the collateral',
    phase: 'execute',
    what: `The inverse settlement moves the ${usdc(COLLATERAL)} of collateral back to Alice\'s reserve through the same signed path.`,
    why: 'Collateral is not trapped, but it leaves the account only with the counterparty\'s signature. The on-chain balances return exactly to where they started.',
    tradfiParallel: 'Releasing pledged collateral once the exposure it covered is gone.',
    keyMetrics: [`Proposed, collateral → reserve: ${usdc(COLLATERAL)}`],
  });

  // Exercise the inverse through the same signed settlement and J watcher path.
  await process(env, [{
    entityId: ALICE_ID, signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'settle_propose', data: {
      counterpartyEntityId: HUB_ID,
      ops: [{ type: 'c2r', tokenId: USDC_TOKEN_ID, amount: COLLATERAL }],
      memo: 'Move collateral back to reserve',
    } }],
  }]);
  await converge(env, 20);
  // Withdrawal must reserve the full departing share on both committed replicas:
  // otherwise Alice could spend that same collateral before J finality.
  for (const [owner, peer] of [[ALICE_ID, HUB_ID], [HUB_ID, ALICE_ID]] as const) {
    const withdrawalDelta = findReplica(env, owner)[1].state.accounts.get(peer)?.state.deltas.get(USDC_TOKEN_ID);
    assert(withdrawalDelta, 'C2R USDC delta should exist on both replicas', env);
    assert((aliceIsLeft ? withdrawalDelta.leftHold : withdrawalDelta.rightHold) === COLLATERAL,
      'C2R must hold exactly the withdrawn collateral share on both replicas', env);
    assert((aliceIsLeft ? withdrawalDelta.rightHold : withdrawalDelta.leftHold) === 0n,
      'C2R must preserve peer capacity', env);
  }
  await process(env, [{
    entityId: ALICE_ID, signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'settle_execute', data: { counterpartyEntityId: HUB_ID } }],
  }]);
  await converge(env, 20);
  await process(env, [{ entityId: ALICE_ID, signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);
  await syncChain(env, 5);
  const moveReturned = await readMoveMoney();
  assert(moveReturned.every((value, index) => value === moveBefore[index]), 'R2C/C2R round trip must conserve exact chain balances', env);
  assert(!findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID)?.state.settlementWorkspace,
    'C2R workspace must clear after chain finality', env);
  console.log(`MOVE_ROUND_TRIP_OK amount=${COLLATERAL} reserve=exact collateral=exact peerReserve=unchanged`);
  // A presentation starts here: the setup and the collateral round trip are summarised.
  tell(env, {
    title: 'Starting point: two banks, one account',
    what: `On a local test chain, Alice and Hub each hold ${usdc(RESERVE)} of test balance on the Depository and share one bilateral account with a ${usdc(CREDIT)} credit line each way. They have already moved ${usdc(COLLATERAL)} of collateral into the account and back out, each time with both signatures.`,
    why: 'Collateral moves on-chain only through a settlement both banks sign; payments between them stay in the account.',
    tradfiParallel: 'A bilateral relationship with credit limits both ways and collateral posted and released by mutual instruction.',
    keyMetrics: [`Reserves: ${usdc(RESERVE)} each`, `Credit: ${usdc(CREDIT)} each way`, 'Collateral: 0 USDC'],
    focusEntityIds: [ALICE_ID, HUB_ID],
    condensePrior: true,
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // GROSS FLOWS: payments in both directions inside the account
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 GROSS FLOWS: payments both ways');
  const payInside = async (fromId: string, fromSigner: string, toId: string, amount: bigint, memo: string) => {
    await process(env, [{
      entityId: fromId,
      signerId: fromSigner,
      entityTxs: [{
        type: 'directPayment',
        data: { targetEntityId: toId, tokenId: USDC_TOKEN_ID, amount, route: [fromId, toId], deliveryMode: 'direct', description: memo },
      }],
    }]);
    await converge(env, 20);
  };
  const aliceView = () => {
    const delta = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID)?.state.deltas.get(USDC_TOKEN_ID);
    assert(delta, 'Alice-Hub USDC delta missing', env);
    return deriveDelta(delta, findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID)!.state.leftEntity === ALICE_ID);
  };
  snap(env, `Alice pays Hub ${usdc(ALICE_PAYS)}`, {
    phase: 'pay',
    what: `Alice pays Hub ${usdc(ALICE_PAYS)} inside their account. Both sign the new account state; nothing goes on-chain. Alice now owes Hub ${usdc(ALICE_PAYS)}, within the credit line Hub gave her.`,
    why: 'A payment inside an account changes only its net position.',
    tradfiParallel: 'A bilateral payment on a credit line, confirmed by both banks at once.',
    keyMetrics: [`Alice owes Hub: ${usdc(ALICE_PAYS)}`],
  });
  await payInside(ALICE_ID, ALICE_SIGNER, HUB_ID, ALICE_PAYS, 'Alice pays Hub');
  snap(env, `Hub pays Alice ${usdc(HUB_PAYS)}`, {
    phase: 'pay',
    what: `Hub pays Alice ${usdc(HUB_PAYS)} over the same account, in the other direction. The two payments offset inside it.`,
    why: 'Flows in both directions accumulate as one net position; only that would ever need settling.',
    tradfiParallel: 'Bilateral netting by construction.',
    keyMetrics: [`Hub → Alice: ${usdc(HUB_PAYS)}`],
  });
  await payInside(HUB_ID, HUB_SIGNER, ALICE_ID, HUB_PAYS, 'Hub pays Alice');
  assert(aliceView().inOwnCredit === NET_OWED, `Alice should owe Hub exactly ${NET_OWED}, got ${aliceView().inOwnCredit}`, env);
  tell(env, {
    title: `Net position: Alice owes Hub ${usdc(NET_OWED)}`,
    what: `${usdc(ALICE_PAYS + HUB_PAYS)} of payments in both directions leave one net position: Alice owes Hub ${usdc(NET_OWED)}. Nothing has moved on-chain, and the debt is unsecured: the collateral went back to Alice's reserve.`,
    why: 'Hub carries this exposure within the credit line it granted. Settling it needs one transfer of the net amount, not one per payment.',
    tradfiParallel: 'A bilateral net position waiting for settlement.',
    keyMetrics: [`Gross bilateral flow: ${usdc(ALICE_PAYS + HUB_PAYS)}`, `Net, Alice → Hub: ${usdc(NET_OWED)}`, 'Moved on-chain: 0 USDC'],
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 4: SETTLEMENT WORKSPACE UPDATE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 4: Settlement Workspace Update');

  // Start with a real unsigned negotiation: Alice offers to settle part of her
  // debt. Hub's claim in the account would shrink (ondelta moves toward zero),
  // so Hub's safety predicate must require an explicit decision.
  const manualOps: SettlementOp[] = [{
    type: 'rawDiff',
    tokenId: USDC_TOKEN_ID,
    leftDiff: -PARTIAL_OFFER,
    rightDiff: PARTIAL_OFFER,
    collateralDiff: 0n,
    ondeltaDiff: PARTIAL_OFFER,
  }];

  snap(env, 'Negotiation opens: Alice offers to settle part', {
    description: `Alice offers to settle ${usdc(PARTIAL_OFFER)}`,
    phase: 'propose',
    what: `Alice proposes to settle ${usdc(PARTIAL_OFFER)} of her ${usdc(NET_OWED)} debt now: that amount would move from her reserve to Hub's, and her debt in the account would fall by the same. Hub's claim in the account would shrink, so Hub does not sign automatically.`,
    why: 'A bank signs only what it has decided to accept. An unsigned proposal moves nothing.',
    tradfiParallel: 'A settlement instruction waiting for the counterparty\'s confirmation.',
    keyMetrics: [`Proposed: ${usdc(PARTIAL_OFFER)}`, 'Hub signature: none'],
  });

  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{
      type: 'settle_propose',
      data: {
        counterpartyEntityId: HUB_ID,
        ops: manualOps,
        memo: 'Manual negotiation reset proposal'
      }
    }]
  }]);

  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  const manualProposalAccount = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID);
  assert(manualProposalAccount?.state.settlementWorkspace?.revision === 1, 'Manual workspace should start at revision 1', env);
  assert(!manualProposalAccount.state.settlementWorkspace[hubHankoField], 'Manual negotiation workspace should be unsigned before update', env);

  // Hub counters with the whole net position. Alice's reserve falls, so this
  // also remains unsigned until TEST 5 explicitly approves it.
  const counterOps: SettlementOp[] = [{
    type: 'rawDiff',
    tokenId: USDC_TOKEN_ID,
    leftDiff: -NET_OWED,
    rightDiff: NET_OWED,
    collateralDiff: 0n,
    ondeltaDiff: NET_OWED,
  }];

  snap(env, 'Hub counter-proposes: settle the whole net', {
    description: `Hub asks to settle the full ${usdc(NET_OWED)}`,
    phase: 'update',
    what: `Hub replaces the terms: settle the whole net position. Alice pays ${usdc(NET_OWED)} from her reserve to Hub's, and her ${usdc(NET_OWED)} debt in the account is cleared. This is version 2 of the proposal. Hub's outgoing Account capacity is held while its net claim is cleared; Alice's reserve debit is enforced on-chain.`,
    why: 'Both banks edit one shared proposal. Only the bank that did not make the last change can approve it, so nobody approves its own terms.',
    tradfiParallel: 'Matching a settlement instruction between two back offices before it is released.',
    keyMetrics: [`Proposed: ${usdc(NET_OWED)} (full net)`, 'Proposal version: 2'],
  });

  await process(env, [{
    entityId: HUB_ID,
    signerId: HUB_SIGNER,
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
  assert(aliceAccount2?.state.settlementWorkspace?.revision === 2, 'Version should be 2 after update', env);
  // Verify compiled ops match expected values
  const { diffs: compiledDiffs } = compileOps(aliceAccount2.state.settlementWorkspace.ops, aliceAccount2.state.settlementWorkspace.lastModifiedByLeft);
  const firstCompiledDiff = compiledDiffs[0];
  assert(firstCompiledDiff, 'Compiled settlement diff should exist', env);
  assert(firstCompiledDiff.leftDiff === -NET_OWED, 'Compiled diff should reflect update (Alice leftDiff)');
  assert(firstCompiledDiff.rightDiff === NET_OWED, 'Compiled diff should reflect update (Hub rightDiff)');
  assert(firstCompiledDiff.ondeltaDiff === NET_OWED, 'Compiled diff should clear the net position (ondelta)');
  const counterDelta = aliceAccount2.state.deltas.get(USDC_TOKEN_ID);
  assert(counterDelta, 'Counter-proposal USDC delta should exist', env);
  assert(counterDelta.leftHold === 0n && counterDelta.rightHold === NET_OWED,
    'Net settlement must hold Hub capacity, not the reserve-paying Alice side', env);

  console.log(`✅ Settlement updated by Hub`);
  console.log(`   New revision: ${aliceAccount2.state.settlementWorkspace.revision}`);

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 5: SETTLEMENT APPROVE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 5: Settlement Approve');

  snap(env, 'Alice approves', {
    description: 'Both signatures collected',
    phase: 'approve',
    what: 'Alice signs version 2. The proposal now carries both signatures and a pre-signed account state for after the settlement.',
    why: 'It can now be submitted. If anyone stalls afterwards, the pre-signed post-settlement state still lets each side recover its funds.',
    tradfiParallel: 'A matched instruction, released for settlement with both counterparties\' authorisation.',
    keyMetrics: ['Signatures: 2 of 2', 'Ready to submit'],
  });

  // Alice approves (counterparty of Hub's update — only counterparty of lastModifier can approve)
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{
      type: 'settle_approve',
      data: {
        counterpartyEntityId: HUB_ID,
        workspaceHash: aliceAccount2.state.settlementWorkspace.workspaceHash,
      }
    }]
  }]);

  const aliceHankoField3 = aliceIsLeft ? 'leftHanko' : 'rightHanko';
  await processUntil(env, () => {
    const aliceWorkspace = findReplica(env, ALICE_ID)[1].state.accounts
      .get(HUB_ID)?.state.settlementWorkspace;
    const hubWorkspace = findReplica(env, HUB_ID)[1].state.accounts
      .get(ALICE_ID)?.state.settlementWorkspace;
    return Boolean(
      aliceWorkspace?.status === 'ready_to_submit' &&
      hubWorkspace?.status === 'ready_to_submit' &&
      aliceWorkspace.postSettlementDisputeProof?.[aliceHankoField3] &&
      hubWorkspace.postSettlementDisputeProof?.[aliceHankoField3],
    );
  }, 20, 'settlement approval committed bilaterally', undefined, () => {
    console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20 }));
    for (const entityId of [ALICE_ID, HUB_ID]) {
      const replica = findReplica(env, entityId)[1];
      const counterparty = entityId === ALICE_ID ? HUB_ID : ALICE_ID;
      const account = replica.state.accounts.get(counterparty);
      console.log(`SETTLEMENT_APPROVAL_TIMEOUT:${entityId.slice(-4)}:${JSON.stringify({
        entityHeight: replica.state.height,
        deferred: replica.state.deferredAccountProposals?.get(counterparty) ?? null,
        accountHeight: account?.currentHeight ?? null,
        mempool: account?.mempool.map(tx => tx.type) ?? [],
        pendingFrame: account?.pendingFrame?.height ?? null,
        pendingInput: account?.pendingAccountInput?.kind ?? null,
        nextProofNonce: account?.proofHeader.nextProofNonce ?? null,
        workspaceStatus: account?.state.settlementWorkspace?.status ?? null,
        leftHanko: Boolean(account?.state.settlementWorkspace?.leftHanko),
        rightHanko: Boolean(account?.state.settlementWorkspace?.rightHanko),
      })}`);
    }
  });

  // Verify Alice's hanko is set on both sides (via bilateral frame consensus)
  const aliceAccount3 = findReplica(env, ALICE_ID)[1].state.accounts.get(HUB_ID);
  assert(
    aliceAccount3?.state.settlementWorkspace?.postSettlementDisputeProof?.[aliceHankoField3],
    'Alice should have signed the exact post-settlement dispute proof',
    env,
  );
  assert(
    aliceAccount3.state.settlementWorkspace.status === 'ready_to_submit',
    'Settlement should be ready after both role-aware Hankos',
    env,
  );

  // Hub receives Alice's post-settlement recovery Hanko. Because Alice is the
  // executor, her cooperative settlement Hanko is intentionally absent.
  const hubAccount3 = findReplica(env, HUB_ID)[1].state.accounts.get(ALICE_ID);
  assert(
    hubAccount3?.state.settlementWorkspace?.postSettlementDisputeProof?.[aliceHankoField3],
    'Hub should have received Alice post-settlement proof Hanko',
    env,
  );
  assert(
    !hubAccount3.state.settlementWorkspace[aliceHankoField3],
    'Executor cooperative settlement Hanko must remain absent',
    env,
  );

  console.log(`✅ Alice approved settlement`);
  console.log(
    `   Alice post-proof hanko (${aliceHankoField3}): ` +
    `${aliceAccount3.state.settlementWorkspace.postSettlementDisputeProof[aliceHankoField3]?.slice(0, 20)}...`,
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 6: SETTLEMENT EXECUTE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 6: Settlement Execute');

  const reservesBeforeNet = await Promise.all([jadapter.getReserves(ALICE_ID, USDC_TOKEN_ID), jadapter.getReserves(HUB_ID, USDC_TOKEN_ID)] as const);
  snap(env, 'The net position settles on-chain', {
    description: `${usdc(NET_OWED)} moves from Alice to Hub on-chain`,
    phase: 'execute',
    what: `Alice submits the agreed settlement. One Depository transaction moves ${usdc(NET_OWED)} from Alice\'s reserve to Hub\'s and clears the account\'s net position.`,
    why: `${usdc(ALICE_PAYS + HUB_PAYS)} of payments in both directions need one on-chain transfer of ${usdc(NET_OWED)}. This is bilateral netting only: there is no netting across other accounts.`,
    tradfiParallel: `Bilateral net settlement: final on-chain once the block is final; legal finality depends on system designation. ${SETTLEMENT_ASSET}`,
    keyMetrics: [`Gross bilateral flow: ${usdc(ALICE_PAYS + HUB_PAYS)}`, `Settled on-chain: ${usdc(NET_OWED)}`, 'On-chain transactions: 1'],
  });

  // The executor was pinned when Alice created v1. Hub's v2 edit cannot silently
  // transfer execution authority, so Alice submits with Hub's Hanko.
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{
      type: 'settle_execute',
      data: { counterpartyEntityId: HUB_ID }
    }]
  }]);

  for (let i = 0; i < 3; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  // Broadcast the jBatch to chain
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{ type: 'j_broadcast', data: {} }]
  }]);

  // Sync chain events — poll JAdapter + process events through runtime
  await syncChain(env, 5);

  const aliceState = findReplica(env, ALICE_ID)[1].state;
  assert(!aliceState.accounts.get(HUB_ID)?.state.settlementWorkspace, 'Workspace should be cleared after execute', env);
  const reservesAfterNet = await Promise.all([jadapter.getReserves(ALICE_ID, USDC_TOKEN_ID), jadapter.getReserves(HUB_ID, USDC_TOKEN_ID)] as const);
  assert(reservesAfterNet[0] === reservesBeforeNet[0] - NET_OWED, 'Net settlement must debit Alice exactly the net amount', env);
  assert(reservesAfterNet[1] === reservesBeforeNet[1] + NET_OWED, 'Net settlement must credit Hub exactly the net amount', env);
  assert(aliceView().inOwnCredit === 0n && aliceView().outPeerCredit === 0n, 'Net settlement must clear the account position', env);
  tell(env, {
    title: 'Settled: the account is back to zero',
    what: `The block is final. Alice\'s reserve fell by ${usdc(NET_OWED)} to ${usdc(reservesAfterNet[0])}, Hub\'s rose to ${usdc(reservesAfterNet[1])}, and neither bank owes the other anything in the account.`,
    why: 'The credit lines are still open, so new payments can build a new net position until the next settlement.',
    tradfiParallel: SETTLEMENT_ASSET,
    keyMetrics: [`Alice reserve: ${usdc(reservesAfterNet[0])}`, `Hub reserve: ${usdc(reservesAfterNet[1])}`, 'Net position: 0 USDC'],
  });

  console.log(`✅ Settlement executed + on-chain confirmed`);

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 7: SETTLEMENT REJECT
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 TEST 7: Settlement Reject');

  // Create a proposal that transfers reserve away from Hub. It is not locally
  // safe for Hub, so it remains unsigned and can be explicitly rejected.
  const rejectionOps: SettlementOp[] = [{
    type: 'rawDiff',
    tokenId: USDC_TOKEN_ID,
    leftDiff: REJECTED_ASK,
    rightDiff: -REJECTED_ASK,
    collateralDiff: 0n,
    ondeltaDiff: 0n,
  }];
  snap(env, 'A proposal Hub will not accept', {
    description: `Alice asks Hub for ${usdc(REJECTED_ASK)}`,
    phase: 'reject',
    what: `Alice proposes that Hub transfer her ${usdc(REJECTED_ASK)} of reserves for nothing in return. It stays unsigned on Hub\'s side.`,
    why: 'A proposal is an offer, not an obligation. It cannot reach the chain without the counterparty\'s signature.',
    tradfiParallel: 'An unconfirmed settlement instruction.',
  });
  await process(env, [{
    entityId: ALICE_ID,
    signerId: ALICE_SIGNER,
    entityTxs: [{
      type: 'settle_propose',
      data: {
        counterpartyEntityId: HUB_ID,
        ops: rejectionOps,
        memo: 'Another proposal'
      }
    }]
  }]);

  for (let i = 0; i < 5; i++) {
    advanceScenarioTime(env);
    await process(env);
  }

  snap(env, 'Hub rejects: holds released', {
    description: 'Hub rejects the proposal',
    phase: 'reject',
    what: 'Hub rejects. The proposal is cleared on both sides and any amount held for it is released.',
    why: 'Rejection is as explicit and signed as approval, so both sides agree that nothing is pending.',
    tradfiParallel: 'An unmatched instruction cancelled; earmarked funds released.',
    keyMetrics: ['Pending settlements: 0'],
  });

  // Hub rejects
  await process(env, [{
    entityId: HUB_ID,
    signerId: HUB_SIGNER,
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
  assert(!aliceAccount5?.state.settlementWorkspace, 'Workspace should be cleared after reject', env);

  console.log(`✅ Settlement rejected - workspace cleared`);

  // ══════════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n📋 CLEANUP');

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                    ✅ ALL SETTLEMENT TESTS PASSED                              ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  return env;
  } finally {
    cleanupStrictMode();
    console.log = originalLog;
  }
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
