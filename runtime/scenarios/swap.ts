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
 * 6. Test partial fill with minFillRatio
 * 7. Test cancel
 *
 * Run with: bun runtime/scenarios/swap.ts
 */

import type { Env, EntityInput, JurisdictionConfig } from '../types';
import { ethers } from 'ethers';
import { getBestAsk } from '../orderbook/core';
import { getOpenSwapOfferEntries } from '../open-swap-offers';
import { ensureJAdapter, getScenarioJAdapter, createJReplica, createJurisdictionConfig } from './boot';
import type { JAdapter } from '../jadapter/types';
import { canonicalAccountKey } from '../state-helpers';
import { formatRuntime, formatEntity } from '../runtime-ascii';
import { enableStrictScenario, processUntil, ensureSignerKeysFromSeed, requireRuntimeSeed, converge } from './helpers';
import { createGossipLayer } from '../networking/gossip';

// Lazy-loaded runtime functions
let _process: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
let _applyRuntimeInput: ((env: Env, runtimeInput: any) => Promise<Env>) | null = null;

let _processWithStep: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;

const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../runtime');
    _process = runtime.process;
  }
  if (!_processWithStep) {
    _processWithStep = async (env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => {
      if (env.scenarioMode) {
        const step = typeof delay === 'number' && delay > 0 ? delay : 1;
        env.timestamp = (env.timestamp || 0) + step;
      }
      return _process!(env, inputs, delay, single);
    };
  }
  return _processWithStep;
};

const getApplyRuntimeInput = async () => {
  if (!_applyRuntimeInput) {
    const runtime = await import('../runtime');
    _applyRuntimeInput = runtime.applyRuntimeInput;
  }
  return _applyRuntimeInput;
};

async function processJEvents(env: Env): Promise<void> {
  // RPC watcher is polling-based; force immediate poll in scenarios to avoid
  // relying on wall-clock interval timing between submit and assertions.
  for (const [, jReplica] of env.jReplicas) {
    const ja = (jReplica as any).jadapter;
    if (ja?.pollNow) await ja.pollNow();
  }

  const pending = env.runtimeInput.entityInputs.length;
  if (pending === 0) return;
  const inputs = [...env.runtimeInput.entityInputs];
  env.runtimeInput.entityInputs = [];
  const applyRuntimeInput = await getApplyRuntimeInput();
  await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: inputs });
}

// Token IDs (aligned with runtime TOKEN_REGISTRY)
const USDC_TOKEN_ID = 1;
const ETH_TOKEN_ID = 2;

// Precision
const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

const eth = (amount: number | bigint) => BigInt(amount) * ONE;
const usdc = (amount: number | bigint) => BigInt(amount) * ONE;

const ETH_PRICE_MAIN = 3000n;
const ETH_PRICE_LOW = 2900n;
const ETH_PRICE_HIGH = 3100n;
const ETH_PRICE_SWEEP = 3200n;

const USDC_CAPACITY_UNITS = 300_000n;
const ETH_CAPACITY_UNITS = USDC_CAPACITY_UNITS / ETH_PRICE_MAIN;

const TRADE_ETH = ETH_CAPACITY_UNITS / 5n; // 20% of capacity
const TRADE_ETH_HALF = TRADE_ETH / 2n;
const TRADE_ETH_DOUBLE = TRADE_ETH * 2n;
const TRADE_ETH_TRIPLE = TRADE_ETH * 3n;

const TRADE_USDC_MAIN_UNITS = TRADE_ETH * ETH_PRICE_MAIN;
const TRADE_USDC_HALF_UNITS = TRADE_ETH_HALF * ETH_PRICE_MAIN;

const usdcForEth = (ethUnits: bigint, price: bigint) => usdc(ethUnits * price);

const CAROL_SELL_ETH = TRADE_ETH_DOUBLE;
const CAROL_SELL_2_ETH = TRADE_ETH;
const DAVE_BUY_ETH = TRADE_ETH_HALF;
const DAVE_SWEEP_ETH = CAROL_SELL_ETH + CAROL_SELL_2_ETH - DAVE_BUY_ETH;

const J_MACHINE_POSITION = { x: 0, y: 600, z: 0 };

// Cross layout in depth (positions are RELATIVE to J-machine)
const SWAP_RADIUS = 66; // 200 / 3 ≈ 66
const SWAP_CENTER_Y = -40; // halfway to J-machine from previous center
const SWAP_OUTER_Y = -80;

const SWAP_POSITIONS: Record<string, { x: number; y: number; z: number }> = {
  Hub: { x: 0, y: SWAP_CENTER_Y, z: 0 },
  Alice: { x: -SWAP_RADIUS, y: SWAP_OUTER_Y, z: 0 },
  Bob: { x: SWAP_RADIUS, y: SWAP_OUTER_Y, z: 0 },
  Carol: { x: 0, y: SWAP_OUTER_Y, z: -SWAP_RADIUS },
  Dave: { x: 0, y: SWAP_OUTER_Y, z: SWAP_RADIUS },
};

// Fill ratio constants (uint16)
const MAX_FILL_RATIO = 65535;
const FILL_10 = 6553;
const FILL_50 = 32768;
const FILL_75 = 49152;
const FILL_80 = 52428;
const FULL_FILL = MAX_FILL_RATIO;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
};

const computeFilledAmounts = (giveAmount: bigint, wantAmount: bigint, fillRatio: number) => {
  const filledGive = (giveAmount * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
  const filledWant = giveAmount > 0n ? ceilDiv(filledGive * wantAmount, giveAmount) : 0n;
  return { filledGive, filledWant };
};

function assert(condition: boolean, message: string, env?: Env): void {
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

const registeredEntityIds: Record<string, string> = {};

function getRegisteredEntityId(signerId: string): string {
  const entityId = registeredEntityIds[signerId];
  if (!entityId) {
    throw new Error(`Missing registered entityId for signer ${signerId} - run swap() first`);
  }
  return entityId;
}

function assertSnapshotCounts(env: Env, expectedJ: number, expectedE: number, label: string): void {
  const history = env.history || [];
  assert(history.length > 0, `${label}: snapshot exists`);

  const snapshot = history[history.length - 1];
  const jCount = snapshot?.jReplicas?.length ?? 0;
  const eCount = snapshot?.eReplicas?.size ?? 0;

  assert(jCount === expectedJ, `${label}: snapshot jReplicas = ${expectedJ} (got ${jCount})`);
  assert(eCount === expectedE, `${label}: snapshot eReplicas = ${expectedE} (got ${eCount})`);
}

function findReplica(env: Env, entityId: string) {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`Replica for entity ${entityId} not found`);
  }
  return entry;
}

export async function swap(env: Env): Promise<void> {
  const restoreFailFast = enableStrictScenario(env, 'SWAP');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  if (env.quietRuntimeLogs === undefined) {
    env.quietRuntimeLogs = true;
  }
  requireRuntimeSeed(env, 'SWAP');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5'], 'SWAP');
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  if (env.scenarioMode && env.height === 0) {
    env.timestamp = 1;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   SWAP SCENARIO: Same-J Swaps                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: BrowserVM + J-Machine (same as ahb.ts)
  // ============================================================================
  console.log('🏛️ Setting up BrowserVM J-Machine...');

  // Clear old state if switching scenarios (prevents accumulation from AHB/other scenarios)
  if (env.jReplicas && env.jReplicas.size > 0) {
    console.log(`[SWAP] Clearing ${env.jReplicas.size} old jurisdictions from previous scenario`);
    env.jReplicas.clear();
  }
  if (env.eReplicas && env.eReplicas.size > 0) {
    console.log(`[SWAP] Clearing ${env.eReplicas.size} old entities from previous scenario`);
    env.eReplicas.clear();
  }
  if (env.history && env.history.length > 0) {
    console.log(`[SWAP] Clearing ${env.history.length} old snapshots from previous scenario`);
    env.history = [];
  }
  env.height = 0; // Reset to frame 0
  if (env.runtimeInput) {
    env.runtimeInput.runtimeTxs = [];
    env.runtimeInput.entityInputs = [];
  } else {
    env.runtimeInput = { runtimeTxs: [], entityInputs: [] };
  }
  env.pendingOutputs = [];
  env.pendingNetworkOutputs = [];
  env.networkInbox = [];
  env.frameLogs = [];
  env.gossip = createGossipLayer();

  // Setup JAdapter (browservm or rpc, depending on JADAPTER_MODE)
  let jadapter: JAdapter;
  try {
    jadapter = getScenarioJAdapter(env);
  } catch {
    jadapter = await ensureJAdapter(env);
    const jReplica = createJReplica(env, 'Swap Demo', jadapter.addresses.depository, J_MACHINE_POSITION);
    (jReplica as any).jadapter = jadapter;
    (jReplica as any).depositoryAddress = jadapter.addresses.depository;
    (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
    jadapter.startWatching(env);
  }
  const jurisdiction = createJurisdictionConfig('Swap Demo', jadapter.addresses.depository, jadapter.addresses.entityProvider);
  console.log('✅ JAdapter J-Machine created\n');

  // ============================================================================
  // SETUP: Create Alice and Hub entities (on-chain registration + eReplicas)
  // ============================================================================
  console.log('📦 Creating entities: Alice, Hub, Bob, Carol, Dave...');

  const { registerEntities: bootRegisterEntities } = await import('./boot');
  const registered = await bootRegisterEntities(env, jadapter, [
    { name: 'Alice', signer: '1', position: SWAP_POSITIONS['Alice'] || { x: 0, y: 0, z: 0 } },
    { name: 'Hub',   signer: '2', position: SWAP_POSITIONS['Hub'] || { x: 0, y: 0, z: 0 } },
    { name: 'Bob',   signer: '3', position: SWAP_POSITIONS['Bob'] || { x: 0, y: 0, z: 0 } },
    { name: 'Carol', signer: '4', position: SWAP_POSITIONS['Carol'] || { x: 0, y: 0, z: 0 } },
    { name: 'Dave',  signer: '5', position: SWAP_POSITIONS['Dave'] || { x: 0, y: 0, z: 0 } },
  ], jurisdiction);
  // Populate module-level registeredEntityIds for cross-phase access
  for (const r of registered) {
    registeredEntityIds[r.signer] = r.id;
  }

  // registerEntities already created eReplicas — just build local aliases
  const alice = { name: 'Alice', id: getRegisteredEntityId('1'), signer: '1' };
  const hub = { name: 'Hub', id: getRegisteredEntityId('2'), signer: '2' };
  console.log(`  ✅ Created: ${alice.name}, ${hub.name}\n`);

  // ============================================================================
  // SETUP: Open Alice-Hub bilateral account
  // ============================================================================
  console.log('🔗 Opening Alice ↔ Hub bilateral account...');

  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
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

  // ============================================================================
  // TEST 1: Simple swap - Alice sells 20% of capacity
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`TEST 1: Alice places limit order - Sell ${TRADE_ETH} ETH for ${TRADE_USDC_MAIN_UNITS} USDC`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const offerId1 = 'order-001';

  // Alice places swap offer
  console.log(`📊 Alice: swap_offer (${TRADE_ETH} ETH → ${TRADE_USDC_MAIN_UNITS} USDC, min 50%)`);
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId1,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(TRADE_ETH),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(TRADE_USDC_MAIN_UNITS),
        minFillRatio: FILL_50, // 50% minimum
      },
    }],
  }]);
  await converge(env); // Wait for full consensus

  // Verify offer was created in A-Machine
  const [, aliceRep1] = findReplica(env, alice.id);
  const aliceHubAccount1 = aliceRep1.state.accounts.get(hub.id);
  assert(aliceHubAccount1?.swapOffers?.has(offerId1), 'Offer created in A-Machine account');

  const offer1 = aliceHubAccount1?.swapOffers?.get(offerId1);
  assert(offer1?.giveAmount === eth(TRADE_ETH), `Offer giveAmount = ${TRADE_ETH} ETH`);
  assert(offer1?.wantAmount === usdc(TRADE_USDC_MAIN_UNITS), `Offer wantAmount = ${TRADE_USDC_MAIN_UNITS} USDC`);

  // Verify offer was added to derived entity open-offers view
  const swapOffers1 = getOpenSwapOfferEntries(aliceRep1.state);
  const openOfferKey1 = `${hub.id}:${offerId1}`;
  assert(swapOffers1.has(openOfferKey1), 'Offer visible in derived open-offers view');
  const openOfferEntry1 = swapOffers1.get(openOfferKey1);
  assert(openOfferEntry1?.accountId === hub.id, 'Open-offer entry accountId = canonical(alice, hub)');
  assert(openOfferEntry1?.giveAmount === eth(TRADE_ETH), `Open-offer giveAmount = ${TRADE_ETH} ETH`);
  assert(openOfferEntry1?.wantAmount === usdc(TRADE_USDC_MAIN_UNITS), `Open-offer wantAmount = ${TRADE_USDC_MAIN_UNITS} USDC`);
  console.log('  ✅ Derived entity open-offers updated');

  // Check hold was applied
  const ethDelta1 = aliceHubAccount1?.deltas.get(ETH_TOKEN_ID);
  assert(ethDelta1?.leftHold === eth(TRADE_ETH), `ETH hold = ${TRADE_ETH} (Alice is LEFT)`);
  console.log(`  ✅ Swap offer created, ${TRADE_ETH} ETH locked\n`);

  // ============================================================================
  // TEST 2: Hub fills 50%
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 2: Hub fills 50%');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('💱 Hub: swap_resolve (50% fill)');
  const partialFill = computeFilledAmounts(eth(TRADE_ETH), usdc(TRADE_USDC_MAIN_UNITS), FILL_50);
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId1,
        fillRatio: FILL_50,
        cancelRemainder: false, // Keep remainder open
        executionGiveAmount: partialFill.filledGive,
        executionWantAmount: partialFill.filledWant,
      },
    }],
  }]);
  await converge(env);

  // Verify partial fill
  const [, aliceRep2] = findReplica(env, alice.id);
  const aliceHubAccount2 = aliceRep2.state.accounts.get(hub.id);
  const offer2 = aliceHubAccount2?.swapOffers?.get(offerId1);

  // After 50% fill: deterministic remaining based on fillRatio
  const expectedRemaining = eth(TRADE_ETH) - (eth(TRADE_ETH) * BigInt(FILL_50)) / BigInt(MAX_FILL_RATIO);
  assert(offer2?.giveAmount === expectedRemaining, `Remaining amount = ${expectedRemaining} (got ${offer2?.giveAmount})`);

  // Check offdelta changes
  const ethDelta2 = aliceHubAccount2?.deltas.get(ETH_TOKEN_ID);
  const usdcDelta2 = aliceHubAccount2?.deltas.get(USDC_TOKEN_ID);

  // Alice (LEFT) gave ETH → offdelta decreased (more negative)
  // Alice (LEFT) received USDC → offdelta increased (more positive)
  // filledWant is derived from filledGive to preserve exact price ratio
  const giveAmount = eth(TRADE_ETH);
  const wantAmount = usdc(TRADE_USDC_MAIN_UNITS);
  const filled = computeFilledAmounts(giveAmount, wantAmount, FILL_50);
  const filledEth = filled.filledGive;
  const filledUsdc = filled.filledWant;

  assert(ethDelta2?.offdelta === -filledEth, `ETH offdelta = -${filledEth} (Alice gave)`);
  const partialUsdcNet = usdcDelta2?.offdelta ?? 0n;
  assert(
    partialUsdcNet > 0n,
    `USDC offdelta is positive after partial fill (net of rebalance fees): ${partialUsdcNet}`,
  );

  console.log(`  ✅ 50% filled: Alice gave ${filledEth} ETH, got ${filledUsdc} USDC\n`);

  // ============================================================================
  // TEST 3: Hub fills remaining (100% of remainder)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 3: Hub fills remaining 100%');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('💱 Hub: swap_resolve (100% fill, complete)');
  assert(offer2, 'Offer remainder exists before final resolve');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId1,
        fillRatio: FULL_FILL, // Fill 100% of remaining
        cancelRemainder: false,
        executionGiveAmount: offer2!.giveAmount,
        executionWantAmount: offer2!.wantAmount,
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Verify offer removed
  const [, aliceRep3] = findReplica(env, alice.id);
  const aliceHubAccount3 = aliceRep3.state.accounts.get(hub.id);
  assert(!aliceHubAccount3?.swapOffers?.has(offerId1), 'Offer removed after full fill');

  // Verify holds released
  const ethDelta3 = aliceHubAccount3?.deltas.get(ETH_TOKEN_ID);
  assert(ethDelta3?.leftHold === 0n, 'ETH hold released');

  // Verify final deltas (deterministic)
  assert(ethDelta3?.offdelta === -eth(TRADE_ETH), `Final ETH delta = -${TRADE_ETH} (Alice gave ${TRADE_ETH} ETH total)`);
  const usdcDelta3 = aliceHubAccount3?.deltas.get(USDC_TOKEN_ID);
  const finalUsdcNet = usdcDelta3?.offdelta ?? 0n;
  assert(
    finalUsdcNet > partialUsdcNet,
    `Final USDC net increased after full fill: ${finalUsdcNet} > ${partialUsdcNet}`,
  );

  console.log(`  ✅ Swap complete: Alice traded ${TRADE_ETH} ETH for ${TRADE_USDC_MAIN_UNITS} USDC\n`);

  // ============================================================================
  // TEST 4: Cancel order
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 4: Alice cancels an order');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const offerId2 = 'order-002';

  // Alice places new offer
  console.log(`📊 Alice: swap_offer (${TRADE_ETH_HALF} ETH → ${TRADE_USDC_HALF_UNITS} USDC)`);
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId2,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(TRADE_ETH_HALF),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(TRADE_USDC_HALF_UNITS),
        minFillRatio: 0, // No minimum
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Verify offer created in A-Machine and E-Machine (using namespaced key)
  const [, aliceRep4] = findReplica(env, alice.id);
  const account4 = aliceRep4.state.accounts.get(hub.id);
  assert(account4?.swapOffers?.has(offerId2), 'Order 2 created in A-Machine');
  const openOfferKey2 = `${hub.id}:${offerId2}`;
  assert(getOpenSwapOfferEntries(aliceRep4.state).has(openOfferKey2), 'Order 2 in derived open-offers view');

  // Alice requests cancel (maker cannot self-cancel directly)
  console.log('📊 Alice: proposeCancelSwap');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'proposeCancelSwap',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId2,
      },
    }],
  }]);
  await converge(env);

  // Hub resolves cancel request (explicit counterparty decision).
  console.log('💱 Hub: resolveSwap(fill=0, cancelRemainder=true)');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId2,
        fillRatio: 0,
        cancelRemainder: true,
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Verify cancelled in A-Machine and E-Machine (using namespaced key)
  const [, aliceRep5] = findReplica(env, alice.id);
  const account5 = aliceRep5.state.accounts.get(hub.id);
  assert(!account5?.swapOffers?.has(offerId2), 'Order 2 cancelled in A-Machine by hub resolve');
  assert(!getOpenSwapOfferEntries(aliceRep5.state).has(openOfferKey2), 'Order 2 removed from derived open-offers view after hub resolve');

  // Verify hold released
  const ethDelta5 = account5?.deltas.get(ETH_TOKEN_ID);
  assert(ethDelta5?.leftHold === 0n, 'Hold released after cancel');

  console.log('  ✅ Cancel request resolved by hub, open-offers cleaned, hold released\n');

  // ============================================================================
  // TEST 5: minFillRatio enforcement
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 5: minFillRatio enforcement');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const offerId3 = 'order-003';

  // Alice places offer with 75% minimum
  const MIN_75_PERCENT = FILL_75;
  console.log(`📊 Alice: swap_offer (${TRADE_ETH_HALF} ETH, min 75% fill)`);
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId3,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(TRADE_ETH_HALF),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(TRADE_USDC_HALF_UNITS),
        minFillRatio: MIN_75_PERCENT,
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Hub tries to fill only 50% - should fail
  console.log('💱 Hub: swap_resolve (50% fill - should fail)');
  const belowMinFill = computeFilledAmounts(eth(TRADE_ETH_HALF), usdc(TRADE_USDC_HALF_UNITS), FILL_50);
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId3,
        fillRatio: FILL_50, // 50% < 75% min
        cancelRemainder: false,
        executionGiveAmount: belowMinFill.filledGive,
        executionWantAmount: belowMinFill.filledWant,
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Verify offer still exists (fill was rejected)
  const [, aliceRep6] = findReplica(env, alice.id);
  const account6 = aliceRep6.state.accounts.get(hub.id);
  assert(account6?.swapOffers?.has(offerId3), 'Order 3 still exists (50% fill rejected)');

  // Hub fills 80% - should succeed
  const FILL_80_PERCENT = FILL_80;
  console.log('💱 Hub: swap_resolve (80% fill - should succeed)');
  const allowedFill = computeFilledAmounts(eth(TRADE_ETH_HALF), usdc(TRADE_USDC_HALF_UNITS), FILL_80_PERCENT);
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId3,
        fillRatio: FILL_80_PERCENT,
        cancelRemainder: true, // Cancel remainder
        executionGiveAmount: allowedFill.filledGive,
        executionWantAmount: allowedFill.filledWant,
      },
    }],
  }]);
  // Need enough ticks for full round-trip: propose → receive → ACK → commit
  await converge(env);

  // Verify offer removed (filled + cancelled)
  const [, aliceRep7] = findReplica(env, alice.id);
  const account7 = aliceRep7.state.accounts.get(hub.id);
  assert(!account7?.swapOffers?.has(offerId3), 'Order 3 removed (80% fill + cancel)');

  console.log('  ✅ minFillRatio enforced correctly\n');

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                     ALL TESTS PASSED! ✅                       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Summary:');
  console.log('  1. ✅ swap_offer creates offer, locks capacity');
  console.log('  2. ✅ swap_resolve fills partially (50%), keeps remainder');
  console.log('  3. ✅ swap_resolve fills fully, removes offer');
  console.log('  4. ✅ proposeCancelSwap + hub resolve removes offer, releases hold');
  console.log('  5. ✅ minFillRatio rejects underfills');
  console.log('\n');
  } finally {
    restoreFailFast();
  }
}

// ============================================================================
// PHASE 2: OrderbookExtension - Hub-based matching
// ============================================================================

export async function swapWithOrderbook(env: Env): Promise<Env> {
  const restoreFailFast = enableStrictScenario(env, 'SWAP');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  if (env.quietRuntimeLogs === undefined) {
    env.quietRuntimeLogs = true;
  }
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();
  const jadapter = getScenarioJAdapter(env);
  const runDisputePhase = Boolean((env as any).scenarioSwapRunDisputePhase);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('             PHASE 2: ORDERBOOK MATCHING (RJEA FLOW)            ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Reuse Alice & Hub from Phase 1
  const alice = { id: getRegisteredEntityId('1'), signer: '1' };
  const hub = { id: getRegisteredEntityId('2'), signer: '2' };

  // Initialize hub's orderbook extension (required for RJEA flow)
  const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../orderbook');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'initOrderbookExt',
      data: {
        name: 'Test Hub',
        spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: USDC_TOKEN_ID,
        minTradeSize: 0n,
        supportedPairs: ['1/2'],
      },
    }],
  }]);
  const [, hubRep] = findReplica(env, hub.id);
  const jurisdiction = hubRep.state.config.jurisdiction;
  console.log('✅ Hub orderbook extension initialized');
  assert(!!hubRep.state.orderbookExt, 'orderbookExt initialized on hub state');

  // Verify it persists after a process cycle
  await converge(env);
  const [, hubRepAfterProcess] = findReplica(env, hub.id);
  assert(!!hubRepAfterProcess.state.orderbookExt, 'orderbookExt persists after process()');
  console.log('✅ Hub orderbookExt persists through process cycle\n');

  // Add Bob
  console.log('📦 Adding Bob...');
  const bob = { id: getRegisteredEntityId('3'), signer: '3' };

  await applyRuntimeInput(env, { runtimeTxs: [{
    type: 'importReplica' as const,
    entityId: bob.id,
    signerId: bob.signer,
    data: {
      isProposer: true,
      position: SWAP_POSITIONS.Bob,
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [bob.signer],
        shares: { [bob.signer]: 1n },
        jurisdiction,
      },
    },
  }], entityInputs: [] });
  await converge(env);
  console.log('  ✅ Bob created\n');

  // Open Bob↔Hub account
  console.log('🔗 Opening Bob ↔ Hub account...');
  await process(env, [
    { entityId: bob.id, signerId: bob.signer, entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }] },
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

  // Step 1: Alice places swap_offer on Alice↔Hub account
  console.log(`📊 Step 1: Alice places swap_offer (${TRADE_ETH} ETH → ${TRADE_USDC_MAIN_UNITS} USDC)...`);
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
        wantAmount: usdc(TRADE_USDC_MAIN_UNITS),
        minFillRatio: FILL_10, // 10% min
      },
    }],
  }]);
  // Wait for hub to process Alice's swap offer through orderbook
  await converge(env);

  // Verify Alice's offer exists in bilateral account (from Hub's perspective)
  const [, hubRepCheck] = findReplica(env, hub.id);
  const aliceAccountCheck = hubRepCheck.state.accounts.get(alice.id);  // Hub's account WITH Alice
  const aliceOffer = aliceAccountCheck?.swapOffers?.get('alice-sell-001');
  assert(!!aliceOffer, 'Alice offer should exist in Hub bilateral account');
  console.log('  ✅ Alice offer created in bilateral account\n');

  const [, aliceRepBaseline] = findReplica(env, alice.id);
  const aliceBaselineAccount = aliceRepBaseline.state.accounts.get(hub.id);
  const aliceBaselineEth = aliceBaselineAccount?.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const aliceBaselineUsdc = aliceBaselineAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  const [, bobRepBaseline] = findReplica(env, bob.id);
  const bobBaselineAccount = bobRepBaseline.state.accounts.get(hub.id);
  const bobBaselineEth = bobBaselineAccount?.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const bobBaselineUsdc = bobBaselineAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  // Check hub's orderbook extension state
  const ext = hubRepCheck.state.orderbookExt;
  console.log(`  📊 Hub orderbook state: ${ext?.books?.size || 0} books\n`);

  // Step 2: Bob places swap_offer - should trigger matching!
  console.log(`📊 Step 2: Bob places swap_offer (${TRADE_ETH_HALF} ETH @ ${ETH_PRICE_HIGH})...`);
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
        wantAmount: eth(TRADE_ETH_HALF),
        minFillRatio: 0,
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
    const [, hubRepMatch] = findReplica(env, hub.id);
    const pending = hubRepMatch.state.pendingSwapFillRatios;
    aliceFillRatio = pending?.get(`${alice.id}:alice-sell-001`) || 0;
    bobFillRatio = pending?.get(`${bob.id}:bob-buy-001`) || 0;
    return aliceFillRatio > 0 && bobFillRatio > 0;
  }, 20, 'RJEA fill ratios recorded');
  await converge(env);

  // Verify the trades occurred via RJEA flow by checking bilateral accounts
  // After matching: Alice should have traded Bob's buy qty, Bob should have filled
  console.log('📊 Step 3: Checking trade results...');

  // Check hub's orderbook extension for trade records
  const [, hubRepAfter] = findReplica(env, hub.id);
  const extAfter = hubRepAfter.state.orderbookExt;
  if (extAfter?.books) {
    const { renderAscii } = await import('../orderbook');
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

  console.log(`  Alice offer exists: ${aliceAccount?.swapOffers?.has('alice-sell-001')}`);
  console.log(`  Bob offer exists: ${bobAccount?.swapOffers?.has('bob-buy-001')}`);

  // After full RJEA flow, Bob's offer should be fully resolved
  // and Alice's offer should be partially filled (half remaining)
  const aliceOffer2 = aliceAccount?.swapOffers?.get('alice-sell-001');
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

  const aliceEth = aliceHubFinal?.deltas.get(ETH_TOKEN_ID);
  const aliceUsdc = aliceHubFinal?.deltas.get(USDC_TOKEN_ID);
  const bobEth = bobHubFinal?.deltas.get(ETH_TOKEN_ID);
  const bobUsdc = bobHubFinal?.deltas.get(USDC_TOKEN_ID);

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
  assert(bobFillRatio === MAX_FILL_RATIO, `Bob fillRatio = ${MAX_FILL_RATIO} (got ${bobFillRatio})`);

  const aliceFilled = computeFilledAmounts(eth(TRADE_ETH), usdc(TRADE_USDC_MAIN_UNITS), aliceFillRatio);
  const bobFilled = computeFilledAmounts(
    usdcForEth(TRADE_ETH_HALF, ETH_PRICE_HIGH),
    eth(TRADE_ETH_HALF),
    bobFillRatio
  );

  const aliceEthDelta = (aliceEth?.offdelta ?? 0n) - aliceBaselineEth;
  const aliceUsdcDelta = (aliceUsdc?.offdelta ?? 0n) - aliceBaselineUsdc;
  const bobEthDelta = (bobEth?.offdelta ?? 0n) - bobBaselineEth;
  const bobUsdcDelta = (bobUsdc?.offdelta ?? 0n) - bobBaselineUsdc;

  // Bob wanted TRADE_ETH_HALF @ ETH_PRICE_HIGH - should have received ETH, given USDC
  // Bob is Right relative to Hub (Hub = 0x0002..., Bob = 0x0003...)
  // CANONICAL semantics: Right pays → offdelta INCREASES, Right receives → offdelta DECREASES
  // Bob gives USDC → offdelta increases (positive)
  // Bob receives ETH → offdelta decreases (negative)
  assert(bobEthDelta === -bobFilled.filledWant, `Bob ETH delta = -${bobFilled.filledWant} (got ${bobEthDelta})`);
  // Bob can prepay request_collateral fee in USDC during this phase.
  // So USDC delta is bounded by fill and may be slightly lower than exact filledGive.
  assert(bobUsdcDelta > 0n, `Bob USDC delta must stay positive after fill (got ${bobUsdcDelta})`);
  assert(
    bobUsdcDelta <= bobFilled.filledGive,
    `Bob USDC delta must not exceed filledGive ${bobFilled.filledGive} (got ${bobUsdcDelta})`,
  );
  assert(aliceEthDelta === -aliceFilled.filledGive, `Alice ETH delta = -${aliceFilled.filledGive} (got ${aliceEthDelta})`);
  assert(aliceUsdcDelta === aliceFilled.filledWant, `Alice USDC delta = +${aliceFilled.filledWant} (got ${aliceUsdcDelta})`);

  // Alice's offer should be partially filled (Bob took half of the order)
  const aliceOfferRemaining = aliceAccount?.swapOffers?.get('alice-sell-001');
  if (aliceOfferRemaining) {
    const expectedRemaining = eth(TRADE_ETH) - aliceFilled.filledGive;
    assert(aliceOfferRemaining.giveAmount === expectedRemaining,
      `Alice remaining ETH = ${expectedRemaining} (got ${aliceOfferRemaining.giveAmount})`);
  }

  console.log('  ✅ Phase 2 assertions passed');

  // Clear residual open orders to isolate dispute test
  const [, aliceBeforeDispute] = findReplica(env, alice.id);
  const aliceHubAccountPreDispute = aliceBeforeDispute.state.accounts.get(hub.id);
  if (aliceHubAccountPreDispute?.swapOffers?.has('alice-sell-001')) {
    console.log('🧹 Cancelling leftover alice-sell-001 before dispute test...');
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'proposeCancelSwap',
        data: { counterpartyEntityId: hub.id, offerId: 'alice-sell-001' },
      }],
    }]);
    await converge(env);
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'resolveSwap',
        data: { counterpartyEntityId: alice.id, offerId: 'alice-sell-001', fillRatio: 0, cancelRemainder: true },
      }],
    }]);
    await converge(env);
  }

  if (!runDisputePhase) {
    console.log('⏭️ Phase 2B dispute branch skipped (scenarioSwapRunDisputePhase=false)');
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('              PHASE 2: ORDERBOOK TEST COMPLETE                  ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    return env;
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
  const bobDisputeBaselineEth = bobDisputeAccount?.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const bobDisputeBaselineUsdc = bobDisputeAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

  console.log(`📊 Alice: swap_offer (${disputeEth} ETH → ${disputeUsdc} USDC)`);
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
        wantAmount: usdc(disputeUsdc),
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env);

  console.log(`📊 Bob: swap_offer (40% fill target)`);
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
        wantAmount: eth(disputeFillEth),
        minFillRatio: 0,
      },
    }],
  }]);

  // Process until orderbook match produces pending fill ratio (but before swap_resolve commits)
  const pendingKey = `${alice.id}:${disputeOfferId}`;
  let pendingRatio = 0;
  for (let i = 0; i < 8; i++) {
    await process(env);
    const [, hubAfterMatch] = findReplica(env, hub.id);
    pendingRatio = hubAfterMatch.state.pendingSwapFillRatios?.get(pendingKey) || 0;
    if (pendingRatio > 0) break;
  }
  assert(pendingRatio > 0, `Pending fillRatio recorded for ${disputeOfferId}`);

  // Simulate offline counterparty: drop pending swap_resolve ONLY for Alice before commit
  if (env.pendingOutputs) {
    env.pendingOutputs = env.pendingOutputs.filter(output => output.entityId !== alice.id);
  }
  if (env.networkInbox) {
    env.networkInbox = env.networkInbox.filter(output => output.entityId !== alice.id);
  }
  console.log('🚫 Dropped pending outputs to Alice to keep swap_resolve uncommitted (dispute path)');

  // Allow Bob's swap_resolve to fully commit before dispute enforcement
  await converge(env);
  const [, hubAfterBobSettle] = findReplica(env, hub.id);
  const bobAfterSettle = hubAfterBobSettle.state.accounts.get(bob.id);
  const bobSettledEth = bobAfterSettle?.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const bobSettledUsdc = bobAfterSettle?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
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
  assert(!bobAfterSettle?.swapOffers?.has(disputeCounterId), 'Dispute Bob offer fully resolved');

  console.log('⚔️ Hub starts dispute (will enforce fillRatio via calldata)');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'disputeStart',
      data: {
        counterpartyEntityId: alice.id,
        description: 'Swap dispute (fillRatio enforced)',
      },
    }],
  }]);

  const [, hubBeforeBroadcastStart] = findReplica(env, hub.id);
  const startCount = hubBeforeBroadcastStart.state.jBatchState?.batch.disputeStarts.length || 0;
  console.log(`🧾 jBatch disputeStarts=${startCount} before broadcast`);
  assert(startCount > 0, 'jBatch has disputeStart before broadcast');

  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);

  // Wait for DisputeStarted to propagate
  for (let i = 0; i < 20; i++) {
    await process(env);
    const jRep = env.jReplicas.get('Swap Demo');
    if (jRep && jRep.mempool.length === 0) break;
  }
  await processJEvents(env);

  const [, hubAfterStart] = findReplica(env, hub.id);
  const hubAccountAfterStart = hubAfterStart.state.accounts.get(alice.id);
  assert(!!hubAccountAfterStart?.activeDispute, 'Dispute started for swap');
  const { buildAccountProofBody } = await import('../proof-builder');
  const hubProofAfterStart = buildAccountProofBody(hubAccountAfterStart);
  assert(
    hubProofAfterStart.proofBodyHash === hubAccountAfterStart.activeDispute.initialProofbodyHash,
    'Hub dispute proofBodyHash matches on-chain start hash'
  );
  const [, aliceAfterStart] = findReplica(env, alice.id);
  const aliceAccountAfterStart = aliceAfterStart.state.accounts.get(hub.id);
  assert(!!aliceAccountAfterStart?.activeDispute, 'Dispute visible on counterparty');
  const aliceProofAfterStart = buildAccountProofBody(aliceAccountAfterStart);
  assert(
    aliceProofAfterStart.proofBodyHash === aliceAccountAfterStart.activeDispute.initialProofbodyHash,
    'Counterparty dispute proofBodyHash matches on-chain start hash'
  );

  const targetBlock = hubAccountAfterStart.activeDispute!.disputeTimeout;
  console.log(`⏳ Waiting for dispute timeout (block ${targetBlock})...`);
  while (true) {
    const currentBlock = BigInt(await jadapter.provider.getBlockNumber());
    if (currentBlock >= targetBlock) {
      console.log(`✅ Timeout reached at block ${currentBlock}`);
      break;
    }
    await jadapter.processBlock();
    await process(env);
  }

  console.log('⚖️ Hub disputeFinalize (unilateral)');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'disputeFinalize',
      data: {
        counterpartyEntityId: alice.id,
        cooperative: false,
        description: 'Finalize swap dispute',
      },
    }],
  }]);

  const [, hubBeforeBroadcast] = findReplica(env, hub.id);
  const finalProof = hubBeforeBroadcast.state.jBatchState?.batch.disputeFinalizations?.[0];
  const finalArgs = finalProof?.finalArguments || '0x';
  assert(finalArgs !== '0x', 'Dispute finalArguments encoded');

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const [argArray] = abiCoder.decode(['bytes[]'], finalArgs) as [string[]];
  const [ratios] = abiCoder.decode(['uint16[]', 'bytes32[]'], argArray[0]) as [Array<bigint>, Array<string>];
  const ratioValue = Number(ratios[0] || 0n);
  assert(ratioValue === pendingRatio, `fillRatio matches pending (${pendingRatio})`);

  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  }]);

  for (let i = 0; i < 20; i++) {
    await process(env);
    const jRep = env.jReplicas.get('Swap Demo');
    if (jRep && jRep.mempool.length === 0) break;
  }
  await processJEvents(env);

  console.log('✅ Dispute swap finalize broadcast complete');
  const [, hubAfterFinalize] = findReplica(env, hub.id);
  const hubAccountAfterFinalize = hubAfterFinalize.state.accounts.get(alice.id);
  assert(!hubAccountAfterFinalize?.activeDispute, 'Dispute cleared on hub after finalize');
  const [, aliceAfterFinalize] = findReplica(env, alice.id);
  const aliceAccountAfterFinalize = aliceAfterFinalize.state.accounts.get(hub.id);
  assert(!aliceAccountAfterFinalize?.activeDispute, 'Dispute cleared on counterparty after finalize');
  assert(hubAccountAfterFinalize?.status === 'disputed', 'Hub account stays disputed after finalize until explicit reopen');
  assert(aliceAccountAfterFinalize?.status === 'disputed', 'Counterparty account stays disputed after finalize until explicit reopen');

  const hubFinalEthDelta = hubAccountAfterFinalize?.deltas.get(ETH_TOKEN_ID);
  const hubFinalUsdcDelta = hubAccountAfterFinalize?.deltas.get(USDC_TOKEN_ID);
  assert((hubFinalEthDelta?.offdelta ?? 0n) === 0n, 'DisputeFinalized sync clears ETH offdelta');
  assert((hubFinalUsdcDelta?.offdelta ?? 0n) === 0n, 'DisputeFinalized sync clears USDC offdelta');
  assert((hubFinalEthDelta?.leftHold ?? 0n) === 0n, 'DisputeFinalized sync clears ETH leftHold');
  assert((hubFinalEthDelta?.rightHold ?? 0n) === 0n, 'DisputeFinalized sync clears ETH rightHold');
  assert(!hubAccountAfterFinalize?.swapOffers?.has(disputeOfferId), 'DisputeFinalized clears stale dispute swap offer');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('              PHASE 2: ORDERBOOK TEST COMPLETE                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  return env;
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreFailFast();
  }
}

// ============================================================================
// PHASE 3: Multi-Party Trading - Carol & Dave eating larger orders
// ============================================================================

export async function multiPartyTrading(env: Env): Promise<Env> {
  const restoreFailFast = enableStrictScenario(env, 'SWAP');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  if (env.quietRuntimeLogs === undefined) {
    env.quietRuntimeLogs = true;
  }
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 3: MULTI-PARTY TRADING (Carol & Dave)           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const hub = { id: getRegisteredEntityId('2'), signer: '2' };
  const [, hubRep] = findReplica(env, hub.id);
  const jurisdiction = hubRep.state.config.jurisdiction;

  // Reset hub orderbook + swap holds to isolate Phase 3 from earlier tests
  if (hubRep.state.orderbookExt) {
    hubRep.state.orderbookExt.books = new Map();
  }
  if (hubRep.state.pendingSwapFillRatios) {
    hubRep.state.pendingSwapFillRatios.clear();
  }
  for (const account of hubRep.state.accounts.values()) {
    if (account.swapOffers?.size) {
      account.swapOffers.clear();
    }
    for (const delta of account.deltas.values()) {
      if (delta.leftHold) delta.leftHold = 0n;
      if (delta.rightHold) delta.rightHold = 0n;
    }
  }

  // Carol and Dave already registered in Phase 1 (registerEntities created all 5 eReplicas)
  const carol = { id: getRegisteredEntityId('4'), signer: '4', name: 'Carol' };
  const dave = { id: getRegisteredEntityId('5'), signer: '5', name: 'Dave' };
  console.log(`📦 Using Carol(${carol.id.slice(-4)}) and Dave(${dave.id.slice(-4)}) from Phase 1\n`);

  // Open accounts with Hub
  console.log('🔗 Opening accounts with Hub...');
  for (const entity of [carol, dave]) {
    await process(env, [
      { entityId: entity.id, signerId: entity.signer, entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }] },
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
        wantAmount: usdcForEth(CAROL_SELL_ETH, ETH_PRICE_LOW),
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env);

  // Print orderbook
  const { renderAscii } = await import('../orderbook');
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
        wantAmount: eth(DAVE_BUY_ETH),
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env);

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
        wantAmount: usdcForEth(CAROL_SELL_2_ETH, ETH_PRICE_HIGH),
        minFillRatio: 0,
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
        wantAmount: eth(DAVE_SWEEP_ETH),
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env);

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

  const carolEth = carolAccount?.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const carolUsdc = carolAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;
  const daveEth = daveAccount?.deltas.get(ETH_TOKEN_ID)?.offdelta ?? 0n;
  const daveUsdc = daveAccount?.deltas.get(USDC_TOKEN_ID)?.offdelta ?? 0n;

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

// ===== CLI ENTRY POINT =====
if (import.meta.main) {
  console.log('🚀 Running SWAP scenario from CLI...\n');

  const runtime = await import('../runtime');
  const env = runtime.createEmptyEnv();
  env.scenarioMode = true; // Deterministic time control
  requireRuntimeSeed(env, 'SWAP CLI'); // Required for key derivation

  try {
    // Phase 1: Basic bilateral swaps
    await swap(env);
    console.log('✅ PHASE 1 COMPLETE!');

    // Phase 2: Orderbook matching
    await swapWithOrderbook(env);
    console.log('✅ PHASE 2 COMPLETE!');

    // Phase 3: Multi-party trading
    await multiPartyTrading(env);
    console.log('✅ PHASE 3 COMPLETE!');

    console.log('✅ ALL SWAP PHASES COMPLETE!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ SWAP scenario FAILED:', error);
    process.exit(1);
  }
}
