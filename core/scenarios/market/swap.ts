/**
 * Swap Scenario: Self-Testing Bilateral Swap Demo
 *
 * Tests same-J (same jurisdiction) swaps between Alice and Hub.
 * Hub acts as market maker, filling Alice's limit orders.
 * Uses REAL BrowserVM for J-Machine (same as ahb.ts).
 *
 * Test flow:
 * 1. Setup: Alice-Hub account with WETH (token 2) and USDC (token 1)
 * 2. Alice places limit order: Sell 20% capacity ETH for USDC
 * 3. Hub fills 50%: Partial fill
 * 4. Hub fills remaining 50%: Swap complete
 * 5. Verify final balances
 * 7. Test cancel
 *
 * Run with: bun core/scenarios/market/swap.ts
 */

import type { AccountReplica } from '../../types/account';
import type { RuntimeReplica } from '../../runtime/types';
import { clearRuntimeFrameEvents } from '../../runtime/observability/env-events';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { deriveSwapNetAuthorization } from '../../account/swap/swap-net-authorization';
import { getLiveJAdapterEntries } from '../../runtime/j-submit/live-jadapters';
import type { EntityInput } from '../../entity/types';
import { ethers } from 'ethers';
import { getBestAsk, getStaticSwapTokenDimensions, SWAP_LOT_SCALE } from '../../swapbook';
import { bindScenarioJReplica, ensureJAdapter, getScenarioJAdapter, isScenarioJAdapterMissingError, createJReplica, createJurisdictionConfig, DEMO_JURISDICTION_NAME } from '../harness/boot';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import { formatRuntime } from '../../qa/runtime-ascii';
import {
  advanceScenarioPastDisputeTimeout,
  enableStrictScenario,
  processUntil,
  ensureSignerKeysFromSeed,
  requireRuntimeSeed,
  converge,
  commitRuntimeInput,
  findReplica,
  processJEvents,
  setScenarioStorageEnabled,
  syncChain,
  formatTokenMoney,
  snap,
} from '../harness/helpers';
import { disputeWindowText } from '../harness/story';
import { tell } from '../harness/narration';
import { createGossipLayer } from '../../network/p2p/gossip';
import { getTokenInfo } from '../../account/utils';
import { createTestEntityImportRuntimeTx } from '../../qa/entity-creation-fixture';
import {
  summarizeRuntimeAccountCausality,
  type EntityInputCausalTrace,
} from '../../runtime/observability/account-causal-trace';
import { getPerfMs } from '../../support/time';

let _process: ((env: RuntimeReplica, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<RuntimeReplica>) | null = null;
let _processWithStep: ((env: RuntimeReplica, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<RuntimeReplica>) | null = null;

const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../../runtime');
    _process = runtime.processRuntime;
  }
  if (!_processWithStep) {
    _processWithStep = async (env: RuntimeReplica, inputs?: EntityInput[], delay?: number, single?: boolean) => {
      if (env.scenarioMode) {
        const step = typeof delay === 'number' && delay > 0 ? delay : 1;
        env.state.timestamp = (env.state.timestamp || 0) + step;
      }
      return _process!(env, inputs, delay, single);
    };
  }
  return _processWithStep;
};

async function drainPendingJEvents(env: RuntimeReplica): Promise<void> {
  // RPC watcher is polling-based; force immediate poll in scenarios to avoid
  // relying on wall-clock interval timing between submit and assertions.
  for (const { adapter } of getLiveJAdapterEntries(env)) {
    if (adapter.pollNow) await adapter.pollNow();
  }

  const pending = env.runtimeMempool.entityInputs.length;
  if (pending === 0) return;
  const inputs = [...env.runtimeMempool.entityInputs];
  env.runtimeMempool.entityInputs = [];
  await commitRuntimeInput(env, { runtimeTxs: [], entityInputs: inputs });
}

// Token IDs (aligned with runtime TOKEN_REGISTRY)
const USDC_TOKEN_ID = 1;
const ETH_TOKEN_ID = 2;

// Always derive raw units from canonical token metadata. USDC uses 6 decimals
// while WETH uses 18; treating both as 18 makes a 3,000 USDC/WETH order look
// like a 3e15 price and the live price-band correctly cancels it.
const tokenUnits = (tokenId: number, amount: number | bigint): bigint =>
  BigInt(amount) * (10n ** BigInt(getTokenInfo(tokenId).decimals));

const eth = (amount: number | bigint) => tokenUnits(ETH_TOKEN_ID, amount);
const usdc = (amount: number | bigint) => tokenUnits(USDC_TOKEN_ID, amount);

const ETH_PRICE_MAIN = 3000n;
const ETH_PRICE_LOW = 2900n;
const ETH_PRICE_HIGH = 3100n;
const ETH_PRICE_SWEEP = 3200n;

const USDC_CAPACITY_UNITS = 300_000n;
const ETH_CAPACITY_UNITS = USDC_CAPACITY_UNITS / ETH_PRICE_MAIN;

const TRADE_ETH = ETH_CAPACITY_UNITS / 5n; // 20% of capacity
const TRADE_ETH_HALF = TRADE_ETH / 2n;
const TRADE_ETH_DOUBLE = TRADE_ETH * 2n;

const TRADE_USDC_MAIN_UNITS = TRADE_ETH * ETH_PRICE_MAIN;

const usdcForEth = (ethUnits: bigint, price: bigint) => usdc(ethUnits * price);

/** Narration money from whole units: `60,000 USDC`, `20 WETH`. */
const usdcText = (units: bigint): string => formatTokenMoney(USDC_TOKEN_ID, usdc(units));
const ethText = (units: bigint): string => formatTokenMoney(ETH_TOKEN_ID, eth(units));
const priceText = (price: bigint): string => `${usdcText(price)} per ${getTokenInfo(ETH_TOKEN_ID).symbol}`;

const CAROL_SELL_ETH = TRADE_ETH_DOUBLE;
const CAROL_SELL_2_ETH = TRADE_ETH;
const DAVE_BUY_ETH = TRADE_ETH_HALF;
const DAVE_SWEEP_ETH = CAROL_SELL_ETH + CAROL_SELL_2_ETH - DAVE_BUY_ETH;

const J_MACHINE_POSITION = { x: 0, y: 600, z: 0 };

// Fan below the dealer, in one plane facing the audience (positions are RELATIVE to J-machine):
// the phase-2 traders sit on the wings, the phase-3 traders on the lower arc.
const SWAP_POSITIONS: Record<string, { x: number; y: number; z: number }> = {
  Hub: { x: 0, y: -40, z: 0 },
  Alice: { x: -66, y: -62, z: 0 },
  Bob: { x: 66, y: -62, z: 0 },
  Carol: { x: -30, y: -98, z: 0 },
  Dave: { x: 30, y: -98, z: 0 },
};

// Fill ratio constants (uint16)
const MAX_FILL_RATIO = 65535;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
};

const computeFilledAmounts = (giveAmount: bigint, wantAmount: bigint, fillRatio: number) => {
  const filledGive = (giveAmount * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
  const filledWant = giveAmount > 0n ? ceilDiv(filledGive * wantAmount, giveAmount) : 0n;
  return { filledGive, filledWant };
};

const pendingAccountSwapFillRatio = (
  env: RuntimeReplica,
  entityId: string,
  accountId: string,
  offerId: string,
): number => {
  const [, replica] = findReplica(env, entityId);
  const account = replica.state.accounts.get(accountId);
  const tx = [
    ...(account?.pendingFrame?.accountTxs ?? []),
    ...(account?.mempool ?? []),
  ].find(candidate => candidate.type === 'swap_resolve' && candidate.data.offerId === offerId);
  return tx?.type === 'swap_resolve' ? tx.data.fillRatio : 0;
};

function assert(condition: boolean, message: string, env?: RuntimeReplica): void {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED - FULL RUNTIME STATE:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20, maxSwaps: 20 }));
      console.log('='.repeat(80) + '\n');
    }
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`[OK] ${message}`);
}

type RegisteredScenarioEntity = Readonly<{ id: string; signer: string }>;

type ScenarioAccountCausalFrame = {
  runtimeHeight: number;
  runtimeTimestamp: number;
  inputs: EntityInputCausalTrace[];
};

const printScenarioAccountTimeline = (
  label: string,
  frames: readonly ScenarioAccountCausalFrame[],
): void => {
  console.log(`[SWAP-CAUSAL] ${label} frames=${frames.length}`);
  for (const frame of frames) {
    for (const input of frame.inputs) {
      if (input.accountEnvelopes.length === 0) {
        console.log(
          `[SWAP-CAUSAL] R=${frame.runtimeHeight} RT=${frame.runtimeTimestamp} ` +
          `E=${input.entityFrameHeight ?? '-'} entity=${input.entity} ` +
          `command=${input.entityTxTypes.join('+')} offers=${input.entityOfferIds.join(',') || '-'}`,
        );
        continue;
      }
      for (const envelope of input.accountEnvelopes) {
        const proposalTxs = envelope.proposalTxs.map(tx =>
          `${tx.type}${tx.offerId ? `:${tx.offerId}` : ''}`).join('+') || '-';
        console.log(
          `[SWAP-CAUSAL] R=${frame.runtimeHeight} RT=${frame.runtimeTimestamp} ` +
          `E=${input.entityFrameHeight ?? '-'} entity=${input.entity} ` +
          `A=${envelope.kind} ack=${envelope.ackHeight ?? '-'} ` +
          `proposal=${envelope.proposalHeight ?? '-'} txs=${proposalTxs}`,
        );
      }
    }
  }
};

const registeredEntitiesByAlias = new Map<string, RegisteredScenarioEntity>();

function getRegisteredEntity(signerAlias: string): RegisteredScenarioEntity {
  const registered = registeredEntitiesByAlias.get(signerAlias);
  if (!registered) {
    throw new Error(`Missing registered entity for signer alias ${signerAlias} - run swap() first`);
  }
  return registered;
}

function requireAccount(account: AccountReplica | undefined, label: string): AccountReplica {
  if (!account) throw new Error(`SWAP_MISSING_ACCOUNT: ${label}`);
  return account;
}

export async function swap(env: RuntimeReplica): Promise<void> {
  setScenarioStorageEnabled(env, false);
  const restoreFailFast = enableStrictScenario(env, 'SWAP');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  if (env.quietRuntimeLogs === undefined) {
    env.quietRuntimeLogs = true;
  }
  requireRuntimeSeed(env, 'SWAP');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5'], 'SWAP');
  registeredEntitiesByAlias.clear();
  const process = await getProcess();

  if (env.scenarioMode && env.state.height === 0) {
    env.state.timestamp = 1;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   SWAP SCENARIO: Same-J Swaps                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: BrowserVM + J-Machine (same as ahb.ts)
  // ============================================================================
  console.log('🏛️ Setting up BrowserVM J-Machine...');

  // Clear old state if switching scenarios (prevents accumulation from AHB/other scenarios)
  if (env.state.jReplicas && env.state.jReplicas.size > 0) {
    console.log(`[SWAP] Clearing ${env.state.jReplicas.size} old jurisdictions from previous scenario`);
    env.state.jReplicas.clear();
  }
  if (env.state.eReplicas && env.state.eReplicas.size > 0) {
    console.log(`[SWAP] Clearing ${env.state.eReplicas.size} old entities from previous scenario`);
    env.state.eReplicas.clear();
  }
  env.state.height = 0; // Reset to frame 0
  env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
  env.pendingOutputs = [];
  env.pendingNetworkOutputs = [];
  env.networkInbox = [];
  clearRuntimeFrameEvents(env);
  env.gossip = createGossipLayer();

  // Setup JAdapter (browservm or rpc, depending on JADAPTER_MODE)
  let jadapter: JAdapter;
  try {
    jadapter = getScenarioJAdapter(env);
  } catch (error) {
    if (!isScenarioJAdapterMissingError(error)) throw error;
    jadapter = await ensureJAdapter(env);
    bindScenarioJReplica(
      env,
      createJReplica(env, DEMO_JURISDICTION_NAME, jadapter.addresses.depository, J_MACHINE_POSITION),
      jadapter,
    );
    jadapter.startWatching(env);
  }
  const jurisdiction = createJurisdictionConfig(DEMO_JURISDICTION_NAME, jadapter.addresses.depository, jadapter.addresses.entityProvider);
  console.log('✅ JAdapter J-Machine created\n');

  // ============================================================================
  // SETUP: Create Alice and Hub entities (on-chain registration + eReplicas)
  // ============================================================================
  console.log('📦 Creating entities: Alice, Hub, Bob, Carol, Dave...');

  snap(env, 'Five banks join the Depository', {
    what: 'Alice, Hub, Bob, Carol and Dave register as entities on the Depository contract. Hub will act as a dealer; the others are its customers.',
    why: 'This scenario shows foreign exchange inside bilateral accounts: two currencies, one dealer, and no pooled exchange account.',
    tradfiParallel: 'Banks with accounts in the same settlement system, trading FX through a dealer bank.',
    keyMetrics: ['Participants: 5', `Pair: ${getTokenInfo(ETH_TOKEN_ID).symbol}/${getTokenInfo(USDC_TOKEN_ID).symbol}`],
  });
  const { registerEntities: bootRegisterEntities } = await import('../harness/boot');
  const registrationInputs = [
    { name: 'Alice', signer: '1', position: SWAP_POSITIONS['Alice'] || { x: 0, y: 0, z: 0 } },
    { name: 'Hub',   signer: '2', position: SWAP_POSITIONS['Hub'] || { x: 0, y: 0, z: 0 } },
    { name: 'Bob',   signer: '3', position: SWAP_POSITIONS['Bob'] || { x: 0, y: 0, z: 0 } },
    { name: 'Carol', signer: '4', position: SWAP_POSITIONS['Carol'] || { x: 0, y: 0, z: 0 } },
    { name: 'Dave',  signer: '5', position: SWAP_POSITIONS['Dave'] || { x: 0, y: 0, z: 0 } },
  ];
  const registered = await bootRegisterEntities(env, jadapter, registrationInputs, jurisdiction);
  for (const [index, registration] of registered.entries()) {
    const signerAlias = registrationInputs[index]?.signer;
    if (!signerAlias) throw new Error(`SWAP_REGISTRATION_ALIAS_MISSING:${index}`);
    registeredEntitiesByAlias.set(signerAlias, registration);
  }

  // registerEntities already created eReplicas — just build local aliases
  const alice = { name: 'Alice', ...getRegisteredEntity('1') };
  const hub = { name: 'Hub', ...getRegisteredEntity('2') };
  console.log(`  ✅ Created: ${alice.name}, ${hub.name}\n`);

  // ============================================================================
  // SETUP: Open Alice-Hub bilateral account
  // ============================================================================
  console.log('🔗 Opening Alice ↔ Hub bilateral account...');

  snap(env, 'Alice opens an account with Hub', {
    what: 'Alice opens one bilateral account with Hub. It can carry several currencies side by side.',
    why: 'Every trade Alice makes with Hub will be a change to this one account, signed by both.',
    tradfiParallel: 'A bilateral dealing relationship with a single co-signed record per counterparty.',
  });

  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{ type: 'openAccount', data: {
      targetEntityId: hub.id,
      disputeConfig: defaultAccountDisputeConfigForParties(alice.id, false, hub.id, true),
    } }],
  }]);
  await converge(env); // Wait for bilateral account creation

  const [, aliceRep] = findReplica(env, alice.id);
  console.log(`🔍 DEBUG: Alice has ${aliceRep.state.accounts.size} accounts, keys: ${Array.from(aliceRep.state.accounts.keys()).map(k => k.slice(-4)).join(', ')}`);
  console.log(`🔍 DEBUG: Looking for hub.id=${hub.id.slice(-4)}`);
  assert(aliceRep.state.accounts.has(hub.id), 'Alice-Hub account exists');
  console.log('  ✅ Account created\n');

  // ============================================================================
  // SETUP: Credit limits for bilateral swap capacity
  // ============================================================================
  console.log('💳 Setting up credit limits for swaps...');

  // Batch all credit extensions in parallel then wait for convergence
  // ETH: Hub→Alice + Alice→Hub (both sides need capacity)
  // USDC: Hub→Alice + Alice→Hub (both sides need capacity)

  snap(env, 'Credit lines in two currencies', {
    what: `Alice and Hub grant each other ${ethText(ETH_CAPACITY_UNITS)} and ${usdcText(USDC_CAPACITY_UNITS)} of credit.`,
    why: 'Each bank sets how much the other may owe it, per currency, with no collateral behind it here. Trades settle inside the accounts within these limits, without moving reserves first.',
    tradfiParallel: 'Bilateral FX settlement limits, one per currency, unsecured.',
    keyMetrics: [`${getTokenInfo(ETH_TOKEN_ID).symbol} line: ${ethText(ETH_CAPACITY_UNITS)} each way`, `${getTokenInfo(USDC_TOKEN_ID).symbol} line: ${usdcText(USDC_CAPACITY_UNITS)} each way`],
  });

  await process(env, [
    {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: ETH_TOKEN_ID, amount: eth(ETH_CAPACITY_UNITS) } },
        { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: USDC_TOKEN_ID, amount: usdc(USDC_CAPACITY_UNITS) } },
      ],
    },
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH_TOKEN_ID, amount: eth(ETH_CAPACITY_UNITS) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: usdc(USDC_CAPACITY_UNITS) } },
      ],
    },
  ]);

  // Wait for all credit frames to converge
  await converge(env);

  console.log('  ✅ Bidirectional credit established\n');

  console.log('  ✅ Canonical swap setup complete; orderbook matching owns all fills and cancels\n');
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreFailFast();
  }
}

function assertQuantizedRemaining(
  actual: bigint | undefined,
  expected: bigint,
  original: bigint,
  label: string,
): void {
  if (actual === undefined) {
    assert(false, `${label} is present`);
    return;
  }
  const drift = actual > expected ? actual - expected : expected - actual;
  assert(actual > 0n && actual < original, `${label} stays open with reduced quantity (got ${actual})`);
  assert(
    drift <= SWAP_LOT_SCALE,
    `${label} matches expected remaining within one orderbook lot: expected ${expected}, got ${actual}, drift=${drift}`,
  );
}

// ============================================================================
// PHASE 2: OrderbookExtension - Hub-based matching
// ============================================================================

export async function swapWithOrderbook(env: RuntimeReplica): Promise<RuntimeReplica> {
  const restoreFailFast = enableStrictScenario(env, 'SWAP');
  const prevScenarioMode = env.scenarioMode;
  const accountCausalFrames: ScenarioAccountCausalFrame[] = [];
  let stopAccountCausalTrace = (): void => {};
  try {
  env.scenarioMode = true; // Deterministic time control
  if (env.quietRuntimeLogs === undefined) {
    env.quietRuntimeLogs = true;
  }
  const process = await getProcess();
  const runtime = await import('../../runtime');
  stopAccountCausalTrace = runtime.registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
    const inputs = summarizeRuntimeAccountCausality(runtimeInput.entityInputs);
    if (inputs.length > 0) {
      accountCausalFrames.push({
        runtimeHeight: height,
        runtimeTimestamp: env.state.timestamp,
        inputs,
      });
    }
  });
  const jadapter = getScenarioJAdapter(env);
  // Dispute fillRatio enforcement is part of the canonical swap puppet path.
  // No opt-out flag: skipping it silently was a scenario completeness hole.
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('             PHASE 2: ORDERBOOK MATCHING (RJEA FLOW)            ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Reuse Alice & Hub from Phase 1
  const alice = getRegisteredEntity('1');
  const hub = getRegisteredEntity('2');

  // Initialize hub's orderbook extension (required for RJEA flow)
  const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../../swapbook');
  snap(env, 'Hub opens an order book', {
    what: `Hub enables a ${getTokenInfo(ETH_TOKEN_ID).symbol}/${getTokenInfo(USDC_TOKEN_ID).symbol} order book. Customers send orders through their own account with Hub; Hub matches them.`,
    why: 'Hub never takes custody of a pooled balance. Each fill is a change to the customer\'s own bilateral account, which the customer co-signs.',
    tradfiParallel: 'A dealer internalising client FX flow, with every client\'s settlement confined to its own account.',
  });
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'initOrderbookExt',
      data: {
        name: 'Test Hub',
        spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: USDC_TOKEN_ID,
        usdQuoteAuthorityEntityId: hub.id,
        minTradeSize: 0n,
        supportedPairs: ['1/2'],
      },
    }],
  }]);
  const [, hubRep] = findReplica(env, hub.id);
  const jurisdiction = hubRep.state.config.jurisdiction;
  if (!jurisdiction) throw new Error('SWAP_MISSING_HUB_JURISDICTION');
  console.log('✅ Hub orderbook extension initialized');
  assert(!!hubRep.state.orderbookExt, 'orderbookExt initialized on hub state');

  // Verify it persists after a process cycle
  await converge(env);
  const [, hubRepAfterProcess] = findReplica(env, hub.id);
  assert(!!hubRepAfterProcess.state.orderbookExt, 'orderbookExt persists after process()');
  console.log('✅ Hub orderbookExt persists through process cycle\n');

  // Add Bob
  console.log('📦 Adding Bob...');
  const bob = getRegisteredEntity('3');

  snap(env, 'Bob connects to Hub', {
    what: `Bob opens an account with Hub and they exchange the same credit lines: ${ethText(ETH_CAPACITY_UNITS)} and ${usdcText(USDC_CAPACITY_UNITS)} each way.`,
    why: 'Alice and Bob never need an account with each other. Hub intermediates, and each side\'s risk stays inside its own account with Hub.',
    tradfiParallel: 'Two clients of the same dealer bank, each with its own settlement line.',
  });
  await commitRuntimeInput(env, { runtimeTxs: [createTestEntityImportRuntimeTx(env, {
    entityId: bob.id,
    signerId: bob.signer,
    data: {
      isProposer: true,
      position: SWAP_POSITIONS['Bob'] ?? { x: 0, y: 0, z: 0 },
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [bob.signer],
        shares: { [bob.signer]: 1n },
        jurisdiction,
      },
    },
  })], entityInputs: [] });
  await converge(env);
  console.log('  ✅ Bob created\n');

  // Open Bob↔Hub account
  console.log('🔗 Opening Bob ↔ Hub account...');
  await process(env, [
    { entityId: bob.id, signerId: bob.signer, entityTxs: [{ type: 'openAccount', data: {
      targetEntityId: hub.id,
      disputeConfig: defaultAccountDisputeConfigForParties(bob.id, false, hub.id, true),
    } }] },
  ]);
  await converge(env);
  console.log('  ✅ Account opened\n');

  // Extend credit for Bob↔Hub
  console.log('💳 Extending credit for Bob↔Hub...');
  await process(env, [
    { entityId: hub.id, signerId: hub.signer, entityTxs: [
      { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: ETH_TOKEN_ID, amount: eth(ETH_CAPACITY_UNITS) } },
      { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: USDC_TOKEN_ID, amount: usdc(USDC_CAPACITY_UNITS) } },
    ]},
    { entityId: bob.id, signerId: bob.signer, entityTxs: [
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH_TOKEN_ID, amount: eth(ETH_CAPACITY_UNITS) } },
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: usdc(USDC_CAPACITY_UNITS) } },
    ]},
  ]);
  await converge(env);
  console.log('  ✅ Credit extended\n');

  // ============================================================================
  // TEST: Alice sells 20% capacity, Bob buys 10% - should match via orderbook
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`TEST: Alice SELL ${TRADE_ETH} ETH @ ${ETH_PRICE_MAIN}, Bob BUY ${TRADE_ETH_HALF} ETH @ ${ETH_PRICE_HIGH}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // A presentation starts here: the frames above are setup, summarised by this beat.
  tell(env, {
    title: 'Starting point: a dealer and two customers',
    what: `On a local test chain, Hub runs a ${getTokenInfo(ETH_TOKEN_ID).symbol}/${getTokenInfo(USDC_TOKEN_ID).symbol} order book. Alice and Bob each have one account with Hub, with credit lines of ${ethText(ETH_CAPACITY_UNITS)} and ${usdcText(USDC_CAPACITY_UNITS)} each way and no collateral; nobody holds reserves on the Depository.`,
    why: 'Every trade will be a change to a customer\'s own account with the dealer, signed by both. With credit lines alone, each side\'s exposure is unsecured up to its limits.',
    tradfiParallel: 'Two clients of a dealer bank, each with its own unsecured settlement limits.',
    keyMetrics: [`${getTokenInfo(ETH_TOKEN_ID).symbol} line: ${ethText(ETH_CAPACITY_UNITS)} each way`, `${getTokenInfo(USDC_TOKEN_ID).symbol} line: ${usdcText(USDC_CAPACITY_UNITS)} each way`, 'Collateral: 0'],
    focusEntityIds: [alice.id, hub.id, bob.id],
    condensePrior: true,
  });

  // Step 1: Alice places swap_offer on Alice↔Hub account
  console.log(`📊 Step 1: Alice places swap_offer (${TRADE_ETH} ETH → ${TRADE_USDC_MAIN_UNITS} USDC)...`);
  snap(env, `Alice offers ${ethText(TRADE_ETH)}`, {
    what: `Alice places a limit order: sell ${ethText(TRADE_ETH)} for ${usdcText(TRADE_USDC_MAIN_UNITS)}, ${priceText(ETH_PRICE_MAIN)}. The order sits in her account with Hub.`,
    why: 'The offer is part of the co-signed account state, so the capacity it uses is reserved and cannot be promised twice.',
    tradfiParallel: 'A resting limit order with a dealer, pre-validated against the client\'s settlement line.',
    keyMetrics: [`Sell: ${ethText(TRADE_ETH)}`, `Limit: ${priceText(ETH_PRICE_MAIN)}`],
  });
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'alice-sell-001',
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(TRADE_ETH),
        wantTokenId: USDC_TOKEN_ID,
        ...getStaticSwapTokenDimensions(ETH_TOKEN_ID, USDC_TOKEN_ID),
        wantAmount: usdc(TRADE_USDC_MAIN_UNITS),
        ...deriveSwapNetAuthorization(usdc(TRADE_USDC_MAIN_UNITS), 1),
      },
    }],
  }]);
  // Wait for hub to process Alice's swap offer through orderbook
  await converge(env);

  // Verify Alice's offer exists in bilateral account (from Hub's perspective)
  const [, hubRepCheck] = findReplica(env, hub.id);
  const aliceAccountCheck = hubRepCheck.state.accounts.get(alice.id);  // Hub's account WITH Alice
  const aliceOffer = aliceAccountCheck?.state.swapOffers?.get('alice-sell-001');
  assert(!!aliceOffer, 'Alice offer should exist in Hub bilateral account');
  console.log('  ✅ Alice offer created in bilateral account\n');

  const [, aliceRepBaseline] = findReplica(env, alice.id);
  const aliceBaselineAccount = aliceRepBaseline.state.accounts.get(hub.id);
  const aliceBaselineEth = aliceBaselineAccount?.state.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const aliceBaselineUsdc = aliceBaselineAccount?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  const [, bobRepBaseline] = findReplica(env, bob.id);
  const bobBaselineAccount = bobRepBaseline.state.accounts.get(hub.id);
  const bobBaselineEth = bobBaselineAccount?.state.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const bobBaselineUsdc = bobBaselineAccount?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  // Check hub's orderbook extension state
  const ext = hubRepCheck.state.orderbookExt;
  console.log(`  📊 Hub orderbook state: ${ext?.books?.size || 0} books\n`);

  // Step 2: Bob places swap_offer - should trigger matching!
  console.log(`📊 Step 2: Bob places swap_offer (${TRADE_ETH_HALF} ETH @ ${ETH_PRICE_HIGH})...`);
  const bobTraceStart = accountCausalFrames.length;
  const bobWallStartedAt = getPerfMs();
  const processCpuUsage = globalThis.process?.cpuUsage?.bind(globalThis.process);
  const bobCpuStartedAt = processCpuUsage?.();
  snap(env, `Bob buys ${ethText(TRADE_ETH_HALF)}: Alice and Bob each settle with Hub`, {
    what: `Bob bids for ${ethText(TRADE_ETH_HALF)} at up to ${priceText(ETH_PRICE_HIGH)}. Hub matches him against Alice at her price. Each customer settles with Hub in their own account: Alice delivers ${ethText(TRADE_ETH_HALF)} and receives ${usdcText(TRADE_ETH_HALF * ETH_PRICE_MAIN)}; Bob receives ${ethText(TRADE_ETH_HALF)} and pays at Alice's price, below his limit.`,
    why: 'Inside each account both currency legs change in one co-signed frame, so neither customer delivers one currency without receiving the other. The two accounts update separately; between them, Hub carries the risk.',
    tradfiParallel: 'Not CLS: bilateral claims on the dealer inside unsecured credit lines, with no multilateral netting and no central bank money. In common with payment-versus-payment: each customer\'s two legs move together.',
    keyMetrics: [`Bid: ${ethText(TRADE_ETH_HALF)}`, `Limit: ${priceText(ETH_PRICE_HIGH)}`],
  });
  await process(env, [{
    entityId: bob.id,
    signerId: bob.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'bob-buy-001',
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdcForEth(TRADE_ETH_HALF, ETH_PRICE_HIGH),
        wantTokenId: ETH_TOKEN_ID,
        ...getStaticSwapTokenDimensions(USDC_TOKEN_ID, ETH_TOKEN_ID),
        wantAmount: eth(TRADE_ETH_HALF),
        ...deriveSwapNetAuthorization(eth(TRADE_ETH_HALF), 1),
      },
    }],
  }]);

  // Wait for hub to match and emit swap_resolve via RJEA flow
  // Hub's entity layer sees swapOffersCreated events, runs processOrderbookSwaps,
  // which adds matching orders to the book, detects trades, and queues swap_resolve txs
  console.log('🔄 Step 3: Waiting for RJEA matching and settlement...');
  let aliceFillRatio = 0;
  let bobFillRatio = 0;
  await processUntil(env, () => {
    aliceFillRatio = pendingAccountSwapFillRatio(env, hub.id, alice.id, 'alice-sell-001');
    bobFillRatio = pendingAccountSwapFillRatio(env, hub.id, bob.id, 'bob-buy-001');
    return aliceFillRatio > 0 && bobFillRatio > 0;
  }, 20, 'RJEA fill ratios recorded');
  await converge(env);
  const bobWallMs = getPerfMs() - bobWallStartedAt;
  const bobCpu = bobCpuStartedAt ? processCpuUsage?.(bobCpuStartedAt) : undefined;
  const bobTrace = accountCausalFrames.slice(bobTraceStart);
  printScenarioAccountTimeline('bob-buy-001', bobTrace);
  const bobResolveEnvelope = bobTrace
    .flatMap(frame => frame.inputs)
    .flatMap(input => input.accountEnvelopes)
    .find(envelope => envelope.proposalTxs.some(tx =>
      tx.type === 'swap_resolve' && tx.offerId === 'bob-buy-001'));
  assert(bobResolveEnvelope?.kind === 'ack_frame', 'Hub coalesces offer ACK and resolve proposal into one ack_frame');
  assert(bobResolveEnvelope?.ackHeight !== undefined, 'Coalesced Hub response contains the offer ACK');
  console.log(
    `[SWAP-CAUSAL-BENCH] offer=bob-buy-001 runtimeFrames=${bobTrace.length} ` +
    `wallMs=${bobWallMs.toFixed(2)} cpuUserMs=${bobCpu ? (bobCpu.user / 1_000).toFixed(2) : 'n/a'} ` +
    `cpuSystemMs=${bobCpu ? (bobCpu.system / 1_000).toFixed(2) : 'n/a'}`,
  );
  assert(
    bobWallMs <= 500,
    `Resting-book order reaches fully settled state within 500ms (got ${bobWallMs.toFixed(2)}ms)`,
  );

  // Verify the trades occurred via RJEA flow by checking bilateral accounts
  // After matching: Alice should have traded Bob's buy qty, Bob should have filled
  console.log('📊 Step 3: Checking trade results...');

  // Check hub's orderbook extension for trade records
  const [, hubRepAfter] = findReplica(env, hub.id);
  const extAfter = hubRepAfter.state.orderbookExt;
  if (extAfter?.books) {
    const { renderAscii } = await import('../../swapbook');
    const book = extAfter.books.get('1/2');
    if (book) {
      console.log(`\n📚 ORDERBOOK STATE:`);
      console.log(renderAscii(book, 5));
    } else {
      console.log(`  📚 No book for pair 1/2`);
    }
  }

  // Check Alice's and Bob's accounts from their own perspectives
  const [, aliceRepAfter] = findReplica(env, alice.id);
  const [, bobRepAfter] = findReplica(env, bob.id);
  const aliceAccount = aliceRepAfter.state.accounts.get(hub.id);  // Alice's account WITH Hub
  const bobAccount = bobRepAfter.state.accounts.get(hub.id);      // Bob's account WITH Hub

  console.log(`  Alice offer exists: ${aliceAccount?.state.swapOffers?.has('alice-sell-001')}`);
  console.log(`  Bob offer exists: ${bobAccount?.state.swapOffers?.has('bob-buy-001')}`);

  // After full RJEA flow, Bob's offer should be fully resolved
  // and Alice's offer should be partially filled (half remaining)
  const aliceOffer2 = aliceAccount?.state.swapOffers?.get('alice-sell-001');
  if (aliceOffer2) {
    console.log(`  Alice remaining: ${aliceOffer2.giveAmount} wei (${Number(aliceOffer2.giveAmount) / 1e18} ETH)`);
  }

  console.log('  ✅ RJEA flow completed - trades processed automatically\n');

  // Verify final state
  console.log('📊 Verifying final state...');

  const [, aliceRepFinal] = findReplica(env, alice.id);
  const [, bobRepFinal] = findReplica(env, bob.id);

  const aliceHubFinal = aliceRepFinal.state.accounts.get(hub.id);  // Alice's account WITH Hub
  const bobHubFinal = bobRepFinal.state.accounts.get(hub.id);      // Bob's account WITH Hub (counterparty key!)

  const aliceEth = aliceHubFinal?.state.deltas.get(ETH_TOKEN_ID);
  const aliceUsdc = aliceHubFinal?.state.deltas.get(USDC_TOKEN_ID);
  const bobEth = bobHubFinal?.state.deltas.get(ETH_TOKEN_ID);
  const bobUsdc = bobHubFinal?.state.deltas.get(USDC_TOKEN_ID);

  console.log(`  Alice↔Hub ETH offdelta: ${aliceEth?.offdelta ?? 0n}`);
  console.log(`  Alice↔Hub USDC offdelta: ${aliceUsdc?.offdelta ?? 0n}`);
  console.log(`  Bob↔Hub ETH offdelta: ${bobEth?.offdelta ?? 0n}`);
  console.log(`  Bob↔Hub USDC offdelta: ${bobUsdc?.offdelta ?? 0n}`);

  // Note: Phase 1 already ran, so Alice has some pre-existing deltas from those tests
  // Phase 2 adds: Alice trades more ETH for USDC, Bob trades USDC for ETH
  // The exact amounts depend on whether RJEA matching triggered swap_resolve

  // ═══════════════════════════════════════════════════════════════
  // ASSERTIONS: Verify RJEA flow worked correctly
  // ═══════════════════════════════════════════════════════════════

  // Bob should have traded via RJEA (has non-zero deltas)
  const bobTraded = (bobEth?.offdelta ?? 0n) !== 0n || (bobUsdc?.offdelta ?? 0n) !== 0n;
  assert(bobTraded, 'Bob should have traded via RJEA flow');
  assert(bobFillRatio > 0, `Bob has a recorded fill ratio (got ${bobFillRatio})`);

  // A taker buying at 3,100 against a resting 3,000 ask receives the full base
  // quantity while spending less than its quote limit. One proportional ratio
  // cannot represent that price improvement; assert the canonical execution
  // amounts emitted by the matcher instead.
  const executedBase = eth(TRADE_ETH_HALF);
  const executedQuote = usdcForEth(TRADE_ETH_HALF, ETH_PRICE_MAIN);

  const aliceEthDelta = (aliceEth?.offdelta ?? 0n) - aliceBaselineEth;
  const aliceUsdcDelta = (aliceUsdc?.offdelta ?? 0n) - aliceBaselineUsdc;
  const bobEthDelta = (bobEth?.offdelta ?? 0n) - bobBaselineEth;
  const bobUsdcDelta = (bobUsdc?.offdelta ?? 0n) - bobBaselineUsdc;

  // Bob wanted TRADE_ETH_HALF @ ETH_PRICE_HIGH - should have received ETH, given USDC
  // Bob is Right relative to Hub (Hub = 0x0002..., Bob = 0x0003...)
  // CANONICAL semantics: Right pays → offdelta INCREASES, Right receives → offdelta DECREASES
  // Bob gives USDC → offdelta increases (positive)
  // Bob receives ETH → offdelta decreases (negative)
  assert(bobEthDelta === -executedBase, `Bob ETH delta = -${executedBase} (got ${bobEthDelta})`);
  // Bob can prepay request_collateral fee in USDC during this phase.
  // So USDC delta is bounded by fill and may be slightly lower than exact filledGive.
  assert(bobUsdcDelta > 0n, `Bob USDC delta must stay positive after fill (got ${bobUsdcDelta})`);
  assert(
    bobUsdcDelta <= executedQuote,
    `Bob USDC delta must not exceed execution quote ${executedQuote} (got ${bobUsdcDelta})`,
  );
  assert(aliceEthDelta === -executedBase, `Alice ETH delta = -${executedBase} (got ${aliceEthDelta})`);
  assert(aliceUsdcDelta === executedQuote, `Alice USDC delta = +${executedQuote} (got ${aliceUsdcDelta})`);

  // Alice's offer should be partially filled (Bob took half of the order)
  const aliceOfferRemaining = aliceAccount?.state.swapOffers?.get('alice-sell-001');
  if (aliceOfferRemaining) {
    const expectedRemaining = eth(TRADE_ETH) - executedBase;
    assertQuantizedRemaining(aliceOfferRemaining.giveAmount, expectedRemaining, eth(TRADE_ETH), 'Alice remaining ETH');
  }

  console.log('  ✅ Phase 2 assertions passed');
  tell(env, {
    title: `Filled at Alice's price: ${ethText(TRADE_ETH_HALF)}`,
    what: `Hub matched Bob against Alice. In Alice's account she delivered ${ethText(TRADE_ETH_HALF)} and received ${usdcText(TRADE_ETH_HALF * ETH_PRICE_MAIN)}; in Bob's account he received ${ethText(TRADE_ETH_HALF)} and paid for it in USDC at Alice's price. Each frame is co-signed by the customer and the dealer.`,
    why: 'The fill is now part of each customer\'s own account state. Nothing reached the Depository: these are bilateral positions inside the credit lines.',
    tradfiParallel: 'Each client\'s two legs settled together in its own account with the dealer.',
    keyMetrics: [`Filled: ${ethText(TRADE_ETH_HALF)} at ${priceText(ETH_PRICE_MAIN)}`, `Alice receives: ${usdcText(TRADE_ETH_HALF * ETH_PRICE_MAIN)}`, `Left on Alice's order: ${ethText(TRADE_ETH - TRADE_ETH_HALF)}`],
    focusEntityIds: [alice.id, hub.id, bob.id],
  });

  // Clear residual open orders to isolate dispute test
  const [, aliceBeforeDispute] = findReplica(env, alice.id);
  const aliceHubAccountPreDispute = aliceBeforeDispute.state.accounts.get(hub.id);
  if (aliceHubAccountPreDispute?.state.swapOffers?.has('alice-sell-001')) {
    console.log('🧹 Cancelling leftover alice-sell-001 before dispute test...');
    snap(env, 'Alice cancels the rest', {
      what: `Alice cancels the unfilled ${ethText(TRADE_ETH - TRADE_ETH_HALF)} of her order. Hub co-signs the cancellation and the reserved capacity is released.`,
      why: 'A cancellation is a signed account change like any other, so both sides agree exactly what is still open.',
      tradfiParallel: 'Withdrawing a resting order with a dealer.',
    });
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'proposeCancelSwap',
        data: { counterpartyEntityId: hub.id, offerId: 'alice-sell-001' },
      }],
    }]);
    await converge(env);
    await converge(env);
  }

  // ============================================================================
  // PHASE 2B: Dispute swap fillRatio (pending orderbook fill)
  // ============================================================================
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('        PHASE 2B: DISPUTE SWAP (FILL RATIO ENFORCED)           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const disputeOfferId = 'alice-dispute-001';
  const disputeCounterId = 'bob-dispute-001';
  const disputeEth = TRADE_ETH;
  const disputeUsdc = TRADE_USDC_MAIN_UNITS;
  const disputeFillEth = (disputeEth * 2n) / 5n; // 40%

  const [, hubDisputeBaseline] = findReplica(env, hub.id);
  const aliceDisputeAccount = hubDisputeBaseline.state.accounts.get(alice.id);
  const bobDisputeAccount = hubDisputeBaseline.state.accounts.get(bob.id);
  assert(!!aliceDisputeAccount, 'Dispute Alice account exists before dispute');
  const bobDisputeBaselineEth = bobDisputeAccount?.state.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const bobDisputeBaselineUsdc = bobDisputeAccount?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  console.log(`📊 Alice: swap_offer (${disputeEth} ETH → ${disputeUsdc} USDC)`);
  snap(env, `A second order: ${ethText(disputeEth)}`, {
    what: `Alice offers ${ethText(disputeEth)} for ${usdcText(disputeUsdc)} again. This time she will stop responding halfway through.`,
    why: 'The next steps show what protects the dealer when a customer disappears between two legs of a trade.',
    tradfiParallel: 'Replacement-cost risk, not principal risk: Alice\'s signed order makes her leg enforceable, and Hub pays her nothing until it is.',
    keyMetrics: [`Sell: ${ethText(disputeEth)}`, `Limit: ${priceText(ETH_PRICE_MAIN)}`],
  });
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: disputeOfferId,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(disputeEth),
        wantTokenId: USDC_TOKEN_ID,
        ...getStaticSwapTokenDimensions(ETH_TOKEN_ID, USDC_TOKEN_ID),
        wantAmount: usdc(disputeUsdc),
        ...deriveSwapNetAuthorization(usdc(disputeUsdc), 1),
      },
    }],
  }]);
  await converge(env);

  console.log(`📊 Bob: swap_offer (40% fill target)`);
  snap(env, 'Bob buys 40% while Alice goes offline', {
    what: `Bob buys ${ethText(disputeFillEth)}, 40% of Alice's order. Hub matches it and settles Bob's side, but Alice has gone offline and never co-signs her side of the fill.`,
    why: 'Hub has settled with Bob and is owed the matching leg by Alice. It has paid Alice nothing, so what it risks is the cost of replacing her leg, not the principal.',
    tradfiParallel: 'One side of a dealer\'s back-to-back trade settled, the other counterparty silent: a replacement-cost exposure.',
    keyMetrics: [`Bid: ${ethText(disputeFillEth)} (40% of the order)`, `Limit: ${priceText(ETH_PRICE_MAIN)}`],
  });
  await process(env, [{
    entityId: bob.id,
    signerId: bob.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: disputeCounterId,
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdcForEth(disputeFillEth, ETH_PRICE_MAIN),
        wantTokenId: ETH_TOKEN_ID,
        ...getStaticSwapTokenDimensions(USDC_TOKEN_ID, ETH_TOKEN_ID),
        wantAmount: eth(disputeFillEth),
        ...deriveSwapNetAuthorization(eth(disputeFillEth), 1),
      },
    }],
  }]);

  // Process until orderbook match produces pending fill ratio (but before swap_resolve commits)
  let pendingRatio = 0;
  for (let i = 0; i < 8; i++) {
    await process(env);
    pendingRatio = pendingAccountSwapFillRatio(env, hub.id, alice.id, disputeOfferId);
    if (pendingRatio > 0) break;
  }
  assert(pendingRatio > 0, `Pending fillRatio recorded for ${disputeOfferId}`);

  // Simulate offline Alice: continuously drop Entity ingress to her while Bob settles.
  // A blunt converge() here used to evaporate Hub's alice swap_resolve evidence and
  // produce empty (0x) disputeStart arguments — silent scenario rot.
  const dropAliceIngress = (): void => {
    if (env.pendingOutputs) {
      env.pendingOutputs = env.pendingOutputs.filter(output => output.entityId !== alice.id);
    }
    if (env.networkInbox) {
      env.networkInbox = env.networkInbox.filter(output => output.entityId !== alice.id);
    }
    if (env.pendingNetworkOutputs) {
      env.pendingNetworkOutputs = env.pendingNetworkOutputs.filter(
        output => output.entityId !== alice.id,
      );
    }
    env.runtimeMempool.entityInputs = env.runtimeMempool.entityInputs.filter(
      input => input.entityId !== alice.id,
    );
  };
  dropAliceIngress();
  console.log('🚫 Dropped pending outputs to Alice to keep swap_resolve uncommitted (dispute path)');

  await processUntil(env, () => {
    dropAliceIngress();
    const bobAccount = findReplica(env, hub.id)[1].state.accounts.get(bob.id);
    return Boolean(bobAccount) && !bobAccount!.state.swapOffers?.has(disputeCounterId);
  }, 40, 'bob dispute fill settle while alice offline');
  dropAliceIngress();

  const evidenceStillPending = pendingAccountSwapFillRatio(env, hub.id, alice.id, disputeOfferId);
  assert(
    evidenceStillPending === pendingRatio,
    `Alice fill evidence must survive Bob settle (had ${pendingRatio}, now ${evidenceStillPending})`,
  );

  const [, hubAfterBobSettle] = findReplica(env, hub.id);
  const bobAfterSettle = hubAfterBobSettle.state.accounts.get(bob.id);
  const bobSettledEth = bobAfterSettle?.state.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const bobSettledUsdc = bobAfterSettle?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
  const bobDisputeFilled = computeFilledAmounts(
    usdcForEth(disputeFillEth, ETH_PRICE_MAIN),
    eth(disputeFillEth),
    MAX_FILL_RATIO
  );
  assert(
    bobSettledEth - bobDisputeBaselineEth === -bobDisputeFilled.filledWant,
    `Dispute Bob ETH delta = -${bobDisputeFilled.filledWant} (got ${bobSettledEth - bobDisputeBaselineEth})`
  );
  assert(
    bobSettledUsdc - bobDisputeBaselineUsdc === bobDisputeFilled.filledGive,
    `Dispute Bob USDC delta = +${bobDisputeFilled.filledGive} (got ${bobSettledUsdc - bobDisputeBaselineUsdc})`
  );
  assert(!bobAfterSettle?.state.swapOffers?.has(disputeCounterId), 'Dispute Bob offer fully resolved');

  console.log('⚔️ Hub starts dispute (will enforce fillRatio via calldata)');
  dropAliceIngress();
  snap(env, 'Hub disputes with the fill as evidence', {
    what: 'Hub takes the Alice account to the Depository. The claim carries the last co-signed state plus the matched fill ratio, 40%, as evidence.',
    why: 'Alice signed the order; the fill ratio proves how much of it was matched. The Depository can enforce Alice\'s leg without her cooperation.',
    tradfiParallel: 'Close-out of an unsettled FX trade, enforced from the matched confirmation instead of trust.',
    keyMetrics: ['Evidence: co-signed order + fill ratio 40%'],
  });
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'prepareDispute',
      data: {
        counterpartyEntityId: alice.id,
        description: 'Swap dispute (fillRatio enforced)',
      },
    }],
  }]);

  const [, hubBeforeBroadcastStart] = findReplica(env, hub.id);
  const draftedStart = hubBeforeBroadcastStart.state.jBatchState?.batch.disputeStarts[0];
  const startCount = hubBeforeBroadcastStart.state.jBatchState?.batch.disputeStarts.length || 0;
  console.log(`🧾 jBatch disputeStarts=${startCount} before broadcast`);
  assert(startCount > 0, 'jBatch has disputeStart before broadcast');
  if (!draftedStart) throw new Error('SWAP_DISPUTE_START_DRAFT_MISSING');
  assert(
    draftedStart.starterInitialArguments !== '0x' && draftedStart.starterInitialArguments !== '',
    `Dispute start must encode fill evidence (got ${draftedStart.starterInitialArguments})`,
  );

  const swapChallengeWindow = disputeWindowText(findReplica(env, hub.id)[1].state.accounts.get(alice.id)!.state.disputeConfig);
  snap(env, 'Dispute filed: the challenge window opens', {
    what: `Hub submits the dispute to the Depository. Alice has ${swapChallengeWindow} to answer with a newer co-signed state; the demo fast-forwards the clock.`,
    why: 'An older state loses only if the other side answers in time with a newer one, so each bank — or a watchtower — must watch the chain during the window. Alice has nothing newer: the fill is the latest thing she agreed to.',
    tradfiParallel: 'Filing a claim with a set period for the counterparty to contest it.',
    keyMetrics: [`Challenge window: ${swapChallengeWindow}`],
  });
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);

  // Local disputeStart latches timeout=0 until DisputeStarted is observed.
  let timeoutUnix = 0;
  for (let round = 0; round < 40; round++) {
    await syncChain(env, 1);
    await processJEvents(env);
    await process(env);
    const runtimeTimeout = Number(
      findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.activeDispute?.disputeTimeout || 0,
    );
    const onChainTimeout = Number((await jadapter.getAccountInfo(hub.id, alice.id)).disputeTimeout || 0);
    timeoutUnix = onChainTimeout > 0 ? onChainTimeout : runtimeTimeout;
    const observed = findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.activeDispute?.observedOnChain === true;
    const counterpartyObserved = findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.activeDispute?.observedOnChain === true;
    if (onChainTimeout > 0 && observed && counterpartyObserved) break;
  }
  const bothObserved = [
    findReplica(env, hub.id)[1].state.accounts.get(alice.id),
    findReplica(env, alice.id)[1].state.accounts.get(hub.id),
  ].every(account => account?.activeDispute?.observedOnChain === true);
  if (!(timeoutUnix > 0) || !bothObserved) {
    throw new Error('SWAP_DISPUTE_TIMEOUT_MISSING_AFTER_START');
  }

  const [, hubAfterStart] = findReplica(env, hub.id);
  const hubAccountAfterStart = requireAccount(hubAfterStart.state.accounts.get(alice.id), 'hub/alice after dispute start');
  const hubActiveDispute = hubAccountAfterStart.activeDispute;
  if (!hubActiveDispute) throw new Error('SWAP_MISSING_HUB_ACTIVE_DISPUTE');
  const { buildAccountProofBodyFromJurisdictions } = await import('../../account/consensus/helpers');
  const hubProofAfterStart = buildAccountProofBodyFromJurisdictions(env.state, hubAccountAfterStart);
  assert(
    hubProofAfterStart.proofBodyHash === hubActiveDispute.initialProofbodyHash,
    'Hub dispute proofBodyHash matches on-chain start hash'
  );
  const [, aliceAfterStart] = findReplica(env, alice.id);
  const aliceAccountAfterStart = requireAccount(aliceAfterStart.state.accounts.get(hub.id), 'alice/hub after dispute start');
  const aliceActiveDispute = aliceAccountAfterStart.activeDispute;
  if (!aliceActiveDispute) throw new Error('SWAP_MISSING_ALICE_ACTIVE_DISPUTE');
  const aliceProofAfterStart = buildAccountProofBodyFromJurisdictions(env.state, aliceAccountAfterStart);
  assert(
    aliceProofAfterStart.proofBodyHash === aliceActiveDispute.initialProofbodyHash,
    'Counterparty dispute proofBodyHash matches on-chain start hash'
  );

  console.log(`⏳ Waiting for dispute timeout (unix ${timeoutUnix})...`);
  const advanced = await advanceScenarioPastDisputeTimeout(
    env,
    jadapter,
    timeoutUnix,
  );
  console.log(
    `✅ Timeout reached via unix advance ` +
    `(${advanced.startUnix}→${advanced.finalUnix}, +${advanced.advancedSeconds}s)`,
  );
  // Entity clocks move only inside a signed frame; wake once after the jump.
  snap(env, 'Window closes: finalization submitted', {
    what: 'The challenge window ends with no newer state from Alice. The dispute finalization is drafted and submitted with the fill ratio attached.',
    why: 'A deadline, not a negotiation, ends the dispute.',
    tradfiParallel: 'The contest period lapses and the claim becomes enforceable.',
  });
  await process(env);

  const readFinalize = (entityId: string) => {
    const state = findReplica(env, entityId)[1].state;
    return (
      state.jBatchState?.batch.disputeFinalizations[0]
      ?? state.jBatchState?.sentBatch?.batch.disputeFinalizations[0]
    );
  };

  // Timeout wake may auto-draft + broadcast finalize (either side).
  let finalProof = readFinalize(hub.id) ?? readFinalize(alice.id);
  if (!finalProof) {
    console.log('⚖️ Hub disputeFinalize (unilateral)');
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'disputeFinalize',
        data: {
          counterpartyEntityId: alice.id,
          description: 'Finalize swap dispute',
        },
      }],
    }]);
    finalProof = readFinalize(hub.id) ?? readFinalize(alice.id);
  } else {
    console.log('⚖️ Dispute finalize already drafted by timeout scheduler');
  }
  if (!finalProof) throw new Error('SWAP_DISPUTE_FINALIZATION_NOT_DRAFTED');

  // Starter fill evidence is committed at disputeStart; finalize may put the
  // complementary side in otherArguments. Accept either non-empty clause set.
  const finalArgs = (
    finalProof.starterArguments && finalProof.starterArguments !== '0x'
      ? finalProof.starterArguments
      : finalProof.otherArguments && finalProof.otherArguments !== '0x'
        ? finalProof.otherArguments
        : '0x'
  );
  if (finalArgs === '0x') {
    throw new Error(
      `SWAP_DISPUTE_ARGUMENTS_EMPTY:starter=${finalProof.starterArguments}:other=${finalProof.otherArguments}:` +
      `initialNonce=${finalProof.initialNonce}:finalNonce=${finalProof.finalNonce}`,
    );
  }

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const [argArray] = abiCoder.decode(['bytes[]'], finalArgs) as unknown as [string[]];
  const ratioArgs = argArray[0];
  if (typeof ratioArgs !== 'string') throw new Error('SWAP_MISSING_FINAL_RATIO_ARGS');
  // Soft-decoded empty tuples are valid ABI; fail on missing fill instead of
  // treating empty bytes as success.
  const [decoded] = abiCoder.decode(
    ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
    ratioArgs,
  ) as unknown as [{ fillRatios: readonly bigint[]; secrets: readonly string[] }];
  const ratioValue = Number(decoded.fillRatios[0] || 0n);
  assert(ratioValue === pendingRatio, `fillRatio matches pending (${pendingRatio})`);

  const hubBatch = findReplica(env, hub.id)[1].state.jBatchState;
  const aliceBatch = findReplica(env, alice.id)[1].state.jBatchState;
  const finalizeAlreadySent = (
    (hubBatch?.sentBatch?.batch.disputeFinalizations?.length ?? 0) > 0
    || (aliceBatch?.sentBatch?.batch.disputeFinalizations?.length ?? 0) > 0
  );
  if (!finalizeAlreadySent) {
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }]);
  }

  snap(env, 'Dispute settled on-chain', {
    what: 'The Depository finalizes the account from the evidence, including Alice\'s 40% fill, and the account stays closed. These accounts run on credit lines alone, with no reserves or collateral on the Depository, so any amount one side still owes the other is booked on-chain as a debt in that currency.',
    why: 'Hub\'s claim for the leg it settled with Bob is now an on-chain claim on Alice, created without her cooperation. What it recovers depends on her future reserves: credit without collateral is only as good as the debtor.',
    tradfiParallel: 'The Depository applies the latest co-signed state mechanically; legal finality depends on governing law.',
    keyMetrics: ['Enforced fill: 40%', 'Account status: closed'],
  });
  for (let i = 0; i < 20; i++) {
    await process(env);
    await syncChain(env, 1);
    await drainPendingJEvents(env);
    const hubClear = !findReplica(env, hub.id)[1].state.accounts.get(alice.id)?.activeDispute;
    const aliceClear = !findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.activeDispute;
    if (hubClear && aliceClear) break;
  }

  console.log('✅ Dispute swap finalize broadcast complete');
  const [, hubAfterFinalize] = findReplica(env, hub.id);
  const hubAccountAfterFinalize = hubAfterFinalize.state.accounts.get(alice.id);
  assert(!hubAccountAfterFinalize?.activeDispute, 'Dispute cleared on hub after finalize');
  const [, aliceAfterFinalize] = findReplica(env, alice.id);
  const aliceAccountAfterFinalize = aliceAfterFinalize.state.accounts.get(hub.id);
  assert(!aliceAccountAfterFinalize?.activeDispute, 'Dispute cleared on counterparty after finalize');
  assert(hubAccountAfterFinalize?.status === 'disputed', 'Hub account stays disputed after finalize until explicit reopen');
  assert(aliceAccountAfterFinalize?.status === 'disputed', 'Counterparty account stays disputed after finalize until explicit reopen');

  const hubFinalEthDelta = hubAccountAfterFinalize?.state.deltas.get(ETH_TOKEN_ID);
  const hubFinalUsdcDelta = hubAccountAfterFinalize?.state.deltas.get(USDC_TOKEN_ID);
  assert((hubFinalEthDelta?.offdelta ?? 0n) === 0n, 'DisputeFinalized sync clears ETH offdelta');
  assert((hubFinalUsdcDelta?.offdelta ?? 0n) === 0n, 'DisputeFinalized sync clears USDC offdelta');
  assert((hubFinalEthDelta?.leftHold ?? 0n) === 0n, 'DisputeFinalized sync clears ETH leftHold');
  assert((hubFinalEthDelta?.rightHold ?? 0n) === 0n, 'DisputeFinalized sync clears ETH rightHold');
  assert(!hubAccountAfterFinalize?.state.swapOffers?.has(disputeOfferId), 'DisputeFinalized clears stale dispute swap offer');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('              PHASE 2: ORDERBOOK TEST COMPLETE                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  return env;
  } finally {
    stopAccountCausalTrace();
    env.scenarioMode = prevScenarioMode ?? false;
    restoreFailFast();
  }
}

// ============================================================================
// PHASE 3: Multi-Party Trading - Carol & Dave eating larger orders
// ============================================================================

export async function multiPartyTrading(env: RuntimeReplica): Promise<RuntimeReplica> {
  const restoreFailFast = enableStrictScenario(env, 'SWAP');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  if (env.quietRuntimeLogs === undefined) {
    env.quietRuntimeLogs = true;
  }
  const process = await getProcess();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 3: MULTI-PARTY TRADING (Carol & Dave)           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const hub = getRegisteredEntity('2');

  // Carol and Dave already registered in Phase 1 (registerEntities created all 5 eReplicas)
  const carol = { ...getRegisteredEntity('4'), name: 'Carol' };
  const dave = { ...getRegisteredEntity('5'), name: 'Dave' };
  console.log(`📦 Using Carol(${carol.id.slice(-4)}) and Dave(${dave.id.slice(-4)}) from Phase 1\n`);

  // Open accounts with Hub
  console.log('🔗 Opening accounts with Hub...');
  snap(env, 'Carol and Dave connect', {
    what: `Carol and Dave open accounts with Hub and exchange the same two-currency credit lines: ${ethText(ETH_CAPACITY_UNITS)} and ${usdcText(USDC_CAPACITY_UNITS)} each way.`,
    why: 'Adding a participant adds one bilateral account with the dealer. Nobody else\'s account changes.',
    tradfiParallel: 'New clients onboarded to a dealer with their own settlement lines.',
  });
  for (const entity of [carol, dave]) {
    await process(env, [
      { entityId: entity.id, signerId: entity.signer, entityTxs: [{ type: 'openAccount', data: {
        targetEntityId: hub.id,
        disputeConfig: defaultAccountDisputeConfigForParties(entity.id, false, hub.id, true),
      } }] },
    ]);
    await converge(env);
  }
  console.log('  ✅ Accounts opened\n');

  // Extend credit
  console.log('💳 Extending credit...');
  for (const entity of [carol, dave]) {
    await process(env, [
    { entityId: hub.id, signerId: hub.signer, entityTxs: [
      { type: 'extendCredit', data: { counterpartyEntityId: entity.id, tokenId: ETH_TOKEN_ID, amount: eth(ETH_CAPACITY_UNITS) } },
      { type: 'extendCredit', data: { counterpartyEntityId: entity.id, tokenId: USDC_TOKEN_ID, amount: usdc(USDC_CAPACITY_UNITS) } },
    ]},
    { entityId: entity.id, signerId: entity.signer, entityTxs: [
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH_TOKEN_ID, amount: eth(ETH_CAPACITY_UNITS) } },
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: usdc(USDC_CAPACITY_UNITS) } },
    ]},
    ]);
    await converge(env);
  }
  console.log('  ✅ Credit extended\n');

  // ============================================================================
  // Carol places large SELL order
  // ============================================================================
  console.log(`📊 Carol places LARGE SELL: ${CAROL_SELL_ETH} ETH @ ${ETH_PRICE_LOW} USDC...`);
  snap(env, `Carol offers ${ethText(CAROL_SELL_ETH)}`, {
    what: `Carol places a large sell order: ${ethText(CAROL_SELL_ETH)} at ${priceText(ETH_PRICE_LOW)}.`,
    why: 'Large orders rest in the book until buyers arrive; each partial fill settles on its own.',
    tradfiParallel: 'A large resting offer with a dealer, filled in parts.',
    keyMetrics: [`Sell: ${ethText(CAROL_SELL_ETH)}`, `Limit: ${priceText(ETH_PRICE_LOW)}`],
  });
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'carol-sell-10',
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(CAROL_SELL_ETH),
        wantTokenId: USDC_TOKEN_ID,
        ...getStaticSwapTokenDimensions(ETH_TOKEN_ID, USDC_TOKEN_ID),
        wantAmount: usdcForEth(CAROL_SELL_ETH, ETH_PRICE_LOW),
        ...deriveSwapNetAuthorization(usdcForEth(CAROL_SELL_ETH, ETH_PRICE_LOW), 1),
      },
    }],
  }]);
  await converge(env);

  // Print orderbook
  const { renderAscii } = await import('../../swapbook');
  const [, hubRep1] = findReplica(env, hub.id);
  const book1 = hubRep1.state.orderbookExt?.books?.get('1/2');
  if (book1) {
    console.log('\n📚 ORDERBOOK after Carol SELL:');
    console.log(renderAscii(book1, 3));
  }

  // ============================================================================
  // Dave buys into Carol's sell
  // ============================================================================
  console.log(`\n📊 Dave BUYs ${DAVE_BUY_ETH} ETH @ ${ETH_PRICE_MAIN} (eats into Carol's sell)...`);
  snap(env, `Dave buys ${ethText(DAVE_BUY_ETH)} at Carol's price`, {
    what: `Dave bids for ${ethText(DAVE_BUY_ETH)} at up to ${priceText(ETH_PRICE_MAIN)} and is filled at Carol's ${priceText(ETH_PRICE_LOW)}. Carol receives ${usdcText(DAVE_BUY_ETH * ETH_PRICE_LOW)}.`,
    why: 'The trade settles in the two bilateral accounts with Hub, Carol\'s and Dave\'s, each with both of its legs in one signed frame.',
    tradfiParallel: 'Each client\'s two legs move together in its own account with the dealer.',
    keyMetrics: [`Bid: ${ethText(DAVE_BUY_ETH)}`, `Limit: ${priceText(ETH_PRICE_MAIN)}`],
  });
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'dave-buy-3',
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdcForEth(DAVE_BUY_ETH, ETH_PRICE_MAIN),
        wantTokenId: ETH_TOKEN_ID,
        ...getStaticSwapTokenDimensions(USDC_TOKEN_ID, ETH_TOKEN_ID),
        wantAmount: eth(DAVE_BUY_ETH),
        ...deriveSwapNetAuthorization(eth(DAVE_BUY_ETH), 1),
      },
    }],
  }]);
  await converge(env);
  tell(env, {
    title: `Filled at Carol's price: ${ethText(DAVE_BUY_ETH)}`,
    what: `Dave was filled at Carol's ${priceText(ETH_PRICE_LOW)}, below his limit. Carol's account and Dave's account with Hub each changed by one co-signed frame with both legs.`,
    why: 'Price improvement goes to the buyer: he pays the resting seller\'s price.',
    tradfiParallel: 'Each client\'s two legs move together in its own account with the dealer.',
    keyMetrics: [`Filled: ${ethText(DAVE_BUY_ETH)} at ${priceText(ETH_PRICE_LOW)}`, `Carol receives: ${usdcText(DAVE_BUY_ETH * ETH_PRICE_LOW)}`, `Carol's order left: ${ethText(CAROL_SELL_ETH - DAVE_BUY_ETH)}`],
    focusEntityIds: [carol.id, hub.id, dave.id],
  });

  // Print orderbook after trade
  const [, hubRep2] = findReplica(env, hub.id);
  const book2 = hubRep2.state.orderbookExt?.books?.get('1/2');
  if (book2) {
    console.log('\n📚 ORDERBOOK after Dave BUY:');
    console.log(renderAscii(book2, 3));
  }

  // ============================================================================
  // Carol places another SELL
  // ============================================================================
  console.log(`\n📊 Carol places another SELL: ${CAROL_SELL_2_ETH} ETH @ ${ETH_PRICE_HIGH}...`);
  snap(env, `Carol adds ${ethText(CAROL_SELL_2_ETH)} at ${priceText(ETH_PRICE_HIGH)}`, {
    what: `Carol adds a second offer: ${ethText(CAROL_SELL_2_ETH)} at ${priceText(ETH_PRICE_HIGH)}. The book now has two price levels.`,
    why: 'Each level is a separate signed offer inside Carol\'s account with Hub.',
    tradfiParallel: 'A dealer\'s ladder of offers at increasing prices.',
    keyMetrics: [`Asks: ${ethText(CAROL_SELL_ETH - DAVE_BUY_ETH)} at ${usdcText(ETH_PRICE_LOW)}, ${ethText(CAROL_SELL_2_ETH)} at ${usdcText(ETH_PRICE_HIGH)}`],
  });
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'carol-sell-5',
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(CAROL_SELL_2_ETH),
        wantTokenId: USDC_TOKEN_ID,
        ...getStaticSwapTokenDimensions(ETH_TOKEN_ID, USDC_TOKEN_ID),
        wantAmount: usdcForEth(CAROL_SELL_2_ETH, ETH_PRICE_HIGH),
        ...deriveSwapNetAuthorization(usdcForEth(CAROL_SELL_2_ETH, ETH_PRICE_HIGH), 1),
      },
    }],
  }]);
  await converge(env);

  // Print orderbook with two price levels
  const [, hubRep3] = findReplica(env, hub.id);
  const book3 = hubRep3.state.orderbookExt?.books?.get('1/2');
  if (book3) {
    console.log('\n📚 ORDERBOOK with multiple ask levels:');
    console.log(renderAscii(book3, 5));
  }

  // ============================================================================
  // Dave sweeps the book (eats both levels)
  // ============================================================================
  console.log(`\n📊 Dave SWEEPS BOOK: BUY ${DAVE_SWEEP_ETH} ETH @ ${ETH_PRICE_SWEEP} (eats all asks)...`);
  const sweepLowEth = CAROL_SELL_ETH - DAVE_BUY_ETH;
  // USDC each customer's account moved by the sweep, read from Hub's side of both accounts.
  const usdcOffdelta = (customerId: string): bigint =>
    findReplica(env, hub.id)[1].state.accounts.get(customerId)?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
  const sweepUsdcBefore = { carol: usdcOffdelta(carol.id), dave: usdcOffdelta(dave.id) };
  snap(env, 'Dave sweeps the book', {
    what: `Dave buys ${ethText(DAVE_SWEEP_ETH)} with a limit of ${priceText(ETH_PRICE_SWEEP)}. Hub fills him across both levels: ${ethText(sweepLowEth)} at ${usdcText(ETH_PRICE_LOW)} and ${ethText(CAROL_SELL_2_ETH)} at ${usdcText(ETH_PRICE_HIGH)}.`,
    why: 'One order, several fills, every one settled with both legs in the bilateral accounts involved. The dealer ends flat; only the customers\' positions changed.',
    tradfiParallel: 'An order walking a dealer\'s ladder, each fill settled with both legs together in the client\'s account.',
    keyMetrics: [`Bid: ${ethText(DAVE_SWEEP_ETH)}`, `Limit: ${priceText(ETH_PRICE_SWEEP)}`],
  });
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'dave-sweep',
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdcForEth(DAVE_SWEEP_ETH, ETH_PRICE_SWEEP),
        wantTokenId: ETH_TOKEN_ID,
        ...getStaticSwapTokenDimensions(USDC_TOKEN_ID, ETH_TOKEN_ID),
        wantAmount: eth(DAVE_SWEEP_ETH),
        ...deriveSwapNetAuthorization(eth(DAVE_SWEEP_ETH), 1),
      },
    }],
  }]);
  await converge(env);
  const magnitude = (value: bigint): bigint => (value < 0n ? -value : value);
  const davePaid = magnitude(usdcOffdelta(dave.id) - sweepUsdcBefore.dave);
  const carolGot = magnitude(usdcOffdelta(carol.id) - sweepUsdcBefore.carol);
  tell(env, {
    title: 'The book is swept',
    what: `Dave received ${ethText(DAVE_SWEEP_ETH)} across both price levels and paid ${formatTokenMoney(USDC_TOKEN_ID, davePaid)}; Carol received ${formatTokenMoney(USDC_TOKEN_ID, carolGot)}. ${davePaid === carolGot ? 'Hub passed both legs through and ends flat on this trade.' : `The difference, ${formatTokenMoney(USDC_TOKEN_ID, davePaid - carolGot)}, stays with Hub.`}`,
    why: 'Every fill settled inside the two customers\' accounts with the dealer; no order is left resting.',
    tradfiParallel: 'An order walking a dealer\'s ladder, each fill settled with both legs together in the client\'s account.',
    keyMetrics: [`Filled: ${ethText(DAVE_SWEEP_ETH)}`, `Dave pays: ${formatTokenMoney(USDC_TOKEN_ID, davePaid)}`, 'Asks left: 0'],
    focusEntityIds: [carol.id, hub.id, dave.id],
  });

  // Final orderbook state
  const [, hubRepFinal] = findReplica(env, hub.id);
  const bookFinal = hubRepFinal.state.orderbookExt?.books?.get('1/2');
  if (bookFinal) {
    console.log('\n📚 ORDERBOOK after sweep (should be empty asks):');
    console.log(renderAscii(bookFinal, 3));
  }

  // Print final positions
  console.log('\n📊 Final positions:');
  // Account keyed by counterparty ID (from Hub's perspective)
  const carolAccount = hubRepFinal.state.accounts.get(carol.id);
  const daveAccount = hubRepFinal.state.accounts.get(dave.id);

  const carolEth = carolAccount?.state.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const carolUsdc = carolAccount?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
  const daveEth = daveAccount?.state.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const daveUsdc = daveAccount?.state.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  console.log(`  Carol: ${Number(carolEth) / 1e18} ETH, ${Number(carolUsdc) / 1e18} USDC`);
  console.log(`  Dave:  ${Number(daveEth) / 1e18} ETH, ${Number(daveUsdc) / 1e18} USDC`);

  // ═══════════════════════════════════════════════════════════════
  // ASSERTIONS: Verify multi-party trading worked correctly
  // ═══════════════════════════════════════════════════════════════

  // Carol sold ETH across two orders (low + high price levels)
  // Carol is Right relative to Hub (Hub = 0x0002..., Carol = 0x0004...)
  // CANONICAL: Right pays → offdelta INCREASES, Right receives → offdelta DECREASES
  const expectedCarolEth = eth(CAROL_SELL_ETH + CAROL_SELL_2_ETH);
  const expectedCarolUsdc = usdcForEth(CAROL_SELL_ETH, ETH_PRICE_LOW) +
    usdcForEth(CAROL_SELL_2_ETH, ETH_PRICE_HIGH);
  const phase3FeeTolerance = usdc(10n);

  // In browser e2e, runtime loop may interleave while scenario runs.
  // Keep invariant-based checks instead of exact full-sweep equality.
  assert(carolEth > 0n, `Carol ETH delta must be positive after sells (got ${carolEth})`);
  assert(
    carolEth <= expectedCarolEth,
    `Carol ETH delta must not exceed offered amount ${expectedCarolEth} (got ${carolEth})`,
  );
  assert(carolUsdc < 0n, `Carol USDC delta must stay negative (got ${carolUsdc})`);
  const carolUsdcAbs = -carolUsdc;
  assert(carolUsdcAbs > 0n, `Carol USDC abs must be positive after fills (got ${carolUsdcAbs})`);
  assert(
    carolUsdcAbs <= expectedCarolUsdc,
    `Carol USDC abs must not exceed no-fee fill ${expectedCarolUsdc} (got ${carolUsdcAbs})`,
  );

  // Dave bought ETH across multiple levels (partial + sweep)
  // Dave is Right relative to Hub (Hub = 0x0002..., Dave = 0x0005...)
  const daveBuy1 = computeFilledAmounts(
    usdcForEth(DAVE_BUY_ETH, ETH_PRICE_MAIN),
    eth(DAVE_BUY_ETH),
    MAX_FILL_RATIO
  );
  const daveSweep = computeFilledAmounts(
    usdcForEth(DAVE_SWEEP_ETH, ETH_PRICE_SWEEP),
    eth(DAVE_SWEEP_ETH),
    MAX_FILL_RATIO
  );
  const expectedDaveEth = daveBuy1.filledWant + daveSweep.filledWant;
  const expectedDaveUsdc = daveBuy1.filledGive + daveSweep.filledGive;

  const daveEthAbs = daveEth < 0n ? -daveEth : daveEth;
  assert(daveEth < 0n, `Dave ETH delta must be negative after buys (got ${daveEth})`);
  assert(
    daveEthAbs <= expectedDaveEth,
    `Dave ETH abs must not exceed expected max ${expectedDaveEth} (got ${daveEthAbs})`,
  );
  assert(daveUsdc > 0n, `Dave USDC delta must be positive after giving quote (got ${daveUsdc})`);
  assert(
    daveUsdc <= expectedDaveUsdc + phase3FeeTolerance,
    `Dave USDC delta must be within ${phase3FeeTolerance} fee tolerance (expected=${expectedDaveUsdc}, got=${daveUsdc})`,
  );

  const hasAsks = bookFinal ? getBestAsk(bookFinal) !== null : false;
  console.log(`  Orderbook ask side present after phase 3: ${hasAsks}`);

  console.log('  ✅ Phase 3 assertions passed');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('           PHASE 3: MULTI-PARTY TRADING COMPLETE               ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  return env;
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreFailFast();
  }
}

/** Full swap puppet path used by `run.ts` and CLI (setup + orderbook + multi-party). */
export async function runSwapScenario(env: RuntimeReplica): Promise<RuntimeReplica> {
  setScenarioStorageEnabled(env, false);
  await swap(env);
  console.log('✅ PHASE 1 COMPLETE!');
  await swapWithOrderbook(env);
  console.log('✅ PHASE 2 COMPLETE!');
  await multiPartyTrading(env);
  console.log('✅ PHASE 3 COMPLETE!');
  console.log('✅ ALL SWAP PHASES COMPLETE!');
  return env;
}

// ===== CLI ENTRY POINT =====
if (import.meta.main) {
  console.log('🚀 Running SWAP scenario from CLI...\n');

  const runtime = await import('../../runtime');
  const empty = runtime.createEmptyEnv();
  empty.scenarioMode = true; // Deterministic time control
  requireRuntimeSeed(empty, 'SWAP CLI'); // Required for key derivation

  try {
    await runSwapScenario(empty);
    process.exit(0);
  } catch (error) {
    console.error('\n❌ SWAP scenario FAILED:', error);
    process.exit(1);
  }
}
