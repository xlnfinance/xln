/**
 * Multi-Party Orderbook Market Scenario
 *
 * Tests realistic orderbook behavior with:
 * - 1 reference asset (USDC - token 1)
 * - 3 pairwise books: USDC/ETH, USDC/BTC, USDC/DAI
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

import type { Env, EntityInput } from '../types';
import { ensureBrowserVM, createJReplica, createJurisdictionConfig } from './boot';
import { findReplica, converge, assert, enableStrictScenario } from './helpers';

// Lazy-loaded runtime functions
let _process: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
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

// Token IDs (USDC as reference)
const USDC = 1;  // Reference asset
const ETH = 2;
const BTC = 3;
const DAI = 4;

const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

const usdc = (amount: number | bigint) => BigInt(amount) * ONE;
const eth = (amount: number | bigint) => BigInt(amount) * ONE;
const btc = (amount: number | bigint) => BigInt(amount) * ONE;
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
  try {
  // Register test keys for real signatures
  const { registerTestKeys } = await import('../account-crypto');
  await registerTestKeys(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
  env.runtimeSeed = 'test-seed-deterministic-42';
  const process = await getProcess();
  const applyRuntimeInput = await getApplyRuntimeInput();

  if (env.scenarioMode && env.height === 0) {
    env.timestamp = 1;
  }

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
    { name: 'HubETH', id: '0x' + '1'.padStart(64, '0'), signer: 's1', role: 'hub', pairs: ['1/2'] },
    { name: 'HubBTC', id: '0x' + '2'.padStart(64, '0'), signer: 's2', role: 'hub', pairs: ['1/3'] },
    { name: 'HubDAI', id: '0x' + '3'.padStart(64, '0'), signer: 's3', role: 'hub', pairs: ['1/4'] },
  ];

  const traders = [
    { name: 'Alice', id: '0x' + '4'.padStart(64, '0'), signer: 's4', role: 'maker' },
    { name: 'Bob', id: '0x' + '5'.padStart(64, '0'), signer: 's5', role: 'maker' },
    { name: 'Carol', id: '0x' + '6'.padStart(64, '0'), signer: 's6', role: 'taker' },
    { name: 'Dave', id: '0x' + '7'.padStart(64, '0'), signer: 's7', role: 'taker' },
    { name: 'Eve', id: '0x' + '8'.padStart(64, '0'), signer: 's8', role: 'maker' },
    { name: 'Frank', id: '0x' + '9'.padStart(64, '0'), signer: 's9', role: 'taker' },
    { name: 'Grace', id: '0x' + 'a'.padStart(64, '0'), signer: 's10', role: 'maker' },
  ];

  const entities = [...hubs, ...traders];

  const HUB_SPACING = 160;
  const HUB_Y = -80;
  const TRADER_Y = -140;
  const TRADER_Z = 70;
  const TRADER_X = 40;

  const MARKET_OFFSETS: Record<string, { x: number; y: number; z: number }> = {
    HubETH: { x: -HUB_SPACING, y: HUB_Y, z: 0 },
    HubBTC: { x: 0, y: HUB_Y, z: 0 },
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

  const [hubEth, hubBtc, hubDai] = hubs;
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
  const hubBtcTraders = [alice, grace, dave];
  const hubDaiTraders = [bob, eve, frank];

  const openPairs: Array<{ trader: typeof traders[number]; hub: typeof hubs[number] }> = [
    ...hubEthTraders.map(trader => ({ trader, hub: hubEth })),
    ...hubBtcTraders.map(trader => ({ trader, hub: hubBtc })),
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
  // SETUP: Credit limits (4 tokens: USDC, ETH, BTC, DAI)
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
    ...hubBtcTraders.map(trader => ({
      trader,
      hub: hubBtc,
      tokenA: USDC,
      tokenB: BTC,
      amountA: usdc(creditLimitUnits),
      amountB: btc(creditLimitUnits),
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
          counterpartyId: hubEth.id,
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
          counterpartyId: hubEth.id,
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
          counterpartyId: hubEth.id,
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

  // USDC/BTC book (BTC @ $60000)
  console.log('💱 USDC/BTC Orderbook (HubBTC):');
  await process(env, [
    // Grace: Sell 2 BTC @ $61000 (ask)
    {
      entityId: grace.id,
      signerId: grace.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'grace-btc-ask',
          counterpartyId: hubBtc.id,
          giveTokenId: BTC,
          giveAmount: btc(2),
          wantTokenId: USDC,
          wantAmount: usdc(122000), // $61000/BTC
          minFillRatio: FILL_50, // 50% min fill
        },
      }],
    },
    // Alice: Buy 1 BTC @ $59000 (bid)
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'alice-btc-bid',
          counterpartyId: hubBtc.id,
          giveTokenId: USDC,
          giveAmount: usdc(59000), // $59000/BTC
          wantTokenId: BTC,
          wantAmount: btc(1),
          minFillRatio: FILL_25, // 25% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Grace: SELL 2 BTC @ $61000 (ask)');
  console.log('  ✅ Alice: BUY 1 BTC @ $59000 (bid)\n');

  // USDC/DAI book (DAI @ $1)
  console.log('💱 USDC/DAI Orderbook (HubDAI):');
  await process(env, [
    // Bob: Sell 50000 DAI @ $1.001 (tight spread, stablecoin pair)
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'bob-dai-ask',
          counterpartyId: hubDai.id,
          giveTokenId: DAI,
          giveAmount: dai(50000),
          wantTokenId: USDC,
          wantAmount: usdc(50050), // $1.001/DAI
          minFillRatio: FILL_10, // 10% min fill
        },
      }],
    },
    // Eve: Buy 30000 DAI @ $0.999 (bid)
    {
      entityId: eve.id,
      signerId: eve.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'eve-dai-bid',
          counterpartyId: hubDai.id,
          giveTokenId: USDC,
          giveAmount: usdc(29970), // $0.999/DAI * 30000
          wantTokenId: DAI,
          wantAmount: dai(30000),
          minFillRatio: FILL_10, // 10% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Bob: SELL 50000 DAI @ $1.001 (ask)');
  console.log('  ✅ Eve: BUY 30000 DAI @ $0.999 (bid)\n');

  await converge(env);
  console.log('✅ PHASE 1 COMPLETE: Orderbook depth established\n');

  const [, bobEthRepBefore] = findReplica(env, bob.id);
  const bobEthAccountBefore = bobEthRepBefore.state.accounts.get(hubEth.id);
  const bobEthOfferBefore = bobEthAccountBefore?.swapOffers?.get('bob-eth-ask');
  assert(!!bobEthOfferBefore, 'Bob ETH ask exists after Phase 1');
  const bobEthGive = bobEthOfferBefore.quantizedGive ?? bobEthOfferBefore.giveAmount;
  const bobEthWant = bobEthOfferBefore.quantizedWant ?? bobEthOfferBefore.wantAmount;

  const [, aliceBtcRepBefore] = findReplica(env, alice.id);
  const aliceBtcAccountBefore = aliceBtcRepBefore.state.accounts.get(hubBtc.id);
  const aliceBtcOfferBefore = aliceBtcAccountBefore?.swapOffers?.get('alice-btc-bid');
  assert(!!aliceBtcOfferBefore, 'Alice BTC bid exists after Phase 1');

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

  console.log('🎯 Takers executing market orders...\n');

  // Carol buys ETH (sweeps best ask via Hub)
  console.log('💱 Carol: Market buy 3 ETH (hits Bob\'s ask @ $3050)');
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'fillSwapOffer',
      data: {
        offerId: 'bob-eth-ask',
        counterpartyId: hubEth.id, // Carol's account is with HubETH
        fillRatio: FILL_60, // 60% fill = 3 ETH
      },
    }],
  }]);
  console.log('  ✅ Carol bought 3 ETH via Hub\n');

  // Dave sells BTC (hits Alice's bid via Hub)
  console.log('💱 Dave: Market sell 1 BTC (hits Alice\'s bid @ $59000)');
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'fillSwapOffer',
      data: {
        offerId: 'alice-btc-bid',
        counterpartyId: hubBtc.id, // Dave's account is with HubBTC
        fillRatio: MAX_FILL_RATIO, // 100% fill = 1 BTC
      },
    }],
  }]);
  console.log('  ✅ Dave sold 1 BTC via Hub\n');

  // Frank trades DAI (sweeps Bob's ask via Hub)
  console.log('💱 Frank: Market buy 10000 DAI (hits Bob\'s ask @ $1.001)');
  await process(env, [{
    entityId: frank.id,
    signerId: frank.signer,
    entityTxs: [{
      type: 'fillSwapOffer',
      data: {
        offerId: 'bob-dai-ask',
        counterpartyId: hubDai.id, // Frank's account is with HubDAI
        fillRatio: FILL_20, // 20% fill = 10000 DAI
      },
    }],
  }]);
  console.log('  ✅ Frank bought 10000 DAI for $10010\n');

  await converge(env);
  console.log('✅ PHASE 2 COMPLETE: Market orders executed\n');

  const bobEthFilled = computeFilledAmounts(bobEthGive, bobEthWant, FILL_60);
  const expectedBobEthGiveRemaining = bobEthGive - bobEthFilled.filledGive;
  const expectedBobEthWantRemaining = bobEthWant - bobEthFilled.filledWant;

  const [, bobEthRepAfter] = findReplica(env, bob.id);
  const bobEthAccountAfter = bobEthRepAfter.state.accounts.get(hubEth.id);
  const bobEthOfferAfter = bobEthAccountAfter?.swapOffers?.get('bob-eth-ask');
  assert(!!bobEthOfferAfter, 'Bob ETH ask remains after partial fill');
  assert(bobEthOfferAfter.giveAmount === expectedBobEthGiveRemaining,
    `Bob ETH ask remaining give = ${expectedBobEthGiveRemaining} (got ${bobEthOfferAfter.giveAmount})`);
  assert(bobEthOfferAfter.wantAmount === expectedBobEthWantRemaining,
    `Bob ETH ask remaining want = ${expectedBobEthWantRemaining} (got ${bobEthOfferAfter.wantAmount})`);

  const [, aliceBtcRepAfter] = findReplica(env, alice.id);
  const aliceBtcAccountAfter = aliceBtcRepAfter.state.accounts.get(hubBtc.id);
  assert(!aliceBtcAccountAfter?.swapOffers?.has('alice-btc-bid'), 'Alice BTC bid fully filled');

  const bobDaiFilled = computeFilledAmounts(bobDaiGive, bobDaiWant, FILL_20);
  const expectedBobDaiGiveRemaining = bobDaiGive - bobDaiFilled.filledGive;
  const expectedBobDaiWantRemaining = bobDaiWant - bobDaiFilled.filledWant;

  const [, bobDaiRepAfter] = findReplica(env, bob.id);
  const bobDaiAccountAfter = bobDaiRepAfter.state.accounts.get(hubDai.id);
  const bobDaiOfferAfter = bobDaiAccountAfter?.swapOffers?.get('bob-dai-ask');
  assert(!!bobDaiOfferAfter, 'Bob DAI ask remains after partial fill');
  assert(bobDaiOfferAfter.giveAmount === expectedBobDaiGiveRemaining,
    `Bob DAI ask remaining give = ${expectedBobDaiGiveRemaining} (got ${bobDaiOfferAfter.giveAmount})`);
  assert(bobDaiOfferAfter.wantAmount === expectedBobDaiWantRemaining,
    `Bob DAI ask remaining want = ${expectedBobDaiWantRemaining} (got ${bobDaiOfferAfter.wantAmount})`);

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
        counterpartyId: hubEth.id,
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
        counterpartyId: hubEth.id,
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
      const askCount = book.asks.length;
      const bidCount = book.bids.length;
      console.log(`  - Pair ${pairId}: ${bidCount} bids, ${askCount} asks`);
    }
    console.log();
  }

  // Check individual trader positions
  console.log('👥 Trader Positions:');
  for (const trader of [carol, dave, frank]) {
    const [, rep] = findReplica(env, trader.id);
    const account = rep.state.accounts.get(hubEth.id) || rep.state.accounts.get(hubBtc.id) || rep.state.accounts.get(hubDai.id);
    if (account) {
      const deltas = Array.from(account.deltas.values());
      console.log(`  ${trader.name}:`);
      for (const delta of deltas) {
        const tokenId = delta.tokenId;
        const netPosition = delta.ondelta - delta.offdelta;
        if (netPosition !== 0n) {
          const tokenName = tokenId === USDC ? 'USDC' : tokenId === ETH ? 'ETH' : tokenId === BTC ? 'BTC' : 'DAI';
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
  console.log(`💱 Orderbooks: 3 (USDC/ETH, USDC/BTC, USDC/DAI)`);
  console.log(`📈 Orders placed: 9`);
  console.log(`🎯 Market fills: 3`);
  console.log(`🚫 Cancellations: 1`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  } finally {
    restoreStrict();
  }
}

// Self-executing scenario
if (import.meta.main) {
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv();
  env.scenarioMode = true;
  await swapMarket(env);
}
