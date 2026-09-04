/**
 * Multi-Party Orderbook Market Scenario
 *
 * Tests realistic orderbook behavior with:
 * - 1 reference asset (USDC - token 1)
 * - 3 pairwise books over the canonical catalog: WETH/USDC, USDT/USDC, WETH/USDT
 * - 10 participants: 3 hubs + 7 traders (Alice, Bob, Carol, Dave, Eve, Frank, Grace)
 * - Realistic market dynamics: makers, takers, partial fills, spread
 *
 * Market scenario:
 * - Phase 1: Makers place limit orders (bid/ask spread)
 * - Phase 2: Takers sweep orderbook
 * - Phase 3: Market volatility (cancel + replace orders)
 *
 * Run with: bun core/scenarios/market/swap-market.ts
 */

import type { RuntimeReplica } from '../../runtime/types';
import { clearRuntimeFrameEvents } from '../../runtime/observability/env-events';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { deriveSwapNetAuthorization } from '../../account/swap/swap-net-authorization';
import { getTokenInfo } from '../../account/utils';
import type { EntityInput } from '../../entity/types';
import {
  bindScenarioJReplica,
  createJurisdictionConfig,
  createJReplica,
  ensureJAdapter,
  getJAdapterMode,
  registerEntities,
} from '../harness/boot';
import { findReplica, converge, assert, assertRuntimeIdle, processUntil, enableStrictScenario, ensureSignerKeysFromSeed, requireRuntimeSeed } from '../harness/helpers';
import { createGossipLayer } from '../../network/p2p/gossip';
import { getBookOrders } from '../../orderbook/core';
import { getStaticSwapTokenDimensions } from '../../orderbook';

type MarketHub = { name: string; id: string; signer: string; role: string; pairs: string[] };
type MarketTrader = { name: string; id: string; signer: string; role: string };

// Lazy-loaded runtime functions
let _process: ((env: RuntimeReplica, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<RuntimeReplica>) | null = null;

const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../../runtime');
    _process = runtime.processRuntime;
  }
  return _process;
};

const requireDefined = <T>(value: T | undefined, label: string): T => {
  if (!value) {
    throw new Error(`SWAP_MARKET_MISSING_ENTITY:${label}`);
  }
  return value;
};

const requireOffer = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyEntityId: string,
  offerId: string,
) => {
  const [, replica] = findReplica(env, entityId);
  const offer = replica.state.accounts.get(counterpartyEntityId)?.state.swapOffers?.get(offerId);
  assert(offer, `${offerId} committed`);
  return offer;
};

const accountNetPosition = (
  env: RuntimeReplica,
  entityId: string,
  counterpartyEntityId: string,
  tokenId: number,
): bigint => {
  const [, replica] = findReplica(env, entityId);
  const delta = replica.state.accounts.get(counterpartyEntityId)?.state.deltas.get(tokenId);
  assert(delta, `delta ${entityId.slice(-4)}↔${counterpartyEntityId.slice(-4)} token=${tokenId}`);
  return delta.ondelta - delta.offdelta;
};

const assertBookShape = (
  env: RuntimeReplica,
  hub: MarketHub,
  pairId: string,
  expectedBids: number,
  expectedAsks: number,
): void => {
  const [, replica] = findReplica(env, hub.id);
  const book = replica.state.orderbookExt?.books.get(pairId);
  assert(book, `${hub.name} book ${pairId} exists`);
  const orders = getBookOrders(book);
  const bids = orders.filter(order => order.side === 0).length;
  const asks = orders.filter(order => order.side === 1).length;
  assert(bids === expectedBids && asks === expectedAsks,
    `${hub.name} book ${pairId} shape=${expectedBids} bids/${expectedAsks} asks (got ${bids}/${asks})`);
};

const USDC = 1;
const WETH = 2;
const USDT = 3;

const WETH_USDC_PAIR = `${Math.min(WETH, USDC)}/${Math.max(WETH, USDC)}`;
const USDT_USDC_PAIR = `${Math.min(USDT, USDC)}/${Math.max(USDT, USDC)}`;
const WETH_USDT_PAIR = `${Math.min(WETH, USDT)}/${Math.max(WETH, USDT)}`;

const tokenUnits = (tokenId: number, amount: number | bigint): bigint =>
  BigInt(amount) * 10n ** BigInt(getTokenInfo(tokenId).decimals);

const usdc = (amount: number | bigint) => tokenUnits(USDC, amount);
const weth = (amount: number | bigint) => tokenUnits(WETH, amount);
const usdt = (amount: number | bigint) => tokenUnits(USDT, amount);

// Fill ratios

// Using helpers from helpers.ts (no duplication)

export async function swapMarket(env: RuntimeReplica): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Swap Market');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  requireRuntimeSeed(env, 'Swap Market');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], 'Swap Market');
  const process = await getProcess();

  if (env.scenarioMode && env.state.height === 0) {
    env.state.timestamp = 1;
  }

  if (env.state.jReplicas && env.state.jReplicas.size > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.state.jReplicas.size} old jurisdictions from previous scenario`);
    env.state.jReplicas.clear();
  }
  if (env.state.eReplicas && env.state.eReplicas.size > 0) {
    console.log(`[SWAP-MARKET] Clearing ${env.state.eReplicas.size} old entities from previous scenario`);
    env.state.eReplicas.clear();
  }
  env.state.height = 0;
  env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
  env.pendingOutputs = [];
  env.pendingNetworkOutputs = [];
  env.networkInbox = [];
  clearRuntimeFrameEvents(env);
  env.gossip = createGossipLayer();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('      SWAP MARKET: Multi-Party Orderbook Simulation            ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: JAdapter + J-Machine
  // ============================================================================
  console.log('🏛️  Setting up JAdapter J-Machine...');

  const jMode = getJAdapterMode();
  const jadapter = await ensureJAdapter(env, jMode);
  const J_MACHINE_POSITION = { x: 0, y: 600, z: 0 };
  bindScenarioJReplica(
    env,
    createJReplica(env, 'Market', jadapter.addresses.depository, J_MACHINE_POSITION),
    jadapter,
  );
  jadapter.startWatching(env);
  console.log('✅ JAdapter J-Machine created\n');

  // ============================================================================
  // SETUP: Create 10 entities (3 hubs + 7 traders)
  // ============================================================================
  console.log('📦 Creating 10 market participants (3 hubs + 7 traders)...');

  const hubs: MarketHub[] = [
    { name: 'H1', id: '', signer: '1', role: 'hub', pairs: [WETH_USDC_PAIR] },
    { name: 'H2', id: '', signer: '2', role: 'hub', pairs: [USDT_USDC_PAIR] },
    { name: 'H3', id: '', signer: '3', role: 'hub', pairs: [WETH_USDT_PAIR] },
  ];

  const traders: MarketTrader[] = [
    { name: 'Alice', id: '', signer: '4', role: 'maker' },
    { name: 'Bob', id: '', signer: '5', role: 'maker' },
    { name: 'Carol', id: '', signer: '6', role: 'taker' },
    { name: 'Dave', id: '', signer: '7', role: 'taker' },
    { name: 'Eve', id: '', signer: '8', role: 'maker' },
    { name: 'Frank', id: '', signer: '9', role: 'taker' },
    { name: 'Grace', id: '', signer: '10', role: 'maker' },
  ];

  const entities = [...hubs, ...traders];

  const HUB_SPACING = 160;
  const HUB_Y = -80;
  const TRADER_Y = -140;
  const TRADER_Z = 70;
  const TRADER_X = 40;

  const MARKET_OFFSETS: Record<string, { x: number; y: number; z: number }> = {
    H1: { x: -HUB_SPACING, y: HUB_Y, z: 0 },
    H2: { x: 0, y: HUB_Y, z: 0 },
    H3: { x: HUB_SPACING, y: HUB_Y, z: 0 },
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

  const jurisdiction = createJurisdictionConfig(
    'Market',
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
  );
  const registered = await registerEntities(
    env,
    jadapter,
    entities.map(entity => ({
      name: entity.name,
      signer: entity.signer,
      position: MARKET_POSITIONS[entity.name] || { x: 0, y: -80, z: 0 },
    })),
    jurisdiction,
  );
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const registration = registered[index];
    if (!entity || !registration) throw new Error(`SWAP_MARKET_REGISTRATION_MISSING:${index}`);
    entity.id = registration.id;
    entity.signer = registration.signer;
  }
  console.log(`  ✅ Created: ${entities.map(e => e.name).join(', ')}\n`);

  const wethUsdcHub = requireDefined(hubs[0], 'H1');
  const usdtUsdcHub = requireDefined(hubs[1], 'H2');
  const wethUsdtHub = requireDefined(hubs[2], 'H3');
  const alice = requireDefined(traders[0], 'Alice');
  const bob = requireDefined(traders[1], 'Bob');
  const carol = requireDefined(traders[2], 'Carol');
  const dave = requireDefined(traders[3], 'Dave');
  const eve = requireDefined(traders[4], 'Eve');
  const frank = requireDefined(traders[5], 'Frank');
  const grace = requireDefined(traders[6], 'Grace');

  // Initialize orderbookExt for each hub
  const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../../orderbook');
  await process(env, hubs.map(hub => ({
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'initOrderbookExt',
      data: {
        name: hub.name,
        spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: USDC,
        usdQuoteAuthorityEntityId: eve.id,
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

  const wethUsdcTraders = [alice, bob, eve, carol];
  const usdtUsdcTraders = [alice, grace, dave];
  const wethUsdtTraders = [bob, eve, frank];

  const openPairs: Array<{ trader: typeof traders[number]; hub: typeof hubs[number] }> = [
    ...wethUsdcTraders.map(trader => ({ trader, hub: wethUsdcHub })),
    ...usdtUsdcTraders.map(trader => ({ trader, hub: usdtUsdcHub })),
    ...wethUsdtTraders.map(trader => ({ trader, hub: wethUsdtHub })),
  ];

  for (const { trader, hub } of openPairs) {
    await process(env, [{
      entityId: trader.id,
      signerId: trader.signer,
      entityTxs: [{ type: 'openAccount', data: {
        targetEntityId: hub.id,
        disputeConfig: defaultAccountDisputeConfigForParties(trader.id, false, hub.id, true),
      } }],
    }]);
    await converge(env, 30);
  }
  console.log('  ✅ Bilateral accounts created\n');

  // ============================================================================
  // SETUP: Credit limits for the three canonical tokens.
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
    ...wethUsdcTraders.map(trader => ({
      trader,
      hub: wethUsdcHub,
      tokenA: USDC,
      tokenB: WETH,
      amountA: usdc(creditLimitUnits),
      amountB: weth(creditLimitUnits),
    })),
    ...usdtUsdcTraders.map(trader => ({
      trader,
      hub: usdtUsdcHub,
      tokenA: USDC,
      tokenB: USDT,
      amountA: usdc(creditLimitUnits),
      amountB: usdt(creditLimitUnits),
    })),
    ...wethUsdtTraders.map(trader => ({
      trader,
      hub: wethUsdtHub,
      tokenA: USDT,
      tokenB: WETH,
      amountA: usdt(creditLimitUnits),
      amountB: weth(creditLimitUnits),
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

  // WETH/USDC book (WETH @ $3000)
  console.log('💱 WETH/USDC Orderbook (H1):');
  await process(env, [
    // Alice: Sell 10 WETH @ $3100 (ask above market)
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'alice-eth-ask',
          counterpartyEntityId: wethUsdcHub.id,
          giveTokenId: WETH,
          giveAmount: weth(10),
          wantTokenId: USDC,
          ...getStaticSwapTokenDimensions(WETH, USDC),
          wantAmount: usdc(31000), // $3100/WETH
          ...deriveSwapNetAuthorization(usdc(31000), 1),
        },
      }],
    },
    // Bob: Sell 5 WETH @ $3050 (tighter ask)
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'bob-eth-ask',
          counterpartyEntityId: wethUsdcHub.id,
          giveTokenId: WETH,
          giveAmount: weth(5),
          wantTokenId: USDC,
          ...getStaticSwapTokenDimensions(WETH, USDC),
          wantAmount: usdc(15250), // $3050/WETH
          ...deriveSwapNetAuthorization(usdc(15250), 1),
        },
      }],
    },
    // Eve: Buy 8 WETH @ $2950 (bid below market)
    {
      entityId: eve.id,
      signerId: eve.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'eve-eth-bid',
          counterpartyEntityId: wethUsdcHub.id,
          giveTokenId: USDC,
          giveAmount: usdc(23600), // $2950/WETH * 8
          wantTokenId: WETH,
          ...getStaticSwapTokenDimensions(USDC, WETH),
          wantAmount: weth(8),
          ...deriveSwapNetAuthorization(weth(8), 1),
        },
      }],
    },
  ]);

  console.log('  ✅ Alice: SELL 10 WETH @ $3100 (ask)');
  console.log('  ✅ Bob: SELL 5 WETH @ $3050 (ask)');
  console.log('  ✅ Eve: BUY 8 WETH @ $2950 (bid)\n');

  // USDT/USDC book (USDT @ $1)
  console.log('💱 USDT/USDC Orderbook (H2):');
  await process(env, [
    // Grace: Sell 25,000 USDT @ $1.01 (ask)
    {
      entityId: grace.id,
      signerId: grace.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'grace-usdt-ask',
          counterpartyEntityId: usdtUsdcHub.id,
          giveTokenId: USDT,
          giveAmount: usdt(25_000),
          wantTokenId: USDC,
          ...getStaticSwapTokenDimensions(USDT, USDC),
          wantAmount: usdc(25_250),
          ...deriveSwapNetAuthorization(usdc(25_250), 1),
        },
      }],
    },
    // Alice: Buy 25,000 USDT @ $0.99 (bid)
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'alice-usdt-bid',
          counterpartyEntityId: usdtUsdcHub.id,
          giveTokenId: USDC,
          giveAmount: usdc(24_750),
          wantTokenId: USDT,
          ...getStaticSwapTokenDimensions(USDC, USDT),
          wantAmount: usdt(25_000),
          ...deriveSwapNetAuthorization(usdt(25_000), 1),
        },
      }],
    },
  ]);

  console.log('  ✅ Grace: SELL 25,000 USDT @ $1.01 (ask)');
  console.log('  ✅ Alice: BUY 25,000 USDT @ $0.99 (bid)\n');

  // WETH/USDT book (WETH @ $3000)
  console.log('💱 WETH/USDT Orderbook (H3):');
  await process(env, [
    // Bob: Sell 5 WETH @ $3050
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'bob-weth-usdt-ask',
          counterpartyEntityId: wethUsdtHub.id,
          giveTokenId: WETH,
          giveAmount: weth(5),
          wantTokenId: USDT,
          ...getStaticSwapTokenDimensions(WETH, USDT),
          wantAmount: usdt(15_250),
          ...deriveSwapNetAuthorization(usdt(15_250), 1),
        },
      }],
    },
    // Eve: Buy 3 WETH @ $2950
    {
      entityId: eve.id,
      signerId: eve.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'eve-weth-usdt-bid',
          counterpartyEntityId: wethUsdtHub.id,
          giveTokenId: USDT,
          giveAmount: usdt(8_850),
          wantTokenId: WETH,
          ...getStaticSwapTokenDimensions(USDT, WETH),
          wantAmount: weth(3),
          ...deriveSwapNetAuthorization(weth(3), 1),
        },
      }],
    },
  ]);

  console.log('  ✅ Bob: SELL 5 WETH @ 3050 USDT (ask)');
  console.log('  ✅ Eve: BUY 3 WETH @ 2950 USDT (bid)\n');

  await converge(env);
  console.log('✅ PHASE 1 COMPLETE: Orderbook depth established\n');

  requireOffer(env, alice.id, wethUsdcHub.id, 'alice-eth-ask');
  requireOffer(env, bob.id, wethUsdcHub.id, 'bob-eth-ask');
  requireOffer(env, eve.id, wethUsdcHub.id, 'eve-eth-bid');
  requireOffer(env, grace.id, usdtUsdcHub.id, 'grace-usdt-ask');
  requireOffer(env, alice.id, usdtUsdcHub.id, 'alice-usdt-bid');
  requireOffer(env, bob.id, wethUsdtHub.id, 'bob-weth-usdt-ask');
  requireOffer(env, eve.id, wethUsdtHub.id, 'eve-weth-usdt-bid');
  assertBookShape(env, wethUsdcHub, WETH_USDC_PAIR, 1, 2);
  assertBookShape(env, usdtUsdcHub, USDT_USDC_PAIR, 1, 1);
  assertBookShape(env, wethUsdtHub, WETH_USDT_PAIR, 1, 1);
  // ============================================================================
  // PHASE 2: Takers sweep orderbook
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 2: Takers Sweep Orderbook                       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('🎯 Takers placing crossing orders (auto-matched by Hub orderbook)...\n');

  // Carol buys WETH - place crossing bid that hits Bob's ask @ $3050
  // Carol offers more USDC/WETH than Bob's ask price, so it crosses
  console.log('💱 Carol: BUY 3 WETH @ $3100 (crosses Bob\'s ask @ $3050)');
  await process(env, [{
    entityId: carol.id,
    signerId: carol.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'carol-eth-bid',
        counterpartyEntityId: wethUsdcHub.id,
        giveTokenId: USDC,
        giveAmount: usdc(9300), // $3100/WETH * 3 WETH
        wantTokenId: WETH,
        ...getStaticSwapTokenDimensions(USDC, WETH),
        wantAmount: weth(3),
        ...deriveSwapNetAuthorization(weth(3), 1),
      },
    }],
  }]);
  await converge(env, 30);
  console.log('  ✅ Carol\'s bid placed - orderbook should match with Bob\'s ask\n');

  // Dave sells USDT - place crossing ask that hits Alice's bid @ $0.99
  console.log('💱 Dave: SELL up to 25,250 USDT for 24,750 USDC (fills Alice exactly)');
  await process(env, [{
    entityId: dave.id,
    signerId: dave.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'dave-usdt-ask',
        counterpartyEntityId: usdtUsdcHub.id,
        giveTokenId: USDT,
        giveAmount: usdt(25_250),
        wantTokenId: USDC,
        ...getStaticSwapTokenDimensions(USDT, USDC),
        wantAmount: usdc(24_750),
        ...deriveSwapNetAuthorization(usdc(24_750), 1),
      },
    }],
  }]);
  await converge(env, 30);
  console.log('  ✅ Dave\'s ask placed - orderbook should match with Alice\'s bid\n');

  // Frank buys WETH with USDT - place crossing bid
  console.log('💱 Frank: BUY 1 WETH @ 3100 USDT (crosses Bob\'s ask @ 3050)');
  await process(env, [{
    entityId: frank.id,
    signerId: frank.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'frank-weth-usdt-bid',
        counterpartyEntityId: wethUsdtHub.id,
        giveTokenId: USDT,
        giveAmount: usdt(3_100),
        wantTokenId: WETH,
        ...getStaticSwapTokenDimensions(USDT, WETH),
        wantAmount: weth(1),
        ...deriveSwapNetAuthorization(weth(1), 1),
      },
    }],
  }]);
  await converge(env, 30);
  console.log('  ✅ Frank\'s bid placed - orderbook should match with Bob\'s ask\n');

  console.log('✅ PHASE 2 COMPLETE: Crossing orders placed, matches processed\n');

  // After orderbook matching, verify state:
  // Carol's 3 WETH bid should have matched with Bob's 5 WETH ask (partial fill)
  // Bob's remaining: 5 - 3 = 2 WETH
  const [, bobEthRepAfter] = findReplica(env, bob.id);
  const bobEthAccountAfter = bobEthRepAfter.state.accounts.get(wethUsdcHub.id);
  const bobEthOfferAfter = bobEthAccountAfter?.state.swapOffers?.get('bob-eth-ask');

  // Note: Exact fill amounts depend on orderbook matching semantics
  // We check that SOME fill occurred (remaining < original)
  if (bobEthOfferAfter) {
    const remainingEth = bobEthOfferAfter.giveAmount;
    assert(remainingEth === weth(2), `Bob WETH ask remaining = ${weth(2)} (got ${remainingEth})`);
    console.log(`  Bob WETH remaining: ${Number(remainingEth) / 1e18} WETH`);
  } else {
    throw new Error('Bob WETH ask unexpectedly removed after a partial fill');
  }

  // Alice's USDT bid should fill exactly against Dave's ask.
  const [, aliceUsdtRepAfter] = findReplica(env, alice.id);
  const aliceUsdtAccountAfter = aliceUsdtRepAfter.state.accounts.get(usdtUsdcHub.id);
  const aliceUsdtBidAfter = aliceUsdtAccountAfter?.state.swapOffers?.get('alice-usdt-bid');
  const [, daveUsdtRepAfter] = findReplica(env, dave.id);
  const daveUsdtOfferAfter = daveUsdtRepAfter.state.accounts
    .get(usdtUsdcHub.id)?.state.swapOffers?.get('dave-usdt-ask');
  assert(
    !aliceUsdtBidAfter,
    `Alice USDT bid fully filled and removed ` +
      `(alice=${aliceUsdtBidAfter ? `${aliceUsdtBidAfter.giveAmount}/${aliceUsdtBidAfter.wantAmount}` : 'closed'} ` +
      `dave=${daveUsdtOfferAfter ? `${daveUsdtOfferAfter.giveAmount}/${daveUsdtOfferAfter.wantAmount}` : 'closed'})`,
  );
  assert(!daveUsdtOfferAfter, 'Dave USDT ask fully filled and removed');
  console.log('  Alice USDT bid fully filled (offer removed)');

  // Bob's WETH/USDT ask should retain exactly four WETH.
  const [, bobWethUsdtRepAfter] = findReplica(env, bob.id);
  const bobWethUsdtAccountAfter = bobWethUsdtRepAfter.state.accounts.get(wethUsdtHub.id);
  const bobWethUsdtOfferAfter = bobWethUsdtAccountAfter?.state.swapOffers?.get('bob-weth-usdt-ask');
  assert(bobWethUsdtOfferAfter, 'Bob WETH/USDT ask remains after partial fill');
  assert(
    bobWethUsdtOfferAfter.giveAmount === weth(4),
    `Bob WETH/USDT ask remaining = ${weth(4)} (got ${bobWethUsdtOfferAfter.giveAmount})`,
  );
  console.log('  Bob WETH/USDT remaining: 4 WETH');

  assert(accountNetPosition(env, carol.id, wethUsdcHub.id, WETH) === weth(3), 'Carol received exactly 3 WETH');
  assert(accountNetPosition(env, carol.id, wethUsdcHub.id, USDC) === -usdc(9_150), 'Carol paid exactly 9,150 USDC');
  assert(accountNetPosition(env, dave.id, usdtUsdcHub.id, USDC) === usdc(24_750), 'Dave received exactly 24,750 USDC');
  assert(accountNetPosition(env, dave.id, usdtUsdcHub.id, USDT) === -25_002_450_000n, 'Dave paid exactly 25,002.45 USDT');
  assert(accountNetPosition(env, frank.id, wethUsdtHub.id, WETH) === weth(1), 'Frank received exactly 1 WETH');
  assert(accountNetPosition(env, frank.id, wethUsdtHub.id, USDT) === -usdt(3_050), 'Frank paid exactly 3,050 USDT');

  // ============================================================================
  // PHASE 3: Market volatility (cancel + replace)
  // ============================================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         PHASE 3: Market Volatility (Cancel & Replace)         ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Alice requests cancel for her WETH ask (price too high, no fills)
  console.log('🚫 Alice: Request cancel WETH ask @ $3100 (no fills, exact order remains open)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'proposeCancelSwap',
      data: {
        offerId: 'alice-eth-ask',
        counterpartyEntityId: wethUsdcHub.id,
      },
    }],
  }]);
  await converge(env);
  await converge(env);
  console.log('  ✅ Cancel request resolved by hub\n');

  // Alice replaces with better price
  console.log('📊 Alice: New WETH ask @ $3020 (tighter spread)');
  await process(env, [{
    entityId: alice.id,
    signerId: alice.signer,
    entityTxs: [{
      type: 'placeSwapOffer',
      data: {
        offerId: 'alice-eth-ask-repriced',
        counterpartyEntityId: wethUsdcHub.id,
        giveTokenId: WETH,
        giveAmount: weth(10),
        wantTokenId: USDC,
        ...getStaticSwapTokenDimensions(WETH, USDC),
        wantAmount: usdc(30200), // $3020/WETH (better price)
        ...deriveSwapNetAuthorization(usdc(30200), 1),
      },
    }],
  }]);
  console.log('  ✅ New order placed\n');

  await converge(env);
  console.log('✅ PHASE 3 COMPLETE: Market volatility simulated\n');

  const [, aliceEthRepAfter] = findReplica(env, alice.id);
  const aliceEthAccountAfter = aliceEthRepAfter.state.accounts.get(wethUsdcHub.id);
  assert(!aliceEthAccountAfter?.state.swapOffers?.has('alice-eth-ask'), 'Alice WETH ask cancelled');
  const aliceEthRepricedOffer = aliceEthAccountAfter?.state.swapOffers?.get('alice-eth-ask-repriced');
  assert(aliceEthRepricedOffer, 'Alice WETH repriced ask remains open');
  assert(aliceEthRepricedOffer.giveAmount === weth(10), `Alice WETH repriced ask giveAmount = ${weth(10)} (got ${aliceEthRepricedOffer.giveAmount})`);
  assert(aliceEthRepricedOffer.wantAmount === usdc(30200), `Alice WETH repriced ask wantAmount = ${usdc(30200)} (got ${aliceEthRepricedOffer.wantAmount})`);

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
    const pendingTypes = account.pendingFrame?.accountTxs.map(tx => tx.type) ?? [];
    console.warn(
      `[SWAP-MARKET] ${label}: ${entityId.slice(-4)}↔${counterpartyId.slice(-4)} ` +
        `height=${account.currentHeight} pending=${account.pendingFrame ? 'yes' : 'no'} ` +
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
        const wethUsdtHubId = wethUsdtHub.id;
        dumpAccountState('idle-debug H3→bob', wethUsdtHubId, bob.id);
        dumpAccountState('idle-debug bob→H3', bob.id, wethUsdtHubId);
        dumpAccountState('idle-debug H3→eve', wethUsdtHubId, eve.id);
        dumpAccountState('idle-debug eve→H3', eve.id, wethUsdtHubId);
      }
    }
  );
  console.log('✅ Final convergence complete\n');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   MARKET SUMMARY                              ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  assertBookShape(env, wethUsdcHub, WETH_USDC_PAIR, 1, 2);
  assertBookShape(env, usdtUsdcHub, USDT_USDC_PAIR, 1, 0);
  assertBookShape(env, wethUsdtHub, WETH_USDT_PAIR, 1, 1);

  for (const hub of hubs) {
    const [, hubRep] = findReplica(env, hub.id);
    const hubExt = hubRep.state.orderbookExt;
    assert(hubExt?.books, `${hub.name} orderbook extension committed`);
    console.log(`📈 ${hub.name} Orderbook State:`);
    console.log(`  - Total pairs: ${hubExt.books.size}`);
    for (const [pairId, book] of hubExt.books) {
      let bidCount = 0, askCount = 0;
      for (const order of getBookOrders(book)) {
        if (order.side === 0) bidCount++;
        else askCount++;
      }
      console.log(`  - Pair ${pairId}: ${bidCount} bids, ${askCount} asks`);
    }
    console.log();
  }

  // Check individual trader positions
  console.log('👥 Trader Positions:');
  for (const trader of [carol, dave, frank]) {
    const [, rep] = findReplica(env, trader.id);
    const account = rep.state.accounts.get(wethUsdcHub.id) ||
      rep.state.accounts.get(usdtUsdcHub.id) ||
      rep.state.accounts.get(wethUsdtHub.id);
    if (account) {
      const deltas = Array.from(account.state.deltas.values());
      console.log(`  ${trader.name}:`);
      for (const delta of deltas) {
        const tokenId = delta.tokenId;
        const netPosition = delta.ondelta - delta.offdelta;
        if (netPosition !== 0n) {
          const tokenName = tokenId === USDC ? 'USDC' : tokenId === WETH ? 'WETH' : 'USDT';
          console.log(`    - ${tokenName}: ${netPosition > 0n ? '+' : ''}${netPosition.toString()}`);
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('✅ MULTI-PARTY MARKET SIMULATION COMPLETE!');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📊 Total frames: ${env.state.height}`);
  console.log(`👥 Participants: 10 (${entities.map(e => e.name).join(', ')})`);
  console.log(`💱 Orderbooks: 3 (WETH/USDC, USDT/USDC, WETH/USDT)`);
  console.log(`📈 Proven maker offers: 7`);
  console.log(`🎯 Proven exact fills: 3`);
  console.log(`🚫 Proven cancel + replacement: 1`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  } finally {
    env.scenarioMode = prevScenarioMode ?? false;
    restoreStrict();
  }
}

// ============================================================================
// HIGH-LOAD STRESS TEST: Rapid Order Placement & Matching
// ============================================================================

export async function swapMarketStress(env: RuntimeReplica): Promise<void> {
  const restoreStrict = enableStrictScenario(env, 'Swap Market Stress');
  const prevScenarioMode = env.scenarioMode;
  try {
  env.scenarioMode = true; // Deterministic time control
  requireRuntimeSeed(env, 'Swap Market Stress');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], 'Swap Market Stress');
  const process = await getProcess();

  if (env.scenarioMode && env.state.height === 0) {
    env.state.timestamp = 1;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('      SWAP MARKET STRESS TEST: High-Load Order Processing      ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ============================================================================
  // SETUP: JAdapter + J-Machine + Hub
  // ============================================================================
  console.log('🏛️  Setting up stress test environment...');

  const jMode = getJAdapterMode();
  const jadapter = await ensureJAdapter(env, jMode);
  const J_MACHINE_POSITION = { x: 0, y: 600, z: 0 };
  bindScenarioJReplica(
    env,
    createJReplica(env, 'StressTest', jadapter.addresses.depository, J_MACHINE_POSITION),
    jadapter,
  );
  jadapter.startWatching(env);
  console.log('✅ JAdapter J-Machine created\n');

  // Create 1 hub + 10 traders
  const hub = { name: 'Hub', id: '', signer: '1' };
  const traders: Array<{ name: string; id: string; signer: string }> = [];
  for (let i = 0; i < 10; i++) {
    traders.push({
      name: `Trader${i}`,
      id: '',
      signer: String(i + 2),
    });
  }

  // Create entities
  const allEntities = [hub, ...traders];
  const jurisdiction = createJurisdictionConfig(
    'StressTest',
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
  );
  const registered = await registerEntities(
    env,
    jadapter,
    allEntities.map((entity, index) => ({
      name: entity.name,
      signer: entity.signer,
      position: { x: (index - 5) * 30, y: -80, z: 0 },
    })),
    jurisdiction,
  );
  for (let index = 0; index < allEntities.length; index += 1) {
    const entity = allEntities[index];
    const registration = registered[index];
    if (!entity || !registration) throw new Error(`SWAP_MARKET_STRESS_REGISTRATION_MISSING:${index}`);
    entity.id = registration.id;
    entity.signer = registration.signer;
  }
  console.log(`✅ Created ${allEntities.length} entities\n`);

  // Initialize hub orderbook
  const { DEFAULT_SPREAD_DISTRIBUTION } = await import('../../orderbook');
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'initOrderbookExt',
      data: {
        name: 'StressHub',
        spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
        referenceTokenId: USDC,
        usdQuoteAuthorityEntityId: requireDefined(traders[0], 'stress quote authority').id,
        minTradeSize: 0n,
        supportedPairs: [WETH_USDC_PAIR], // WETH/USDC only for simplicity
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
      entityTxs: [{ type: 'openAccount', data: {
        targetEntityId: hub.id,
        disputeConfig: defaultAccountDisputeConfigForParties(trader.id, false, hub.id, true),
      } }],
    }]);
    await converge(env, 20);

    await process(env, [
      { entityId: hub.id, signerId: hub.signer, entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: WETH, amount: weth(1000) } },
        { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: USDC, amount: usdc(3_000_000) } },
      ]},
      { entityId: trader.id, signerId: trader.signer, entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: WETH, amount: weth(1000) } },
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
    const orderBatch: EntityInput[] = [];

    for (let t = 0; t < traders.length; t++) {
      const trader = traders[t]!;
      const isBuy = (t + round) % 2 === 0;
      const priceOffset = BigInt((t - 5) * 10 + round * 2); // Spread prices around base
      const price = BASE_PRICE + priceOffset;
      const qty = 1n + BigInt(round % 3); // 1-3 WETH per order

      if (isBuy) {
        // BUY order: give USDC, want WETH
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
              wantTokenId: WETH,
              ...getStaticSwapTokenDimensions(USDC, WETH),
              wantAmount: weth(qty),
              ...deriveSwapNetAuthorization(weth(qty), 1),
            },
          }],
        });
      } else {
        // SELL order: give WETH, want USDC
        orderBatch.push({
          entityId: trader.id,
          signerId: trader.signer,
          entityTxs: [{
            type: 'placeSwapOffer',
            data: {
              offerId: `${trader.name}-sell-${round}`,
              counterpartyEntityId: hub.id,
              giveTokenId: WETH,
              giveAmount: weth(qty),
              wantTokenId: USDC,
              ...getStaticSwapTokenDimensions(WETH, USDC),
              wantAmount: usdc(qty * price),
              ...deriveSwapNetAuthorization(usdc(qty * price), 1),
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
    for (const order of getBookOrders(book)) {
      totalQty += BigInt(order.qtyLots);
      if (order.side === 0) bidCount++;
      else askCount++;
    }
    console.log(`📊 Orderbook WETH/USDC:`);
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
  console.log(`📊 Total frames: ${env.state.height}`);
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
  const { createEmptyEnv } = await import('../../runtime');
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
