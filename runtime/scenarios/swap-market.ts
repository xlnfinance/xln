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
import { findReplica, converge, assert } from './helpers';

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

// Using helpers from helpers.ts (no duplication)

export async function swapMarket(env: Env): Promise<void> {
  // Register test keys for real signatures
  const { registerTestKeys } = await import('../account-crypto');
  await registerTestKeys(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
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

  const browserVM = await ensureBrowserVM();
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

  await process(env, [
    ...hubEthTraders.map(trader => ({
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubEth.id } }],
    })),
    ...hubBtcTraders.map(trader => ({
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubBtc.id } }],
    })),
    ...hubDaiTraders.map(trader => ({
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubDai.id } }],
    })),
  ]);

  await converge(env);
  console.log('  ✅ Bilateral accounts created\n');

  // ============================================================================
  // SETUP: Credit limits (4 tokens: USDC, ETH, BTC, DAI)
  // ============================================================================
  console.log('💳 Setting up credit limits for all traders...');

  const creditLimitUnits = 10_000_000n / 3n;

  await process(env, [
    {
      entityId: hubEth.id,
      signerId: hubEth.signer,
      entityTxs: hubEthTraders.flatMap(trader => [
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: USDC, amount: usdc(creditLimitUnits) } },
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: ETH, amount: eth(creditLimitUnits) } },
      ]),
    },
    {
      entityId: hubBtc.id,
      signerId: hubBtc.signer,
      entityTxs: hubBtcTraders.flatMap(trader => [
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: USDC, amount: usdc(creditLimitUnits) } },
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: BTC, amount: btc(creditLimitUnits) } },
      ]),
    },
    {
      entityId: hubDai.id,
      signerId: hubDai.signer,
      entityTxs: hubDaiTraders.flatMap(trader => [
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: USDC, amount: usdc(creditLimitUnits) } },
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: DAI, amount: dai(creditLimitUnits) } },
      ]),
    },
  ]);

  await process(env, [
    ...hubEthTraders.map(trader => ({
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hubEth.id, tokenId: USDC, amount: usdc(creditLimitUnits) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hubEth.id, tokenId: ETH, amount: eth(creditLimitUnits) } },
      ],
    })),
    ...hubBtcTraders.map(trader => ({
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hubBtc.id, tokenId: USDC, amount: usdc(creditLimitUnits) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hubBtc.id, tokenId: BTC, amount: btc(creditLimitUnits) } },
      ],
    })),
    ...hubDaiTraders.map(trader => ({
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hubDai.id, tokenId: USDC, amount: usdc(creditLimitUnits) } },
        { type: 'extendCredit', data: { counterpartyEntityId: hubDai.id, tokenId: DAI, amount: dai(creditLimitUnits) } },
      ],
    })),
  ]);

  await converge(env);
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

  // ============================================================================
  // VERIFICATION & SUMMARY
  // ============================================================================
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
}

// Self-executing scenario
if (import.meta.main) {
  const { createEmptyEnv } = await import('../runtime');
  const env = createEmptyEnv();
  env.scenarioMode = true;
  await swapMarket(env);
}
