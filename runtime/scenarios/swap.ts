/**
 * Swap Scenario: Self-Testing Bilateral Swap Demo
 *
 * Tests same-J (same jurisdiction) swaps between Alice and Hub.
 * Hub acts as market maker, filling Alice's limit orders.
 * Uses REAL BrowserVM for J-Machine (same as ahb.ts).
 *
 * Test flow:
 * 1. Setup: Alice-Hub account with ETH (token 1) and USDC (token 2)
 * 2. Alice places limit order: Sell 2 ETH for 6000 USDC
 * 3. Hub fills 50%: Alice gets 3000 USDC, Hub gets 1 ETH
 * 4. Hub fills remaining 50%: Swap complete
 * 5. Verify final balances
 * 6. Test partial fill with minFillRatio
 * 7. Test cancel
 *
 * Run with: bun runtime/scenarios/swap.ts
 */

import type { Env, EntityInput, JurisdictionConfig } from '../types';
import { getBestAsk } from '../orderbook/core';
import { ensureBrowserVM, createJReplica, createJurisdictionConfig } from './boot';
import { canonicalAccountKey } from '../state-helpers';
import { formatRuntime, formatEntity } from '../runtime-ascii';
import { formatRuntime } from '../runtime-ascii';

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

// Helper: Process until no outputs generated (convergence)
async function converge(env: Env, maxCycles = 10): Promise<void> {
  const process = await getProcess();
  for (let i = 0; i < maxCycles; i++) {
    await process(env);
    // Check if all mempools are empty and no pending frames
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

// Token IDs
const ETH_TOKEN_ID = 1;
const USDC_TOKEN_ID = 2;

// Precision
const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

const eth = (amount: number | bigint) => BigInt(amount) * ONE;
const usdc = (amount: number | bigint) => BigInt(amount) * ONE;

// Fill ratio constants
const MAX_FILL_RATIO = 65535;
const HALF_FILL = Math.floor(MAX_FILL_RATIO / 2); // ~50%
const FULL_FILL = MAX_FILL_RATIO;

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

  const browserVM = await ensureBrowserVM();
  const depositoryAddress = browserVM.getDepositoryAddress();
  createJReplica(env, 'Swap Demo', depositoryAddress, { x: 0, y: 100, z: 0 });
  const jurisdiction = createJurisdictionConfig('Swap Demo', depositoryAddress);
  console.log('✅ BrowserVM J-Machine created\n');

  // ============================================================================
  // SETUP: Create Alice and Hub entities
  // ============================================================================
  console.log('📦 Creating entities: Alice, Hub...');

  const entities = [
    { name: 'Alice', id: '0x' + '1'.padStart(64, '0'), signer: 's1' },
    { name: 'Hub', id: '0x' + '2'.padStart(64, '0'), signer: 's2' },
  ];

  const createEntityTxs = entities.map(e => ({
    type: 'importReplica' as const,
    entityId: e.id,
    signerId: e.signer,
    data: {
      isProposer: true,
      position: { x: 0, y: 0, z: 0 },
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [e.signer],
        shares: { [e.signer]: 1n },
      },
    },
  }));

  await applyRuntimeInput(env, { runtimeTxs: createEntityTxs, entityInputs: [] });

  const [alice, hub] = entities;
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
        { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: ETH_TOKEN_ID, amount: eth(1_000_000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: alice.id, tokenId: USDC_TOKEN_ID, amount: usdc(1_000_000) } },
      ],
    },
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH_TOKEN_ID, amount: eth(1_000_000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: usdc(1_000_000) } },
      ],
    },
  ]);

  // Wait for all credit frames to converge
  await converge(env);

  console.log('  ✅ Bidirectional credit established\n');

  // ============================================================================
  // TEST 1: Simple swap - Alice sells 2 ETH for 6000 USDC
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 1: Alice places limit order - Sell 2 ETH for 6000 USDC');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const offerId1 = 'order-001';

  // Alice places swap offer
  console.log('📊 Alice: swap_offer (2 ETH → 6000 USDC, min 50%)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId1,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(2),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(6000),
        minFillRatio: HALF_FILL, // 50% minimum
      },
    }],
  }]);
  await converge(env); // Wait for full consensus

  // Verify offer was created in A-Machine
  const [, aliceRep1] = findReplica(env, alice.id);
  const aliceHubAccount1 = aliceRep1.state.accounts.get(hub.id);
  assert(aliceHubAccount1?.swapOffers?.has(offerId1), 'Offer created in A-Machine account');

  const offer1 = aliceHubAccount1?.swapOffers?.get(offerId1);
  assert(offer1?.giveAmount === eth(2), 'Offer giveAmount = 2 ETH');
  assert(offer1?.wantAmount === usdc(6000), 'Offer wantAmount = 6000 USDC');

  // Verify offer was added to E-Machine swapBook (using namespaced key)
  const swapBookKey1 = `${hub.id}:${offerId1}`;
  assert(aliceRep1.state.swapBook.has(swapBookKey1), 'Offer added to E-Machine swapBook');
  const swapBookEntry1 = aliceRep1.state.swapBook.get(swapBookKey1);
  assert(swapBookEntry1?.accountId === hub.id, 'swapBook entry accountId = canonical(alice, hub)');
  assert(swapBookEntry1?.giveAmount === eth(2), 'swapBook giveAmount = 2 ETH');
  assert(swapBookEntry1?.wantAmount === usdc(6000), 'swapBook wantAmount = 6000 USDC');
  console.log('  ✅ E-Machine swapBook updated');

  // Check hold was applied
  const ethDelta1 = aliceHubAccount1?.deltas.get(ETH_TOKEN_ID);
  assert(ethDelta1?.leftSwapHold === eth(2), 'ETH hold = 2 (Alice is LEFT)');
  console.log('  ✅ Swap offer created, 2 ETH locked\n');

  // ============================================================================
  // TEST 2: Hub fills 50%
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 2: Hub fills 50%');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('💱 Hub: swap_resolve (50% fill)');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId1,
        fillRatio: HALF_FILL,
        cancelRemainder: false, // Keep remainder open
      },
    }],
  }]);
  await converge(env);

  // Verify partial fill
  const [, aliceRep2] = findReplica(env, alice.id);
  const aliceHubAccount2 = aliceRep2.state.accounts.get(hub.id);
  const offer2 = aliceHubAccount2?.swapOffers?.get(offerId1);

  // After 50% fill: ~1 ETH remaining
  const expectedRemaining = eth(2) - (eth(2) * BigInt(HALF_FILL)) / BigInt(MAX_FILL_RATIO);
  assert(offer2?.giveAmount === expectedRemaining, `Remaining amount ~1 ETH (got ${offer2?.giveAmount})`);

  // Check offdelta changes
  const ethDelta2 = aliceHubAccount2?.deltas.get(ETH_TOKEN_ID);
  const usdcDelta2 = aliceHubAccount2?.deltas.get(USDC_TOKEN_ID);

  // Alice (LEFT) gave ETH → offdelta decreased (more negative)
  // Alice (LEFT) received USDC → offdelta increased (more positive)
  // filledWant is derived from filledGive to preserve exact price ratio
  const giveAmount = eth(2);
  const wantAmount = usdc(6000);
  const filledEth = (giveAmount * BigInt(HALF_FILL)) / BigInt(MAX_FILL_RATIO);
  const filledUsdc = (filledEth * wantAmount) / giveAmount; // Derived from filledEth

  assert(ethDelta2?.offdelta === -filledEth, `ETH offdelta = -${filledEth} (Alice gave)`);
  assert(usdcDelta2?.offdelta === filledUsdc, `USDC offdelta = +${filledUsdc} (Alice received)`);

  console.log(`  ✅ 50% filled: Alice gave ${filledEth} ETH, got ${filledUsdc} USDC\n`);

  // ============================================================================
  // TEST 3: Hub fills remaining (100% of remainder)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 3: Hub fills remaining 100%');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('💱 Hub: swap_resolve (100% fill, complete)');
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
  assert(ethDelta3?.leftSwapHold === 0n, 'ETH hold released');

  // Verify final deltas (approximate due to rounding)
  assert(ethDelta3?.offdelta === -eth(2), 'Final ETH delta = -2 (Alice gave 2 ETH total)');
  const usdcDelta3 = aliceHubAccount3?.deltas.get(USDC_TOKEN_ID);
  assert(usdcDelta3?.offdelta === usdc(6000), 'Final USDC delta = +6000 (Alice received 6000 USDC)');

  console.log('  ✅ Swap complete: Alice traded 2 ETH for 6000 USDC\n');

  // ============================================================================
  // TEST 4: Cancel order
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 4: Alice cancels an order');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const offerId2 = 'order-002';

  // Alice places new offer
  console.log('📊 Alice: swap_offer (1 ETH → 3000 USDC)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId2,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(1),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(3000),
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
  const swapBookKey2 = `${hub.id}:${offerId2}`;
  assert(aliceRep4.state.swapBook.has(swapBookKey2), 'Order 2 in E-Machine swapBook');

  // Alice cancels
  console.log('📊 Alice: swap_cancel');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'cancelSwap',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId2,
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Verify cancelled in A-Machine and E-Machine (using namespaced key)
  const [, aliceRep5] = findReplica(env, alice.id);
  const account5 = aliceRep5.state.accounts.get(hub.id);
  assert(!account5?.swapOffers?.has(offerId2), 'Order 2 cancelled in A-Machine');
  assert(!aliceRep5.state.swapBook.has(swapBookKey2), 'Order 2 removed from E-Machine swapBook');

  // Verify hold released
  const ethDelta5 = account5?.deltas.get(ETH_TOKEN_ID);
  assert(ethDelta5?.leftSwapHold === 0n, 'Hold released after cancel');

  console.log('  ✅ Order cancelled, swapBook cleaned, hold released\n');

  // ============================================================================
  // TEST 5: minFillRatio enforcement
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 5: minFillRatio enforcement');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const offerId3 = 'order-003';

  // Alice places offer with 75% minimum
  const MIN_75_PERCENT = Math.floor(MAX_FILL_RATIO * 0.75);
  console.log('📊 Alice: swap_offer (1 ETH, min 75% fill)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: offerId3,
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(1),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(3000),
        minFillRatio: MIN_75_PERCENT,
      },
    }],
  }]);
  await converge(env);
  await converge(env);

  // Hub tries to fill only 50% - should fail
  console.log('💱 Hub: swap_resolve (50% fill - should fail)');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: alice.id,
        offerId: offerId3,
        fillRatio: HALF_FILL, // 50% < 75% min
        cancelRemainder: false,
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
  const FILL_80_PERCENT = Math.floor(MAX_FILL_RATIO * 0.80);
  console.log('💱 Hub: swap_resolve (80% fill - should succeed)');
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
  console.log('  4. ✅ swap_cancel removes offer, releases hold');
  console.log('  5. ✅ minFillRatio rejects underfills');
  console.log('\n');
}

// ============================================================================
// PHASE 2: OrderbookExtension - Hub-based matching
// ============================================================================

export async function swapWithOrderbook(env: Env): Promise<Env> {
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('             PHASE 2: ORDERBOOK MATCHING (RJEA FLOW)            ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Reuse Alice & Hub from Phase 1
  const alice = { id: '0x' + '1'.padStart(64, '0'), signer: 's1' };
  const hub = { id: '0x' + '2'.padStart(64, '0'), signer: 's2' };

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
  console.log('✅ Hub orderbook extension initialized');
  assert(!!hubRep.state.orderbookExt, 'orderbookExt initialized on hub state');

  // Verify it persists after a process cycle
  await converge(env);
  const [, hubRepAfterProcess] = findReplica(env, hub.id);
  assert(!!hubRepAfterProcess.state.orderbookExt, 'orderbookExt persists after process()');
  console.log('✅ Hub orderbookExt persists through process cycle\n');

  // Add Bob
  console.log('📦 Adding Bob...');
  const bob = { id: '0x' + '3'.padStart(64, '0'), signer: 's3' };

  await applyRuntimeInput(env, { runtimeTxs: [{
    type: 'importReplica' as const,
    entityId: bob.id,
    signerId: bob.signer,
    data: {
      isProposer: true,
      position: { x: 0, y: 0, z: 0 },
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [bob.signer],
        shares: { [bob.signer]: 1n },
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
      { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: ETH_TOKEN_ID, amount: eth(1_000_000) } },
      { type: 'extendCredit', data: { counterpartyEntityId: bob.id, tokenId: USDC_TOKEN_ID, amount: usdc(1_000_000) } },
    ]},
    { entityId: bob.id, signerId: bob.signer, entityTxs: [
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH_TOKEN_ID, amount: eth(1_000_000) } },
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: usdc(1_000_000) } },
    ]},
  ]);
  await converge(env);
  console.log('  ✅ Credit extended\n');

  // ============================================================================
  // TEST: Alice sells 2 ETH, Bob buys 1 ETH - should match via orderbook
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST: Alice SELL 2 ETH @ 3000, Bob BUY 1 ETH @ 3100');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Step 1: Alice places swap_offer on Alice↔Hub account
  console.log('📊 Step 1: Alice places swap_offer (2 ETH → 6000 USDC)...');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'alice-sell-001',
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(2),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(6000),
        minFillRatio: Math.floor(MAX_FILL_RATIO * 0.1), // 10% min
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

  // Check hub's orderbook extension state
  const ext = hubRepCheck.state.orderbookExt;
  console.log(`  📊 Hub orderbook state: ${ext?.books?.size || 0} books\n`);

  // Step 2: Bob places swap_offer - should trigger matching!
  console.log('📊 Step 2: Bob places swap_offer (3100 USDC → 1 ETH)...');
  await process(env, [{
    entityId: bob.id,
    signerId: bob.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'bob-buy-001',
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdc(3100),
        wantTokenId: ETH_TOKEN_ID,
        wantAmount: eth(1),
        minFillRatio: 0,
      },
    }],
  }]);

  // Wait for hub to match and emit swap_resolve via RJEA flow
  // Hub's entity layer sees swapOffersCreated events, runs processOrderbookSwaps,
  // which adds matching orders to the book, detects trades, and queues swap_resolve txs
  console.log('🔄 Step 3: Waiting for RJEA matching and settlement...');
  await converge(env);

  // Verify the trades occurred via RJEA flow by checking bilateral accounts
  // After matching: Alice should have traded 1 ETH (Bob's buy qty), Bob should have filled
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
  // and Alice's offer should be partially filled (1 ETH remaining of 2)
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

  // Bob wanted 1 ETH @ 3100 USDC - should have received ETH, given USDC
  // Bob is Right relative to Hub (Hub = 0x0002..., Bob = 0x0003...)
  // CANONICAL semantics: Right pays → offdelta INCREASES, Right receives → offdelta DECREASES
  // Bob gives USDC → offdelta increases (positive)
  // Bob receives ETH → offdelta decreases (negative)
  assert((bobEth?.offdelta ?? 0n) < 0n, `Bob should have received ETH (Right receives = negative), got ${bobEth?.offdelta ?? 0n}`);
  assert((bobUsdc?.offdelta ?? 0n) > 0n, `Bob should have given USDC (Right pays = positive), got ${bobUsdc?.offdelta ?? 0n}`);

  // Alice's offer should be partially filled (started with 2 ETH, Bob took ~1)
  // Note: exact amount may vary slightly due to uint16 fillRatio granularity
  const aliceOfferRemaining = aliceAccount?.swapOffers?.get('alice-sell-001');
  if (aliceOfferRemaining) {
    const remainingEth = Number(aliceOfferRemaining.giveAmount) / 1e18;
    assert(remainingEth >= 0.99 && remainingEth <= 1.01,
      `Alice should have ~1 ETH remaining, got ${remainingEth}`);
  }

  console.log('  ✅ Phase 2 assertions passed');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('              PHASE 2: ORDERBOOK TEST COMPLETE                  ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  return env;
}

// ============================================================================
// PHASE 3: Multi-Party Trading - Carol & Dave eating larger orders
// ============================================================================

export async function multiPartyTrading(env: Env): Promise<Env> {
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 3: MULTI-PARTY TRADING (Carol & Dave)           ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const hub = { id: '0x' + '2'.padStart(64, '0'), signer: 's2' };

  // Add Carol and Dave
  console.log('📦 Adding Carol and Dave...');
  const carol = { id: '0x' + '4'.padStart(64, '0'), signer: 's4' };
  const dave = { id: '0x' + '5'.padStart(64, '0'), signer: 's5' };

  for (const entity of [carol, dave]) {
    await applyRuntimeInput(env, { runtimeTxs: [{
      type: 'importReplica' as const,
      entityId: entity.id,
      signerId: entity.signer,
      data: {
        isProposer: true,
        position: { x: 0, y: 0, z: 0 },
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [entity.signer],
          shares: { [entity.signer]: 1n },
        },
      },
    }], entityInputs: [] });
    await process(env);

    if (entity === carol) {
      assertSnapshotCounts(env, 1, 4, 'After Carol import');
    }
  }
  console.log('  ✅ Carol and Dave created\n');

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
        { type: 'extendCredit', data: { counterpartyEntityId: entity.id, tokenId: ETH_TOKEN_ID, amount: eth(1_000_000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: entity.id, tokenId: USDC_TOKEN_ID, amount: usdc(1_000_000) } },
      ]},
      { entityId: entity.id, signerId: entity.signer, entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH_TOKEN_ID, amount: eth(1_000_000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: usdc(1_000_000) } },
      ]},
    ]);
    await converge(env);
  }
  console.log('  ✅ Credit extended\n');

  // ============================================================================
  // Carol places large SELL order: 10 ETH @ 2900 USDC
  // ============================================================================
  console.log('📊 Carol places LARGE SELL: 10 ETH @ 2900 USDC...');
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'carol-sell-10',
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(10),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(29000), // 10 ETH @ 2900 each
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
  // Dave BUYS 3 ETH @ 3000 - should partially fill Carol's order
  // ============================================================================
  console.log('\n📊 Dave BUYs 3 ETH @ 3000 (eats into Carol\'s sell)...');
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'dave-buy-3',
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdc(9000), // 3 ETH @ 3000 each
        wantTokenId: ETH_TOKEN_ID,
        wantAmount: eth(3),
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
  // Carol places another SELL: 5 ETH @ 3100 (above current best ask)
  // ============================================================================
  console.log('\n📊 Carol places another SELL: 5 ETH @ 3100...');
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'carol-sell-5',
        giveTokenId: ETH_TOKEN_ID,
        giveAmount: eth(5),
        wantTokenId: USDC_TOKEN_ID,
        wantAmount: usdc(15500), // 5 ETH @ 3100 each
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
  // Dave sweeps the book: BUY 15 ETH @ 3200 (eats both levels)
  // ============================================================================
  console.log('\n📊 Dave SWEEPS BOOK: BUY 15 ETH @ 3200 (eats all asks)...');
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: hub.id,
        offerId: 'dave-sweep',
        giveTokenId: USDC_TOKEN_ID,
        giveAmount: usdc(48000), // 15 ETH @ 3200 each (overpaying to sweep)
        wantTokenId: ETH_TOKEN_ID,
        wantAmount: eth(15),
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

  // Carol sold ETH (total 15 ETH across two orders: 10 @ 2900, 5 @ 3100)
  // Carol is Right relative to Hub (Hub = 0x0002..., Carol = 0x0004...)
  // CANONICAL: Right pays → offdelta INCREASES, Right receives → offdelta DECREASES
  // Carol gives ETH → offdelta increases (positive)
  assert(carolEth > 0n, `Carol should have given ETH (Right pays = positive), got ${carolEth}`);

  // Carol receives USDC → offdelta decreases (negative)
  assert(carolUsdc < 0n, `Carol should have received USDC (Right receives = negative), got ${carolUsdc}`);

  // Dave bought ETH (total 18 ETH: 3 @ 3000 + 15 @ 3200 sweep, but only 15 available)
  // Dave is Right relative to Hub (Hub = 0x0002..., Dave = 0x0005...)
  // Dave gives USDC → offdelta increases (positive)
  assert(daveUsdc > 0n, `Dave should have given USDC (Right pays = positive), got ${daveUsdc}`);

  // Dave receives ETH → offdelta decreases (negative)
  assert(daveEth < 0n, `Dave should have received ETH (Right receives = negative), got ${daveEth}`);

  // Verify Carol sold at least 15 ETH (her total orders)
  // Note: Dave may receive more due to Alice's remaining order from Phase 2
  assert(carolEth >= eth(15),
    `Carol should have sold at least 15 ETH, got ${Number(carolEth) / 1e18}`);

  // Orderbook ask side should be empty after Dave's sweep
  // (Dave's remaining unfilled bid may still be there)
  // Use getBestAsk which returns null when no asks exist
  const hasAsks = bookFinal ? getBestAsk(bookFinal) !== null : false;
  assert(!hasAsks, 'Orderbook asks should be empty after sweep');

  console.log('  ✅ Phase 3 assertions passed');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('           PHASE 3: MULTI-PARTY TRADING COMPLETE               ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  return env;
}

// ===== CLI ENTRY POINT =====
if (import.meta.main) {
  console.log('🚀 Running SWAP scenario from CLI...\n');

  const runtime = await import('../runtime');
  const env = runtime.createEmptyEnv();
  env.scenarioMode = true; // Deterministic time control

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
    // Give the event loop a tick to flush logs and settle before exit.
    await new Promise(resolve => setTimeout(resolve, 10));
    process.exit(0);
  } catch (error) {
    console.error('\n❌ SWAP scenario FAILED:', error);
    await new Promise(resolve => setTimeout(resolve, 10));
    process.exit(1);
  }
}
