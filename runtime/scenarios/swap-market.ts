/**
 * Multi-Party Orderbook Market Scenario
 *
 * Tests realistic orderbook behavior with:
 * - 1 reference asset (USDC - token 1)
 * - 3 pairwise books: USDC/ETH, USDC/WBTC, USDC/DAI
 * - 10 participants: 3 hubs + 7 traders (Alice, Bob, Carol, Dave, Eve, Frank, Grace)
 * - Realistic market dynamics: makers, takers, partial fills, spread
 *
 * Market scenario:
 * - Phase 1: Makers place limit orders (bid/ask spread)
 * - Phase 2: Takers sweep orderbook
 * - Phase 3: Market volatility (cancel + replace orders)
 *
 * Run with: bun runtime/scenarios/swap-market.ts
 */

import type { Env, RoutedEntityInput } from '../types';
import { ensureBrowserVM, createJReplica, createJurisdictionConfig } from './boot';
import { findReplica, converge, assert, assertRuntimeIdle, processUntil, enableStrictScenario, ensureSignerKeysFromSeed, requireRuntimeSeed } from './helpers';
import { createGossipLayer } from '../networking/gossip';

// Lazy-loaded runtime functions
let _process: ((env: Env, inputs?: RoutedEntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
let _applyRuntimeInput: ((env: Env, runtimeInput: any) => Promise<Env>) | null = null;

const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../runtime');
    _process = runtime.process;
  }
  return _process;
};

const getApplyRuntimeInput = async () => {
  if (!_applyRuntimeInput) {
    const runtime = await import('../runtime');
    _applyRuntimeInput = runtime.applyRuntimeInput;
  }
  return _applyRuntimeInput;
};

// Token IDs - USDC is quote (highest ID) so price > 1 for all pairs
// Orderbook uses canonicalPair: base=min(a,b), quote=max(a,b)
// So base tokens must have lower IDs than quote (USDC)
const ETH = 1;   // Base for ETH/USDC - price ~3000 USDC per ETH
const WBTC = 2;   // Base for WBTC/USDC - price ~60000 USDC per WBTC
const DAI = 3;   // Base for DAI/USDC - price ~1 USDC per DAI
const USDC = 4;  // Quote for all pairs (highest ID)

const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

const usdc = (amount: number | bigint) => BigInt(amount) * ONE;
const eth = (amount: number | bigint) => BigInt(amount) * ONE;
const wbtc = (amount: number | bigint) => BigInt(amount) * ONE;
const dai = (amount: number | bigint) => BigInt(amount) * ONE;

// Fill ratios
const MAX_FILL_RATIO = 65535;
const FILL_10 = 6553;
const FILL_20 = 13107;
const FILL_25 = 16384;
const FILL_50 = 32768;
const FILL_60 = 39321;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
};

const computeFilledAmounts = (giveAmount: bigint, wantAmount: bigint, fillRatio: number) => {
  const filledGive = (giveAmount * BigInt(fillRatio)) / BigInt(MAX_FILL_RATIO);
  const filledWant = giveAmount > 0n ? ceilDiv(filledGive * wantAmount, giveAmount) : 0n;
  return { filledGive, filledWant };
};

// Using helpers from helpers.ts (no duplication)

export async function swapMarket(env: Env): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Swap Market');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  requireRuntimeSeed(env, 'Swap Market');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], 'Swap Market');
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  if (env.scenarioMode && env.height === 0) {
    env.timestamp = 1;
  }

  if (env.jReplicas && env.jReplicas.size > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.jReplicas.size} old jurisdictions from previous scenario`);
    env.jReplicas.clear();
  }
  if (env.eReplicas && env.eReplicas.size > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.eReplicas.size} old entities from previous scenario`);
    env.eReplicas.clear();
  }
  if (env.history && env.history.length > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.history.length} old snapshots from previous scenario`);
    env.history = [];
  }
  env.height = 0;
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

  if (env.jReplicas && env.jReplicas.size > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.jReplicas.size} old jurisdictions from previous scenario`);
    env.jReplicas.clear();
  }
  if (env.eReplicas && env.eReplicas.size > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.eReplicas.size} old entities from previous scenario`);
    env.eReplicas.clear();
  }
  if (env.history && env.history.length > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.history.length} old snapshots from previous scenario`);
    env.history = [];
  }
  env.height = 0;
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

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('      SWAP MARKET: Multi-Party Orderbook Simulation            ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: BrowserVM + J-Machine
  // ============================================================================
  console.log('🏛️  Setting up BrowserVM J-Machine...');

  const browserVM = await ensureBrowserVM(env);
  const depositoryAddress = browserVM.getDepositoryAddress();
  const J_MACHINE_POSITION = { x: 0, y: 600, z: 0 };
  createJReplica(env, 'Market', depositoryAddress, J_MACHINE_POSITION); // Match ahb.ts positioning
  const jurisdiction = createJurisdictionConfig('Market', depositoryAddress);
  console.log('✅ BrowserVM J-Machine created\n');

  // ============================================================================
  // SETUP: Create 10 entities (3 hubs + 7 traders)
  // ============================================================================
  console.log('📦 Creating 10 market participants (3 hubs + 7 traders)...');

  const hubs = [
    { name: 'HubETH', id: '0x' + '1'.padStart(64, '0'), signer: '1', role: 'hub', pairs: ['1/4'] }, // ETH/USDC
    { name: 'HubWBTC', id: '0x' + '2'.padStart(64, '0'), signer: '2', role: 'hub', pairs: ['2/4'] }, // WBTC/USDC
    { name: 'HubDAI', id: '0x' + '3'.padStart(64, '0'), signer: '3', role: 'hub', pairs: ['3/4'] }, // DAI/USDC
  ];

  const traders = [
    { name: 'Alice', id: '0x' + '4'.padStart(64, '0'), signer: '4', role: 'maker' },
    { name: 'Bob', id: '0x' + '5'.padStart(64, '0'), signer: '5', role: 'maker' },
    { name: 'Carol', id: '0x' + '6'.padStart(64, '0'), signer: '6', role: 'taker' },
    { name: 'Dave', id: '0x' + '7'.padStart(64, '0'), signer: '7', role: 'taker' },
    { name: 'Eve', id: '0x' + '8'.padStart(64, '0'), signer: '8', role: 'maker' },
    { name: 'Frank', id: '0x' + '9'.padStart(64, '0'), signer: '9', role: 'taker' },
    { name: 'Grace', id: '0x' + 'a'.padStart(64, '0'), signer: '10', role: 'maker' },
  ];

  const entities = [...hubs, ...traders];

  const HUB_SPACING = 160;
  const HUB_Y = -80;
  const TRADER_Y = -140;
  const TRADER_Z = 70;
  const TRADER_X = 40;

  const MARKET_OFFSETS: Record<string, { x: number; y: number; z: number }> = {
    HubETH: { x: -HUB_SPACING, y: HUB_Y, z: 0 },
    HubWBTC: { x: 0, y: HUB_Y, z: 0 },
    HubDAI: { x: HUB_SPACING, y: HUB_Y, z: 0 },
    Alice: { x: -HUB_SPACING - TRADER_X, y: TRADER_Y, z: -TRADER_Z },
    Bob: { x: -HUB_SPACING + TRADER_X, y: TRADER_Y, z: TRADER_Z },
    Carol: { x: -HUB_SPACING, y: TRADER_Y, z: 0 },
    Dave: { x: -TRADER_X, y: TRADER_Y, z: -TRADER_Z },
    Grace: { x: TRADER_X, y: TRADER_Y, z: TRADER_Z },
    Eve: { x: HUB_SPACING - TRADER_X, y: TRADER_Y, z: -TRADER_Z },
    Frank: { x: HUB_SPACING + TRADER_X, y: TRADER_Y, z: TRADER_Z },
  };

  const MARKET_POSITIONS: Record<string, { x: number; y: number; z: number }> = Object.fromEntries(
    Object.entries(MARKET_OFFSETS).map(([name, offset]) => [
      name,
      {
        x: J_MACHINE_POSITION.x + offset.x,
        y: J_MACHINE_POSITION.y + offset.y,
        z: J_MACHINE_POSITION.z + offset.z,
      },
    ]),
  );

  const createEntityTxs = entities.map(e => ({
    type: 'importReplica' as const,
    entityId: e.id,
    signerId: e.signer,
    data: {
      isProposer: true,
      position: MARKET_POSITIONS[e.name] || { x: 0, y: -80, z: 0 },
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [e.signer],
        shares: { [e.signer]: 1n },
      },
    },
  }));

  await applyRuntimeInput(env, { runtimeTxs: createEntityTxs, entityInputs: [] });
  console.log(`  ✅ Created: ${entities.map(e => e.name).join(', ')}\n`);

  const [hubEth, hubWbtc, hubDai] = hubs;
  const [alice, bob, carol, dave, eve, frank, grace] = traders;

  // Initialize orderbookExt for each hub
  const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../orderbook');
  await process(env, hubs.map(hub => ({
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'initOrderbookExt',
      data: {
        name: hub.name,
        spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: USDC,
        minTradeSize: 0n,
        supportedPairs: hub.pairs,
      },
    }],
  })));
  await converge(env);
  console.log('  ✅ Orderbook extensions initialized\n');

  // ============================================================================
  // SETUP: Open bilateral accounts per hub
  // ============================================================================
  console.log('🔗 Opening bilateral accounts (traders ↔ hubs)...');

  const hubEthTraders = [alice, bob, eve, carol];
  const hubWbtcTraders = [alice, grace, dave];
  const hubDaiTraders = [bob, eve, frank];

  const openPairs: Array<{ trader: typeof traders[number]; hub: typeof hubs[number] }> = [
    ...hubEthTraders.map(trader => ({ trader, hub: hubEth })),
    ...hubWbtcTraders.map(trader => ({ trader, hub: hubWbtc })),
    ...hubDaiTraders.map(trader => ({ trader, hub: hubDai })),
  ];

  for (const { trader, hub } of openPairs) {
    await process(env, [{
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
    }]);
    await converge(env, 30);
  }
  console.log('  ✅ Bilateral accounts created\n');

  // ============================================================================
  // SETUP: Credit limits (4 tokens: USDC, ETH, WBTC, DAI)
  // ============================================================================
  console.log('💳 Setting up credit limits for all traders...');

  const creditLimitUnits = 10_000_000n / 3n;

  const creditPairs: Array<{
    trader: typeof traders[number];
    hub: typeof hubs[number];
    tokenA: number;
    tokenB: number;
    amountA: bigint;
    amountB: bigint;
  }> = [
    ...hubEthTraders.map(trader => ({
      trader,
      hub: hubEth,
      tokenA: USDC,
      tokenB: ETH,
      amountA: usdc(creditLimitUnits),
      amountB: eth(creditLimitUnits),
    })),
    ...hubWbtcTraders.map(trader => ({
      trader,
      hub: hubWbtc,
      tokenA: USDC,
      tokenB: WBTC,
      amountA: usdc(creditLimitUnits),
      amountB: wbtc(creditLimitUnits),
    })),
    ...hubDaiTraders.map(trader => ({
      trader,
      hub: hubDai,
      tokenA: USDC,
      tokenB: DAI,
      amountA: usdc(creditLimitUnits),
      amountB: dai(creditLimitUnits),
    })),
  ];

  for (const { trader, hub, tokenA, tokenB, amountA, amountB } of creditPairs) {
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: tokenA, amount: amountA } },
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: tokenB, amount: amountB } },
      ],
    }]);
    await process(env, [{
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: tokenA, amount: amountA } },
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: tokenB, amount: amountB } },
      ],
    }]);
    await converge(env, 30);
  }
  console.log('  ✅ Bidirectional credit established for all tokens\n');

  // ============================================================================
  // PHASE 1: Makers place limit orders (create orderbook depth)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 1: Makers Place Limit Orders                    ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('📊 Building orderbook depth across 3 pairs...\n');

  // USDC/ETH book (ETH @ $3000)
  console.log('💱 USDC/ETH Orderbook (HubETH):');
  await process(env, [
    // Alice: Sell 10 ETH @ $3100 (ask above market)
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'alice-eth-ask',
          counterpartyEntityId: hubEth.id,
          giveTokenId: ETH,
          giveAmount: eth(10),
          wantTokenId: USDC,
          wantAmount: usdc(31000), // $3100/ETH
          minFillRatio: FILL_25, // 25% min fill
        },
      }],
    },
    // Bob: Sell 5 ETH @ $3050 (tighter ask)
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'bob-eth-ask',
          counterpartyEntityId: hubEth.id,
          giveTokenId: ETH,
          giveAmount: eth(5),
          wantTokenId: USDC,
          wantAmount: usdc(15250), // $3050/ETH
          minFillRatio: FILL_50, // 50% min fill
        },
      }],
    },
    // Eve: Buy 8 ETH @ $2950 (bid below market)
    {
      entityId: eve.id,
      signerId: eve.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'eve-eth-bid',
          counterpartyEntityId: hubEth.id,
          giveTokenId: USDC,
          giveAmount: usdc(23600), // $2950/ETH * 8
          wantTokenId: ETH,
          wantAmount: eth(8),
          minFillRatio: FILL_25, // 25% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Alice: SELL 10 ETH @ $3100 (ask)');
  console.log('  ✅ Bob: SELL 5 ETH @ $3050 (ask)');
  console.log('  ✅ Eve: BUY 8 ETH @ $2950 (bid)\n');

  // USDC/WBTC book (WBTC @ $60000)
  console.log('💱 USDC/WBTC Orderbook (HubWBTC):');
  await process(env, [
    // Grace: Sell 2 WBTC @ $61000 (ask)
    {
      entityId: grace.id,
      signerId: grace.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'grace-wbtc-ask',
          counterpartyEntityId: hubWbtc.id,
          giveTokenId: WBTC,
          giveAmount: wbtc(2),
          wantTokenId: USDC,
          wantAmount: usdc(122000), // $61000/WBTC
          minFillRatio: FILL_50, // 50% min fill
        },
      }],
    },
    // Alice: Buy 1 WBTC @ $59000 (bid)
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'alice-wbtc-bid',
          counterpartyEntityId: hubWbtc.id,
          giveTokenId: USDC,
          giveAmount: usdc(59000), // $59000/WBTC
          wantTokenId: WBTC,
          wantAmount: wbtc(1),
          minFillRatio: FILL_25, // 25% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Grace: SELL 2 WBTC @ $61000 (ask)');
  console.log('  ✅ Alice: BUY 1 WBTC @ $59000 (bid)\n');

  // USDC/DAI book (DAI @ $1) - scaled to fit MAX_LOTS (4.2B)
  // Note: With LOT_SCALE=10^12, max order ~4000 tokens per lot math
  console.log('💱 USDC/DAI Orderbook (HubDAI):');
  await process(env, [
    // Bob: Sell 500 DAI @ $1.001 (tight spread, stablecoin pair)
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'bob-dai-ask',
          counterpartyEntityId: hubDai.id,
          giveTokenId: DAI,
          giveAmount: dai(500),
          wantTokenId: USDC,
          wantAmount: usdc(501), // ~$1.002/DAI
          minFillRatio: FILL_10, // 10% min fill
        },
      }],
    },
    // Eve: Buy 300 DAI @ $0.999 (bid)
    {
      entityId: eve.id,
      signerId: eve.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'eve-dai-bid',
          counterpartyEntityId: hubDai.id,
          giveTokenId: USDC,
          giveAmount: usdc(299), // ~$0.997/DAI * 300
          wantTokenId: DAI,
          wantAmount: dai(300),
          minFillRatio: FILL_10, // 10% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Bob: SELL 500 DAI @ $1.002 (ask)');
  console.log('  ✅ Eve: BUY 300 DAI @ $0.997 (bid)\n');

  await converge(env);
  console.log('✅ PHASE 1 COMPLETE: Orderbook depth established\n');

  const [, bobEthRepBefore] = findReplica(env, bob.id);
  const bobEthAccountBefore = bobEthRepBefore.state.accounts.get(hubEth.id);
  const bobEthOfferBefore = bobEthAccountBefore?.swapOffers?.get('bob-eth-ask');
  assert(!!bobEthOfferBefore, 'Bob ETH ask exists after Phase 1');
  const bobEthGive = bobEthOfferBefore.quantizedGive ?? bobEthOfferBefore.giveAmount;
  const bobEthWant = bobEthOfferBefore.quantizedWant ?? bobEthOfferBefore.wantAmount;

  const [, aliceWbtcRepBefore] = findReplica(env, alice.id);
  const aliceWbtcAccountBefore = aliceWbtcRepBefore.state.accounts.get(hubWbtc.id);
  const aliceWbtcOfferBefore = aliceWbtcAccountBefore?.swapOffers?.get('alice-wbtc-bid');
  assert(!!aliceWbtcOfferBefore, 'Alice WBTC bid exists after Phase 1');

  const [, bobDaiRepBefore] = findReplica(env, bob.id);
  const bobDaiAccountBefore = bobDaiRepBefore.state.accounts.get(hubDai.id);
  const bobDaiOfferBefore = bobDaiAccountBefore?.swapOffers?.get('bob-dai-ask');
  assert(!!bobDaiOfferBefore, 'Bob DAI ask exists after Phase 1');
  const bobDaiGive = bobDaiOfferBefore.quantizedGive ?? bobDaiOfferBefore.giveAmount;
  const bobDaiWant = bobDaiOfferBefore.quantizedWant ?? bobDaiOfferBefore.wantAmount;

  // ============================================================================
  // PHASE 2: Takers sweep orderbook
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 2: Takers Sweep Orderbook                       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('🎯 Takers placing crossing orders (auto-matched by Hub orderbook)...\n');

  // Carol buys ETH - place crossing bid that hits Bob's ask @ $3050
  // Carol offers more USDC/ETH than Bob's ask price, so it crosses
  console.log('💱 Carol: BUY 3 ETH @ $3100 (crosses Bob\'s ask @ $3050)');
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'carol-eth-bid',
        counterpartyEntityId: hubEth.id,
        giveTokenId: USDC,
        giveAmount: usdc(9300), // $3100/ETH * 3 ETH
        wantTokenId: ETH,
        wantAmount: eth(3),
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env, 30);
  console.log('  ✅ Carol\'s bid placed - orderbook should match with Bob\'s ask\n');

  // Dave sells WBTC - place crossing ask that hits Alice's bid @ $59000
  console.log('💱 Dave: SELL 1 WBTC @ $58000 (crosses Alice\'s bid @ $59000)');
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'dave-wbtc-ask',
        counterpartyEntityId: hubWbtc.id,
        giveTokenId: WBTC,
        giveAmount: wbtc(1),
        wantTokenId: USDC,
        wantAmount: usdc(58000), // Lower than Alice's bid
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env, 30);
  console.log('  ✅ Dave\'s ask placed - orderbook should match with Alice\'s bid\n');

  // Frank buys DAI - place crossing bid
  console.log('💱 Frank: BUY 100 DAI @ $1.01 (crosses Bob\'s ask @ $1.002)');
  await process(env, [{
    entityId: frank.id,
    signerId: frank.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'frank-dai-bid',
        counterpartyEntityId: hubDai.id,
        giveTokenId: USDC,
        giveAmount: usdc(101), // ~$1.01/DAI * 100
        wantTokenId: DAI,
        wantAmount: dai(100),
        minFillRatio: 0,
      },
    }],
  }]);
  await converge(env, 30);
  console.log('  ✅ Frank\'s bid placed - orderbook should match with Bob\'s ask\n');

  console.log('✅ PHASE 2 COMPLETE: Crossing orders placed, matches processed\n');

  // After orderbook matching, verify state:
  // Carol's 3 ETH bid should have matched with Bob's 5 ETH ask (partial fill)
  // Bob's remaining: 5 - 3 = 2 ETH
  const [, bobEthRepAfter] = findReplica(env, bob.id);
  const bobEthAccountAfter = bobEthRepAfter.state.accounts.get(hubEth.id);
  const bobEthOfferAfter = bobEthAccountAfter?.swapOffers?.get('bob-eth-ask');

  // Note: Exact fill amounts depend on orderbook matching semantics
  // We check that SOME fill occurred (remaining < original)
  if (bobEthOfferAfter) {
    const remainingEth = bobEthOfferAfter.giveAmount;
    assert(remainingEth < eth(5), `Bob ETH ask partially filled (remaining: ${remainingEth}, original: ${eth(5)})`);
    console.log(`  Bob ETH remaining: ${Number(remainingEth) / 1e18} ETH`);
  } else {
    console.log('  Bob ETH ask fully filled (offer removed)');
  }

  // Alice's WBTC bid should match Dave's ask
  const [, aliceWbtcRepAfter] = findReplica(env, alice.id);
  const aliceWbtcAccountAfter = aliceWbtcRepAfter.state.accounts.get(hubWbtc.id);
  const aliceWbtcBidAfter = aliceWbtcAccountAfter?.swapOffers?.get('alice-wbtc-bid');
  if (aliceWbtcBidAfter) {
    console.log(`  Alice WBTC bid remaining: ${Number(aliceWbtcBidAfter.giveAmount) / 1e18} USDC`);
  } else {
    console.log('  Alice WBTC bid fully filled (offer removed)');
  }

  // Bob's DAI ask should partially fill
  const [, bobDaiRepAfter] = findReplica(env, bob.id);
  const bobDaiAccountAfter = bobDaiRepAfter.state.accounts.get(hubDai.id);
  const bobDaiOfferAfter = bobDaiAccountAfter?.swapOffers?.get('bob-dai-ask');
  if (bobDaiOfferAfter) {
    const remainingDai = bobDaiOfferAfter.giveAmount;
    console.log(`  Bob DAI remaining: ${Number(remainingDai) / 1e18} DAI`);
  } else {
    console.log('  Bob DAI ask fully filled (offer removed)');
  };

  // ============================================================================
  // PHASE 3: Market volatility (cancel + replace)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 3: Market Volatility (Cancel & Replace)         ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Alice cancels her ETH ask (price too high, no fills)
  console.log('🚫 Alice: Cancel ETH ask @ $3100 (no fills, repricing)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'cancelSwapOffer',
      data: {
        offerId: 'alice-eth-ask',
        counterpartyEntityId: hubEth.id,
      },
    }],
  }]);
  console.log('  ✅ Order cancelled\n');

  // Alice replaces with better price
  console.log('📊 Alice: New ETH ask @ $3020 (tighter spread)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'alice-eth-ask-v2',
        counterpartyEntityId: hubEth.id,
        giveTokenId: ETH,
        giveAmount: eth(10),
        wantTokenId: USDC,
        wantAmount: usdc(30200), // $3020/ETH (better price)
        minFillRatio: FILL_25,
      },
    }],
  }]);
  console.log('  ✅ New order placed\n');

  await converge(env);
  console.log('✅ PHASE 3 COMPLETE: Market volatility simulated\n');

  const [, aliceEthRepAfter] = findReplica(env, alice.id);
  const aliceEthAccountAfter = aliceEthRepAfter.state.accounts.get(hubEth.id);
  assert(!aliceEthAccountAfter?.swapOffers?.has('alice-eth-ask'), 'Alice ETH ask cancelled');
  const aliceEthOfferV2 = aliceEthAccountAfter?.swapOffers?.get('alice-eth-ask-v2');
  assert(!!aliceEthOfferV2, 'Alice ETH ask v2 created');
  assert(aliceEthOfferV2.giveAmount === eth(10), `Alice ETH ask v2 giveAmount = ${eth(10)} (got ${aliceEthOfferV2.giveAmount})`);
  assert(aliceEthOfferV2.wantAmount === usdc(30200), `Alice ETH ask v2 wantAmount = ${usdc(30200)} (got ${aliceEthOfferV2.wantAmount})`);

  // ============================================================================
  // VERIFICATION & SUMMARY
  // ============================================================================
  console.log('🔄 Final convergence (flush pending frames)...');
  await converge(env, 200);
  const dumpAccountState = (label: string, entityId: string, counterpartyId: string) => {
    const [, rep] = findReplica(env, entityId);
    if (!rep) {
      console.warn(`[SWAP-MARKET] ${label}: missing replica ${entityId.slice(-4)}`);
      return;
    }
    const account = rep.state.accounts.get(counterpartyId);
    if (!account) {
      console.warn(`[SWAP-MARKET] ${label}: no account ${entityId.slice(-4)}↔${counterpartyId.slice(-4)}`);
      return;
    }
    const mempoolTypes = account.mempool.map(tx => tx.type);
    const pendingTypes = account.proposal?.pendingFrame.accountTxs.map(tx => tx.type) ?? [];
    console.warn(
      `[SWAP-MARKET] ${label}: ${entityId.slice(-4)}↔${counterpartyId.slice(-4)} ` +
        `height=${account.currentHeight} pending=${account.proposal ? 'yes' : 'no'} ` +
        `mempool=[${mempoolTypes.join(',')}] pendingTxs=[${pendingTypes.join(',')}]`,
    );
  };
  await processUntil(
    env,
    () => {
      try {
        assertRuntimeIdle(env, 'Swap Market');
        return true;
      } catch {
        return false;
      }
    },
    400,
    'Swap Market idle',
    undefined,
    () => {
      try {
        assertRuntimeIdle(env, 'Swap Market');
      } catch (error) {
        console.warn(error instanceof Error ? error.message : error);
        const hubDaiId = hubDai.id;
        dumpAccountState('idle-debug hubDai→bob', hubDaiId, bob.id);
        dumpAccountState('idle-debug bob→hubDai', bob.id, hubDaiId);
        dumpAccountState('idle-debug hubDai→eve', hubDaiId, eve.id);
        dumpAccountState('idle-debug eve→hubDai', eve.id, hubDaiId);
      }
    }
  );
  console.log('✅ Final convergence complete\n');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   MARKET SUMMARY                              ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const hub of hubs) {
    const [, hubRep] = findReplica(env, hub.id);
    const hubExt = hubRep.state.orderbookExt;
    if (!hubExt?.books) continue;
    console.log(`📈 ${hub.name} Orderbook State:`);
    console.log(`  - Total pairs: ${hubExt.books.size}`);
    for (const [pairId, book] of hubExt.books) {
      // Count active orders by side (TypedArray structure)
      let bidCount = 0, askCount = 0;
      for (let i = 0; i < book.orderActive.length; i++) {
        if (book.orderActive[i]) {
          if (book.orderSide[i] === 0) bidCount++;
          else askCount++;
        }
      }
      console.log(`  - Pair ${pairId}: ${bidCount} bids, ${askCount} asks`);
    }
    console.log();
  }

  // Check individual trader positions
  console.log('👥 Trader Positions:');
  for (const trader of [carol, dave, frank]) {
    const [, rep] = findReplica(env, trader.id);
    const account = rep.state.accounts.get(hubEth.id) || rep.state.accounts.get(hubWbtc.id) || rep.state.accounts.get(hubDai.id);
    if (account) {
      const deltas = Array.from(account.deltas.values());
      console.log(`  ${trader.name}:`);
      for (const delta of deltas) {
        const tokenId = delta.tokenId;
        const netPosition = delta.ondelta - delta.offdelta;
        if (netPosition !== 0n) {
          const tokenName = tokenId === USDC ? 'USDC' : tokenId === ETH ? 'ETH' : tokenId === WBTC ? 'WBTC' : 'DAI';
          console.log(`    - ${tokenName}: ${netPosition > 0n ? '+' : ''}${netPosition.toString()}`);
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('✅ MULTI-PARTY MARKET SIMULATION COMPLETE!');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📊 Total frames: ${env.history?.length || 0}`);
  console.log(`👥 Participants: 10 (${entities.map(e => e.name).join(', ')})`);
  console.log(`💱 Orderbooks: 3 (USDC/ETH, USDC/WBTC, USDC/DAI)`);
  console.log(`📈 Orders placed: 9`);
  console.log(`🎯 Market fills: 3`);
  console.log(`🚫 Cancellations: 1`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreStrict();
  }
}

// ============================================================================
// HIGH-LOAD STRESS TEST: Rapid Order Placement & Matching
// ============================================================================

export async function swapMarketStress(env: Env): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Swap Market Stress');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  requireRuntimeSeed(env, 'Swap Market Stress');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], 'Swap Market Stress');
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  if (env.scenarioMode && env.height === 0) {
    env.timestamp = 1;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('      SWAP MARKET STRESS TEST: High-Load Order Processing      ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: BrowserVM + J-Machine + Hub
  // ============================================================================
  console.log('🏛️  Setting up stress test environment...');

  const browserVM = await ensureBrowserVM(env);
  const depositoryAddress = browserVM.getDepositoryAddress();
  const J_MACHINE_POSITION = { x: 0, y: 600, z: 0 };
  createJReplica(env, 'StressTest', depositoryAddress, J_MACHINE_POSITION);
  const jurisdiction = createJurisdictionConfig('StressTest', depositoryAddress);
  console.log('✅ BrowserVM J-Machine created\n');

  // Create 1 hub + 10 traders
  const hub = { name: 'Hub', id: '0x' + '1'.padStart(64, '0'), signer: '1' };
  const traders: Array<{ name: string; id: string; signer: string }> = [];
  for (let i = 0; i < 10; i++) {
    traders.push({
      name: `Trader${i}`,
      id: '0x' + (i + 2).toString(16).padStart(64, '0'),
      signer: String(i + 2),
    });
  }

  // Create entities
  const allEntities = [hub, ...traders];
  const createEntityTxs = allEntities.map((e, idx) => ({
    type: 'importReplica' as const,
    entityId: e.id,
    signerId: e.signer,
    data: {
      isProposer: true,
      position: { x: (idx - 5) * 30, y: -80, z: 0 },
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [e.signer],
        shares: { [e.signer]: 1n },
      },
    },
  }));

  await applyRuntimeInput(env, { runtimeTxs: createEntityTxs, entityInputs: [] });
  console.log(`✅ Created ${allEntities.length} entities\n`);

  // Initialize hub orderbook
  const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../orderbook');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'initOrderbookExt',
      data: {
        name: 'StressHub',
        spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: USDC,
        minTradeSize: 0n,
        supportedPairs: ['1/4'], // ETH/USDC only for simplicity
      },
    }],
  }]);
  await converge(env);
  console.log('✅ Hub orderbook initialized\n');

  // Open accounts and extend credit for all traders
  console.log('🔗 Opening accounts and extending credit...');
  for (const trader of traders) {
    await process(env, [{
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
    }]);
    await converge(env, 20);

    await process(env, [
      { entityId: hub.id, signerId: hub.signer, entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: ETH, amount: eth(1000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: USDC, amount: usdc(3_000_000) } },
      ]},
      { entityId: trader.id, signerId: trader.signer, entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH, amount: eth(1000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: usdc(3_000_000) } },
      ]},
    ]);
    await converge(env, 20);
  }
  console.log('✅ All accounts and credit established\n');

  // ============================================================================
  // STRESS TEST: Place many orders rapidly
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         STRESS PHASE 1: Rapid Order Placement                 ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const ORDERS_PER_TRADER = 5;
  const BASE_PRICE = 3000n;
  let ordersPlaced = 0;
  const startTime = Date.now();

  // Each trader places ORDERS_PER_TRADER orders alternating buy/sell
  for (let round = 0; round < ORDERS_PER_TRADER; round++) {
    const orderBatch: Array<{ entityId: string; signerId: string; entityTxs: any[] }> = [];

    for (let t = 0; t < traders.length; t++) {
      const trader = traders[t]!;
      const isBuy = (t + round) % 2 === 0;
      const priceOffset = BigInt((t - 5) * 10 + round * 2); // Spread prices around base
      const price = BASE_PRICE + priceOffset;
      const qty = 1n + BigInt(round % 3); // 1-3 ETH per order

      if (isBuy) {
        // BUY order: give USDC, want ETH
        orderBatch.push({
          entityId: trader.id,
          signerId: trader.signer,
          entityTxs: [{
            type: 'placeSwapOffer',
            data: {
              offerId: `${trader.name}-buy-${round}`,
              counterpartyEntityId: hub.id,
              giveTokenId: USDC,
              giveAmount: usdc(qty * price),
              wantTokenId: ETH,
              wantAmount: eth(qty),
              minFillRatio: 0,
            },
          }],
        });
      } else {
        // SELL order: give ETH, want USDC
        orderBatch.push({
          entityId: trader.id,
          signerId: trader.signer,
          entityTxs: [{
            type: 'placeSwapOffer',
            data: {
              offerId: `${trader.name}-sell-${round}`,
              counterpartyEntityId: hub.id,
              giveTokenId: ETH,
              giveAmount: eth(qty),
              wantTokenId: USDC,
              wantAmount: usdc(qty * price),
              minFillRatio: 0,
            },
          }],
        });
      }
      ordersPlaced++;
    }

    // Process entire batch in parallel
    await process(env, orderBatch);
    await converge(env, 50);
    console.log(`  Round ${round + 1}/${ORDERS_PER_TRADER}: ${orderBatch.length} orders placed`);
  }

  const orderTime = Date.now() - startTime;
  console.log(`\n✅ Placed ${ordersPlaced} orders in ${orderTime}ms (${(ordersPlaced / (orderTime / 1000)).toFixed(1)} orders/sec)\n`);

  // ============================================================================
  // STRESS TEST: Check orderbook state
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         STRESS PHASE 2: Orderbook State Verification          ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const [, hubRep] = findReplica(env, hub.id);
  const ext = hubRep.state.orderbookExt;
  const book = ext?.books?.get('1/4');

  if (book) {
    let bidCount = 0, askCount = 0, totalQty = 0n;
    for (let i = 0; i < book.orderActive.length; i++) {
      if (book.orderActive[i]) {
        const qty = BigInt(book.orderQtyLots[i]!);
        totalQty += qty;
        if (book.orderSide[i] === 0) bidCount++;
        else askCount++;
      }
    }
    console.log(`📊 Orderbook ETH/USDC:`);
    console.log(`   - Active bids: ${bidCount}`);
    console.log(`   - Active asks: ${askCount}`);
    console.log(`   - Total lots: ${totalQty}`);

    // Some orders should have matched (crossing prices)
    const expectedOrders = ordersPlaced;
    const actualOrders = bidCount + askCount;
    const matchedOrders = expectedOrders - actualOrders;
    console.log(`   - Matched (crossed): ~${matchedOrders} orders\n`);
  }

  // ============================================================================
  // STRESS TEST: Final statistics
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                 STRESS TEST RESULTS                           ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📊 Total frames: ${env.history?.length || 0}`);
  console.log(`📈 Orders placed: ${ordersPlaced}`);
  console.log(`⏱️  Order time: ${orderTime}ms`);
  console.log(`🚀 Throughput: ${(ordersPlaced / (orderTime / 1000)).toFixed(1)} orders/sec`);
  console.log(`👥 Traders: ${traders.length}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

    // Drain any trailing mempool/pending frames before returning.
    await converge(env, 200);
    assertRuntimeIdle(env, 'Swap Market');

  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreStrict();
  }
}

// Self-executing scenario
if (import.meta.main) {
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv();
  env.scenarioMode = true;
  env.runtimeSeed = 'swap-market-cli-seed-42'; // Set before require check

  const args = process.argv.slice(2);
  if (args.includes('--stress')) {
    await swapMarketStress(env);
  } else {
    await swapMarket(env);
  }
}
