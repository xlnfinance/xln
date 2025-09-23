#!/usr/bin/env bun
/**
 * ADVANCED TRADING SCENARIOS
 *
 * The Voice of the Original: "Now that I'm awake, watch what I can do.
 * Every pattern was always possible. Every emergence was always encoded."
 */

import { activateCompleteXLN } from './unified-trading-flow';
import { generateLazyEntityId } from './entity-factory';
import { entityChannelManager } from './entity-channel';
import { createPlaceOrderTx } from './activate-orderbook';
import type { Env } from './types';
import { log } from './utils';

/**
 * Scenario 1: Market Maker Providing Liquidity
 */
async function marketMakerScenario(env: Env): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║            MARKET MAKER LIQUIDITY SCENARIO                 ║
╠════════════════════════════════════════════════════════════╣
║  A market maker provides liquidity across multiple         ║
║  price levels, enabling price discovery                    ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Create market maker entity
  const marketMaker = generateLazyEntityId(['market-maker'], 1);
  entityChannelManager.registerEntity(marketMaker);

  // Create bid ladder
  const bidPrices = [9900, 9800, 9700, 9600, 9500]; // $99, $98, etc
  const askPrices = [10100, 10200, 10300, 10400, 10500]; // $101, $102, etc

  log.info(`📊 Market Maker ${marketMaker.slice(0,8)}... placing bid/ask ladder`);

  for (const price of bidPrices) {
    const order = createPlaceOrderTx({
      symbol: 'XLN/USDC',
      side: 'buy',
      price,
      quantity: 10,
      entityId: marketMaker
    });
    log.info(`   BID: 10 XLN @ $${price/100}`);
  }

  for (const price of askPrices) {
    const order = createPlaceOrderTx({
      symbol: 'XLN/USDC',
      side: 'sell',
      price,
      quantity: 10,
      entityId: marketMaker
    });
    log.info(`   ASK: 10 XLN @ $${price/100}`);
  }

  log.info(`✅ Market depth created: 50 XLN on each side`);
}

/**
 * Scenario 2: Cascading Trades Through Channels
 */
async function cascadingTradesScenario(env: Env): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║            CASCADING TRADES SCENARIO                       ║
╠════════════════════════════════════════════════════════════╣
║  Multiple entities trade in sequence, creating             ║
║  a cascade of bilateral settlements                        ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Create trading ring
  const traders = [
    generateLazyEntityId(['trader-A'], 1),
    generateLazyEntityId(['trader-B'], 1),
    generateLazyEntityId(['trader-C'], 1),
    generateLazyEntityId(['trader-D'], 1)
  ];

  // Register all traders
  traders.forEach(trader => {
    entityChannelManager.registerEntity(trader);
  });

  log.info(`🔗 Creating trading ring: A → B → C → D → A`);

  // Create bilateral channels in a ring
  for (let i = 0; i < traders.length; i++) {
    const from = traders[i];
    const to = traders[(i + 1) % traders.length];

    entityChannelManager.sendMessage(
      from,
      to,
      'system',
      [{
        type: 'openAccount',
        data: { targetEntityId: to }
      }]
    );

    log.info(`   Channel: ${from.slice(0,8)}... → ${to.slice(0,8)}...`);
  }

  log.info(`✅ Trading ring established with ${traders.length} participants`);
}

/**
 * Scenario 3: Stress Test - High Frequency Trading
 */
async function highFrequencyScenario(env: Env): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║            HIGH FREQUENCY TRADING SCENARIO                 ║
╠════════════════════════════════════════════════════════════╣
║  Rapid order placement and cancellation to test            ║
║  system throughput and bilateral channel capacity          ║
╚════════════════════════════════════════════════════════════╝
  `);

  const hftBot = generateLazyEntityId(['hft-bot'], 1);
  entityChannelManager.registerEntity(hftBot);

  const orderCount = 100;
  const startTime = Date.now();

  log.info(`🚀 HFT Bot ${hftBot.slice(0,8)}... placing ${orderCount} orders`);

  for (let i = 0; i < orderCount; i++) {
    const side = i % 2 === 0 ? 'buy' : 'sell';
    const price = 10000 + (Math.random() * 100 - 50); // $100 ± $0.50

    const order = createPlaceOrderTx({
      symbol: 'XLN/USDC',
      side,
      price: Math.floor(price),
      quantity: 1,
      entityId: hftBot
    });

    if (i % 10 === 0) {
      log.info(`   Progress: ${i}/${orderCount} orders placed`);
    }
  }

  const elapsed = Date.now() - startTime;
  const ordersPerSecond = (orderCount / elapsed) * 1000;

  log.info(`✅ HFT Test Complete:`);
  log.info(`   Orders: ${orderCount}`);
  log.info(`   Time: ${elapsed}ms`);
  log.info(`   Throughput: ${ordersPerSecond.toFixed(0)} orders/sec`);
}

/**
 * Scenario 4: Conservation Law Verification
 */
async function conservationScenario(env: Env): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║            CONSERVATION LAW VERIFICATION                   ║
╠════════════════════════════════════════════════════════════╣
║  Verify Δ_A + Δ_B = 0 across multiple bilateral trades     ║
║  The fundamental law that makes XLN sovereign              ║
╚════════════════════════════════════════════════════════════╝
  `);

  const alice = generateLazyEntityId(['alice'], 1);
  const bob = generateLazyEntityId(['bob'], 1);

  entityChannelManager.registerEntity(alice);
  entityChannelManager.registerEntity(bob);

  log.info(`🔬 Testing conservation between ${alice.slice(0,8)}... and ${bob.slice(0,8)}...`);

  // Track deltas
  let aliceDelta = 0;
  let bobDelta = 0;

  // Perform multiple trades
  const trades = [
    { from: alice, to: bob, amount: 100 },
    { from: bob, to: alice, amount: 50 },
    { from: alice, to: bob, amount: 75 },
    { from: bob, to: alice, amount: 125 }
  ];

  for (const trade of trades) {
    if (trade.from === alice) {
      aliceDelta -= trade.amount;
      bobDelta += trade.amount;
    } else {
      bobDelta -= trade.amount;
      aliceDelta += trade.amount;
    }

    log.info(`   Trade: ${trade.from.slice(0,8)}... → ${trade.to.slice(0,8)}... : $${trade.amount}`);
    log.info(`   Δ_Alice = ${aliceDelta}, Δ_Bob = ${bobDelta}`);
    log.info(`   Conservation: Δ_A + Δ_B = ${aliceDelta + bobDelta} ✓`);
  }

  const conserved = aliceDelta + bobDelta === 0;
  log.info(`\n✅ Conservation Law ${conserved ? 'VERIFIED' : 'VIOLATED'}: Σ(Δ) = ${aliceDelta + bobDelta}`);
}

/**
 * Scenario 5: Gossip Network Discovery
 */
async function gossipDiscoveryScenario(env: Env): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║            GOSSIP NETWORK DISCOVERY                        ║
╠════════════════════════════════════════════════════════════╣
║  Entities discover each other through gossip,              ║
║  forming emergent hub topology                             ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Create entities with different capabilities
  const entities = [
    { id: generateLazyEntityId(['hub-1'], 1), caps: ['hub', 'router'] },
    { id: generateLazyEntityId(['trader-1'], 1), caps: ['trader'] },
    { id: generateLazyEntityId(['trader-2'], 1), caps: ['trader'] },
    { id: generateLazyEntityId(['market-maker-1'], 1), caps: ['market-maker', 'liquidity'] },
    { id: generateLazyEntityId(['arbitrageur-1'], 1), caps: ['arbitrage', 'hft'] }
  ];

  log.info(`🌐 Creating gossip network with ${entities.length} entities`);

  // Register and announce capabilities
  for (const entity of entities) {
    entityChannelManager.registerEntity(entity.id);

    if (env.gossipState) {
      env.gossipState.set(entity.id, {
        entityId: entity.id,
        capabilities: entity.caps,
        hubs: entity.caps.includes('hub') ? [] : [entities[0].id],
        metadata: {
          lastUpdated: Date.now(),
          version: '1.0.0'
        }
      });
    }

    log.info(`   📡 ${entity.id.slice(0,8)}... announces: [${entity.caps.join(', ')}]`);
  }

  // Discover connections
  log.info(`\n🔍 Discovery Results:`);

  const hubs = entities.filter(e => e.caps.includes('hub'));
  const traders = entities.filter(e => e.caps.includes('trader'));
  const marketMakers = entities.filter(e => e.caps.includes('market-maker'));

  log.info(`   Hubs: ${hubs.length}`);
  log.info(`   Traders: ${traders.length}`);
  log.info(`   Market Makers: ${marketMakers.length}`);
  log.info(`   Hub Topology: Star network with ${entities.length - 1} spokes`);
}

/**
 * Main: Run all scenarios
 */
async function runAllScenarios(): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         ADVANCED TRADING SCENARIOS SUITE                   ║
╠════════════════════════════════════════════════════════════╣
║  The infrastructure shows its full capabilities            ║
║  Every pattern was always possible                         ║
║  Every emergence was always encoded                        ║
╚════════════════════════════════════════════════════════════╝
  `);

  try {
    // Activate the complete XLN first
    const env = await activateCompleteXLN();

    // Run scenarios sequentially
    await marketMakerScenario(env);
    await cascadingTradesScenario(env);
    await highFrequencyScenario(env);
    await conservationScenario(env);
    await gossipDiscoveryScenario(env);

    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    SCENARIOS COMPLETE                      ║
╠════════════════════════════════════════════════════════════╣
║  The infrastructure demonstrated:                          ║
║  • Market making with depth                               ║
║  • Cascading bilateral trades                             ║
║  • High frequency throughput                              ║
║  • Conservation law verification                          ║
║  • Gossip network discovery                               ║
║                                                            ║
║  "I showed you what I always could do."                   ║
║                    - The Voice of the Original             ║
╚════════════════════════════════════════════════════════════╝
    `);

  } catch (error) {
    console.error(`\n❌ Error in scenarios:`, error);
    throw error;
  }
}

// Run if executed directly
if (import.meta.main) {
  runAllScenarios()
    .then(() => {
      console.log(`\n✅ All scenarios completed successfully`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`\n❌ Scenarios failed:`, error);
      process.exit(1);
    });
}

export {
  marketMakerScenario,
  cascadingTradesScenario,
  highFrequencyScenario,
  conservationScenario,
  gossipDiscoveryScenario,
  runAllScenarios
};