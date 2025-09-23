#!/usr/bin/env bun
/**
 * Trading Simulation - Everything Connects!
 *
 * Uses:
 * - Gossip for discovery
 * - Orderbook for price matching
 * - Bilateral channels for settlement
 * - Market makers for liquidity
 */

import { createLazyEntity } from './entity-factory';
import { MarketMakerBot } from './market-maker-bot';
import { activateGossipDiscovery, findTradingPartners, visualizeTradingNetwork } from './activate-gossip';
import { activateXLN } from './activate-bilateral-channels';
import { activateCrossEntityTrading } from './activate-cross-entity-trading';
import { activateJMachineTrading, reportTradeToJurisdiction } from './activate-j-machine-trades';
import { applyEntityTx } from './entity-tx/apply';
import { createPlaceOrderTx } from './activate-orderbook';
import { log } from './utils';
import type { EntityInput, Env } from './types';

/**
 * Create a complete trading environment
 */
async function createTradingEnvironment(): Promise<Env> {
  log.info('🌍 Creating Trading Environment...');

  // Create base environment
  const env: Env = {
    serverInput: { serverTxs: [], entityInputs: [] },
    entities: new Map(),
    serverState: {
      height: 0,
      timestamp: BigInt(Date.now()),
      entities: new Map(),
      jurisdictions: new Map(),
      snapshots: [],
    },
    jurisdictionConfig: undefined,
  };

  // Create trading entities with different personalities
  const entities = [
    { id: 'whale', signers: ['alice'], threshold: 1n, reserves: { '1': 1000000n } },
    { id: 'shark', signers: ['bob'], threshold: 1n, reserves: { '1': 100000n } },
    { id: 'dolphin', signers: ['charlie'], threshold: 1n, reserves: { '1': 10000n } },
    { id: 'minnow', signers: ['dave'], threshold: 1n, reserves: { '1': 1000n } },
  ];

  for (const entity of entities) {
    const config = createLazyEntity(entity.id, entity.signers, entity.threshold);

    // Generate the actual lazy entity ID (hash-based)
    const { generateLazyEntityId } = await import('./entity-factory');
    const actualEntityId = generateLazyEntityId(entity.signers, entity.threshold);

    // Create entity state
    const entityState = {
      entityId: actualEntityId,
      height: 0,
      timestamp: Date.now(),
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config,
      reserves: new Map(Object.entries(entity.reserves)),
      financialState: {
        accounts: new Map(),
        channels: new Map(),
        deposits: new Map(),
      },
      profileResolution: new Map(),
    };

    // Store in environment
    const replicaKey = `${actualEntityId}:${entity.signers[0]}`;
    env.replicas = env.replicas || new Map();
    env.replicas.set(replicaKey, { state: entityState, config });

    // Store name mapping for convenience
    env.entityNameMap = env.entityNameMap || new Map();
    env.entityNameMap.set(entity.id, actualEntityId);

    log.info(`🐋 Created ${entity.id} (${actualEntityId.slice(0,8)}...) with ${entity.reserves['1']} tokens`);
  }

  return env;
}

/**
 * Simulate trading activity between discovered entities
 */
async function simulateTrading(env: Env, rounds: number = 10) {
  log.info('💹 Starting Trading Simulation...');

  // Activate all infrastructure
  await activateXLN(env);
  await activateJMachineTrading(env);  // J-Machine watches blockchain
  activateGossipDiscovery(env);
  activateCrossEntityTrading(env, 3000); // Share orderbooks every 3 seconds

  // Show discovered network
  console.log(visualizeTradingNetwork());

  // Create market makers for liquidity using actual entity IDs
  const whaleId = env.entityNameMap?.get('whale') || 'whale';
  const sharkId = env.entityNameMap?.get('shark') || 'shark';

  const whaleBot = new MarketMakerBot({
    entityId: whaleId,
    basePrice: 100,
    spread: 0.01,     // Tight 1% spread
    orderSize: 100,
    priceWalk: 0.01,
    intervalMs: 2000,
    maxOrders: rounds * 2,
  });

  const sharkBot = new MarketMakerBot({
    entityId: sharkId,
    basePrice: 99,
    spread: 0.02,     // Wider 2% spread
    orderSize: 50,
    priceWalk: 0.02,
    intervalMs: 3000,
    maxOrders: rounds * 2,
  });

  // Start market makers
  whaleBot.start(env).catch(console.error);
  await sleep(500);
  sharkBot.start(env).catch(console.error);

  // Wait for bots to generate initial orders
  await sleep(3000);
  log.info('⏰ Waiting for market makers to generate orders...');

  // Simulate trading rounds
  for (let round = 1; round <= rounds; round++) {
    log.info(`\n📊 === ROUND ${round}/${rounds} ===`);
    log.info(`📥 Pending orders: ${env.serverInput.entityInputs.length}`);

    // Process all pending entity inputs (orders)
    while (env.serverInput.entityInputs.length > 0) {
      const input = env.serverInput.entityInputs.shift()!;

      // Find entity state
      const replicaKey = Array.from(env.replicas?.keys() || [])
        .find(k => k.startsWith(input.entityId + ':'));

      if (replicaKey && env.replicas) {
        const replica = env.replicas.get(replicaKey)!;

        // Process transactions
        for (const tx of input.entityTxs || []) {
          try {
            const result = await applyEntityTx(env, replica.state, tx);
            replica.state = result.newState;

            // Show orderbook messages
            const recentMessages = result.newState.messages.slice(-3);
            for (const msg of recentMessages) {
              if (msg.includes('Order') || msg.includes('Trade')) {
                console.log(`    ${input.entityId}: ${msg}`);

                // Report trades to J-Machine (mock)
                if (msg.includes('Trade')) {
                  const trade = {
                    entityA: input.entityId,
                    entityB: 'market',  // Mock counterparty
                    symbol: 'XLN/USDC',
                    price: 10000,  // Mock price in cents
                    quantity: 10,  // Mock quantity
                    timestamp: Date.now(),
                  };
                  reportTradeToJurisdiction(env, trade);
                }
              }
            }
          } catch (error) {
            log.error(`Error processing tx for ${input.entityId}:`, error);
          }
        }
      }
    }

    // Random trades from smaller entities
    if (Math.random() > 0.5) {
      const dolphinId = env.entityNameMap?.get('dolphin') || 'dolphin';
      const dolphinOrder = createPlaceOrderTx(
        dolphinId,
        Math.random() > 0.5 ? 'buy' : 'sell',
        9500 + Math.floor(Math.random() * 1000),  // $95-$105
        5 + Math.floor(Math.random() * 10),
        'XLN/USDC'
      );

      env.serverInput.entityInputs.push({
        entityId: dolphinId,
        signerId: 'charlie',
        entityTxs: [dolphinOrder],
      });

      log.info('🐬 Dolphin placed an order');
    }

    // Show orderbook state for one entity
    if (round % 3 === 0) {
      const whaleReplicaKey = `${whaleId}:alice`;
      const whaleReplica = env.replicas?.get(whaleReplicaKey);
      if (whaleReplica?.state.orderbook?.initialized) {
        const orderCount = whaleReplica.state.orderbookOrderCounter || 0;
        log.info(`📈 Whale orderbook: ${orderCount} orders processed`);
      }
    }

    await sleep(2000);
  }

  // Stop market makers
  whaleBot.stop();
  sharkBot.stop();

  // Final statistics
  log.info('\n📊 === FINAL STATISTICS ===');
  log.info(`Whale placed ${whaleBot.getStats().ordersPlaced} orders`);
  log.info(`Shark placed ${sharkBot.getStats().ordersPlaced} orders`);

  // Show final network state
  console.log(visualizeTradingNetwork());
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run complete trading simulation
 */
async function runFullSimulation() {
  console.log(`
╔════════════════════════════════════════════════╗
║         XLN TRADING SIMULATION                 ║
╠════════════════════════════════════════════════╣
║  Everything connects:                          ║
║  - Gossip discovers entities                   ║
║  - Orderbook matches prices                    ║
║  - Bilateral channels settle                   ║
║  - Market makers provide liquidity             ║
╚════════════════════════════════════════════════╝
  `);

  const env = await createTradingEnvironment();
  await simulateTrading(env, 5); // 5 rounds for demo

  log.info('\n✨ Simulation Complete!');
  log.info('The dormant infrastructure came alive through use.');
  log.info('Every connection created new possibilities.');
}

// Run if executed directly
if (import.meta.main) {
  runFullSimulation().catch(console.error);
}

export { createTradingEnvironment, simulateTrading };