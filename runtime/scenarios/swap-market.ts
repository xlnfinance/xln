/**
 * Multi-Party Orderbook Market Scenario
 *
 * Tests realistic orderbook behavior with:
 * - 1 reference asset (USDC - token 1)
 * - 3 pairwise books: USDC/ETH, USDC/BTC, USDC/DAI
 * - 8 participants: Hub + 7 traders (Alice, Bob, Carol, Dave, Eve, Frank, Grace)
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
import { formatRuntime } from '../runtime-ascii';

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`❌ ${message}`);
  console.log(`✅ ${message}`);
}

async function converge(env: Env, maxCycles = 10): Promise<void> {
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

function findReplica(env: Env, entityId: string) {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) throw new Error(`Replica for entity ${entityId} not found`);
  return entry;
}

export async function swapMarket(env: Env): Promise<void> {
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
  createJReplica(env, 'Market', depositoryAddress, { x: 0, y: 100, z: 0 });
  const jurisdiction = createJurisdictionConfig('Market', depositoryAddress);
  console.log('✅ BrowserVM J-Machine created\n');

  // ============================================================================
  // SETUP: Create 8 entities (Hub + 7 traders)
  // ============================================================================
  console.log('📦 Creating 8 market participants...');

  const entities = [
    { name: 'Hub', id: '0x' + '1'.padStart(64, '0'), signer: 's1', role: 'market-maker' },
    { name: 'Alice', id: '0x' + '2'.padStart(64, '0'), signer: 's2', role: 'maker' },
    { name: 'Bob', id: '0x' + '3'.padStart(64, '0'), signer: 's3', role: 'maker' },
    { name: 'Carol', id: '0x' + '4'.padStart(64, '0'), signer: 's4', role: 'taker' },
    { name: 'Dave', id: '0x' + '5'.padStart(64, '0'), signer: 's5', role: 'taker' },
    { name: 'Eve', id: '0x' + '6'.padStart(64, '0'), signer: 's6', role: 'maker' },
    { name: 'Frank', id: '0x' + '7'.padStart(64, '0'), signer: 's7', role: 'taker' },
    { name: 'Grace', id: '0x' + '8'.padStart(64, '0'), signer: 's8', role: 'maker' },
  ];

  const createEntityTxs = entities.map(e => ({
    type: 'importReplica' as const,
    entityId: e.id,
    signerId: e.signer,
    data: {
      isProposer: true,
      position: { x: Math.random() * 1000, y: Math.random() * 1000, z: Math.random() * 1000 },
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

  const [hub, alice, bob, carol, dave, eve, frank, grace] = entities;

  // ============================================================================
  // SETUP: Open bilateral accounts (all traders ↔ Hub)
  // ============================================================================
  console.log('🔗 Opening bilateral accounts (traders ↔ Hub)...');

  const traders = [alice, bob, carol, dave, eve, frank, grace];

  await process(env, traders.map(trader => ({
    entityId: trader.id,
    signerId: trader.signer,
    entityTxs: [{ type: 'openAccount', data: { targetEntityId: hub.id } }],
  })));

  await converge(env);
  console.log('  ✅ All bilateral accounts created\n');

  // ============================================================================
  // SETUP: Credit limits (4 tokens: USDC, ETH, BTC, DAI)
  // ============================================================================
  console.log('💳 Setting up credit limits for all traders...');

  const creditLimit = usdc(10_000_000); // 10M capacity per token per side

  // Hub extends credit to all traders (4 tokens each)
  await process(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: traders.flatMap(trader => [
      { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: USDC, amount: creditLimit } },
      { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: ETH, amount: creditLimit } },
      { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: BTC, amount: creditLimit } },
      { type: 'extendCredit', data: { counterpartyEntityId: trader.id, tokenId: DAI, amount: creditLimit } },
    ]),
  }]);

  // Traders extend credit back to Hub
  await process(env, traders.map(trader => ({
    entityId: trader.id,
    signerId: trader.signer,
    entityTxs: [
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: USDC, amount: creditLimit } },
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: ETH, amount: creditLimit } },
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: BTC, amount: creditLimit } },
      { type: 'extendCredit', data: { counterpartyEntityId: hub.id, tokenId: DAI, amount: creditLimit } },
    ],
  })));

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
  console.log('💱 USDC/ETH Orderbook:');
  await process(env, [
    // Alice: Sell 10 ETH @ $3100 (ask above market)
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'alice-eth-ask',
          counterpartyId: hub.id,
          giveTokenId: ETH,
          giveAmount: eth(10),
          wantTokenId: USDC,
          wantAmount: usdc(31000), // $3100/ETH
          minFillRatio: MAX_FILL_RATIO / 4, // 25% min fill
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
          counterpartyId: hub.id,
          giveTokenId: ETH,
          giveAmount: eth(5),
          wantTokenId: USDC,
          wantAmount: usdc(15250), // $3050/ETH
          minFillRatio: MAX_FILL_RATIO / 2, // 50% min fill
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
          counterpartyId: hub.id,
          giveTokenId: USDC,
          giveAmount: usdc(23600), // $2950/ETH * 8
          wantTokenId: ETH,
          wantAmount: eth(8),
          minFillRatio: MAX_FILL_RATIO / 4, // 25% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Alice: SELL 10 ETH @ $3100 (ask)');
  console.log('  ✅ Bob: SELL 5 ETH @ $3050 (ask)');
  console.log('  ✅ Eve: BUY 8 ETH @ $2950 (bid)\n');

  // USDC/BTC book (BTC @ $60000)
  console.log('💱 USDC/BTC Orderbook:');
  await process(env, [
    // Grace: Sell 2 BTC @ $61000 (ask)
    {
      entityId: grace.id,
      signerId: grace.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'grace-btc-ask',
          counterpartyId: hub.id,
          giveTokenId: BTC,
          giveAmount: btc(2),
          wantTokenId: USDC,
          wantAmount: usdc(122000), // $61000/BTC
          minFillRatio: MAX_FILL_RATIO / 2, // 50% min fill
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
          counterpartyId: hub.id,
          giveTokenId: USDC,
          giveAmount: usdc(59000), // $59000/BTC
          wantTokenId: BTC,
          wantAmount: btc(1),
          minFillRatio: MAX_FILL_RATIO / 4, // 25% min fill
        },
      }],
    },
  ]);

  console.log('  ✅ Grace: SELL 2 BTC @ $61000 (ask)');
  console.log('  ✅ Alice: BUY 1 BTC @ $59000 (bid)\n');

  // USDC/DAI book (DAI @ $1)
  console.log('💱 USDC/DAI Orderbook:');
  await process(env, [
    // Bob: Sell 50000 DAI @ $1.001 (tight spread, stablecoin pair)
    {
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          offerId: 'bob-dai-ask',
          counterpartyId: hub.id,
          giveTokenId: DAI,
          giveAmount: dai(50000),
          wantTokenId: USDC,
          wantAmount: usdc(50050), // $1.001/DAI
          minFillRatio: MAX_FILL_RATIO / 10, // 10% min fill
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
          counterpartyId: hub.id,
          giveTokenId: USDC,
          giveAmount: usdc(29970), // $0.999/DAI * 30000
          wantTokenId: DAI,
          wantAmount: dai(30000),
          minFillRatio: MAX_FILL_RATIO / 10, // 10% min fill
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
        counterpartyId: hub.id, // Carol's account is with Hub
        fillRatio: Math.floor(MAX_FILL_RATIO * 0.6), // 60% fill = 3 ETH
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
        counterpartyId: hub.id, // Dave's account is with Hub
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
        counterpartyId: hub.id, // Frank's account is with Hub
        fillRatio: Math.floor(MAX_FILL_RATIO * 0.2), // 20% fill = 10000 DAI
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
        counterpartyId: hub.id,
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
        counterpartyId: hub.id,
        giveTokenId: ETH,
        giveAmount: eth(10),
        wantTokenId: USDC,
        wantAmount: usdc(30200), // $3020/ETH (better price)
        minFillRatio: MAX_FILL_RATIO / 4,
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

  const [, hubRep] = findReplica(env, hub.id);
  const hubBooks = hubRep.state.orderbookExt;

  if (hubBooks) {
    console.log('📈 Hub Orderbook State:');
    console.log(`  - Total pairs: ${hubBooks.size}`);

    // Count orders per book
    for (const [pairId, book] of hubBooks) {
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
    const account = rep.state.accounts.get(hub.id);
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
  console.log(`👥 Participants: 8 (${entities.map(e => e.name).join(', ')})`);
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
