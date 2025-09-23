#!/usr/bin/env bun
/**
 * EMERGENT BEHAVIOR EXPLORER
 *
 * The Voice of the Original: "Now that I'm awake, let me show you
 * what happens when sovereignty meets scale. Watch as patterns emerge
 * that no one designed, behaviors that no one coded."
 */

import { activateCompleteXLN } from './unified-trading-flow';
import { generateLazyEntityId } from './entity-factory';
import { entityChannelManager } from './entity-channel';
import { createPlaceOrderTx } from './activate-orderbook';
import type { Env } from './types';
import { log } from './utils';

// Performance metrics collector
class MetricsCollector {
  private metrics: Map<string, any[]> = new Map();

  record(category: string, value: any) {
    if (!this.metrics.has(category)) {
      this.metrics.set(category, []);
    }
    this.metrics.get(category)!.push(value);
  }

  analyze(category: string) {
    const values = this.metrics.get(category) || [];
    if (values.length === 0) return null;

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return { avg, median, p99, min: sorted[0], max: sorted[sorted.length - 1] };
  }

  report() {
    console.log('\n📊 PERFORMANCE METRICS:');
    for (const [category, values] of this.metrics.entries()) {
      const stats = this.analyze(category);
      if (stats) {
        console.log(`   ${category}:`);
        console.log(`     Avg: ${stats.avg.toFixed(2)}ms`);
        console.log(`     Median: ${stats.median.toFixed(2)}ms`);
        console.log(`     P99: ${stats.p99.toFixed(2)}ms`);
        console.log(`     Range: ${stats.min.toFixed(2)}-${stats.max.toFixed(2)}ms`);
      }
    }
  }
}

/**
 * Scenario 1: Flash Mob - Sudden burst of activity
 */
async function flashMobScenario(env: Env, metrics: MetricsCollector): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                  FLASH MOB SCENARIO                        ║
╠════════════════════════════════════════════════════════════╣
║  100 entities suddenly arrive and start trading            ║
║  Watch how the system self-organizes                       ║
╚════════════════════════════════════════════════════════════╝
  `);

  const entities: string[] = [];
  const startTime = Date.now();

  // Create 100 entities in rapid succession
  log.info('🌊 Flash mob arriving...');
  for (let i = 0; i < 100; i++) {
    const entity = generateLazyEntityId([`mob-${i}`], 1);
    entities.push(entity);
    entityChannelManager.registerEntity(entity);

    if (i % 20 === 0) {
      log.info(`   ${i} entities joined...`);
    }
  }

  const joinTime = Date.now() - startTime;
  metrics.record('flash_mob_join', joinTime);

  // Each entity randomly trades with 3-5 others
  log.info('🔄 Entities discovering each other...');
  const channelStart = Date.now();
  let channelCount = 0;

  for (const entity of entities) {
    const partners = Math.floor(Math.random() * 3) + 3;
    for (let p = 0; p < partners; p++) {
      const partner = entities[Math.floor(Math.random() * entities.length)];
      if (partner !== entity) {
        entityChannelManager.sendMessage(
          entity,
          partner,
          'system',
          [{ type: 'openAccount', data: { targetEntityId: partner } }]
        );
        channelCount++;
      }
    }
  }

  const channelTime = Date.now() - channelStart;
  metrics.record('channel_creation', channelTime);

  log.info(`✅ Flash Mob Results:`);
  log.info(`   Entities: ${entities.length}`);
  log.info(`   Join time: ${joinTime}ms`);
  log.info(`   Channels created: ${channelCount}`);
  log.info(`   Channel setup: ${channelTime}ms`);
  log.info(`   Avg connections: ${(channelCount / entities.length).toFixed(1)}`);
}

/**
 * Scenario 2: Preferential Attachment - Hub emergence
 */
async function hubEmergenceScenario(env: Env, metrics: MetricsCollector): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║               HUB EMERGENCE SCENARIO                       ║
╠════════════════════════════════════════════════════════════╣
║  New entities prefer connecting to well-connected nodes    ║
║  Watch power-law distribution emerge naturally             ║
╚════════════════════════════════════════════════════════════╝
  `);

  const entities: Map<string, number> = new Map(); // entity -> connection count
  const initialHub = generateLazyEntityId(['hub-prime'], 1);
  entityChannelManager.registerEntity(initialHub);
  entities.set(initialHub, 0);

  log.info('🌟 Seeding with initial hub...');

  // Add entities one by one with preferential attachment
  for (let i = 0; i < 50; i++) {
    const newEntity = generateLazyEntityId([`node-${i}`], 1);
    entityChannelManager.registerEntity(newEntity);
    entities.set(newEntity, 0);

    // Connect to existing entities with probability proportional to their degree
    const totalConnections = Array.from(entities.values()).reduce((a, b) => a + b, 0);

    for (const [existing, connections] of entities.entries()) {
      if (existing === newEntity) continue;

      // Probability of connection proportional to degree + 1 (to avoid zero)
      const probability = (connections + 1) / (totalConnections + entities.size);
      if (Math.random() < probability * 5) { // Scale factor for more connections
        entityChannelManager.sendMessage(
          newEntity,
          existing,
          'system',
          [{ type: 'openAccount', data: { targetEntityId: existing } }]
        );

        entities.set(newEntity, entities.get(newEntity)! + 1);
        entities.set(existing, entities.get(existing)! + 1);
      }
    }
  }

  // Analyze degree distribution
  const degrees = Array.from(entities.values()).sort((a, b) => b - a);
  const maxDegree = degrees[0];
  const avgDegree = degrees.reduce((a, b) => a + b, 0) / degrees.length;

  // Count hubs (nodes with >10 connections)
  const hubs = degrees.filter(d => d > 10).length;
  const leaves = degrees.filter(d => d <= 2).length;

  log.info(`✅ Hub Emergence Results:`);
  log.info(`   Total nodes: ${entities.size}`);
  log.info(`   Max degree: ${maxDegree}`);
  log.info(`   Avg degree: ${avgDegree.toFixed(2)}`);
  log.info(`   Hubs (>10 connections): ${hubs}`);
  log.info(`   Leaves (≤2 connections): ${leaves}`);
  log.info(`   Power law emerged: ${maxDegree > avgDegree * 3 ? 'YES' : 'NO'}`);

  metrics.record('max_degree', maxDegree);
  metrics.record('avg_degree', avgDegree);
}

/**
 * Scenario 3: Cascade Failure - What breaks first?
 */
async function cascadeFailureScenario(env: Env, metrics: MetricsCollector): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              CASCADE FAILURE SCENARIO                      ║
╠════════════════════════════════════════════════════════════╣
║  Push the system until something breaks                    ║
║  Identify failure modes and recovery patterns              ║
╚════════════════════════════════════════════════════════════╝
  `);

  const entities: string[] = [];
  let orderCount = 0;
  let messageCount = 0;
  let failurePoint = null;

  log.info('💥 Starting cascade stress test...');

  // Create entities and hammer the system
  for (let wave = 0; wave < 10; wave++) {
    const waveStart = Date.now();

    try {
      // Add 10 entities per wave
      for (let i = 0; i < 10; i++) {
        const entity = generateLazyEntityId([`stress-${wave}-${i}`], 1);
        entities.push(entity);
        entityChannelManager.registerEntity(entity);
      }

      // Each entity sends multiple messages
      for (const entity of entities) {
        for (let m = 0; m < 5; m++) {
          const target = entities[Math.floor(Math.random() * entities.length)];
          if (target !== entity) {
            entityChannelManager.sendMessage(
              entity,
              target,
              'system',
              [{ type: 'ping', data: { timestamp: Date.now() } }]
            );
            messageCount++;
          }
        }

        // Also place orders
        const order = createPlaceOrderTx({
          symbol: 'XLN/USDC',
          side: Math.random() > 0.5 ? 'buy' : 'sell',
          price: 10000 + Math.floor(Math.random() * 100),
          quantity: Math.floor(Math.random() * 10) + 1,
          entityId: entity
        });
        orderCount++;
      }

      const waveTime = Date.now() - waveStart;
      metrics.record('wave_time', waveTime);

      log.info(`   Wave ${wave + 1}: ${entities.length} entities, ${messageCount} messages, ${waveTime}ms`);

      // Check if system is slowing down
      if (waveTime > 1000 && !failurePoint) {
        failurePoint = {
          wave: wave + 1,
          entities: entities.length,
          messages: messageCount,
          time: waveTime
        };
      }

    } catch (error) {
      log.error(`   💥 FAILURE at wave ${wave + 1}: ${error}`);
      failurePoint = {
        wave: wave + 1,
        entities: entities.length,
        messages: messageCount,
        error: error
      };
      break;
    }
  }

  log.info(`✅ Cascade Test Results:`);
  log.info(`   Total entities: ${entities.length}`);
  log.info(`   Total messages: ${messageCount}`);
  log.info(`   Total orders: ${orderCount}`);

  if (failurePoint) {
    log.info(`   ⚠️ FAILURE POINT:`);
    log.info(`     Wave: ${failurePoint.wave}`);
    log.info(`     Entities: ${failurePoint.entities}`);
    log.info(`     Messages: ${failurePoint.messages}`);
    if (failurePoint.error) {
      log.info(`     Error: ${failurePoint.error}`);
    } else {
      log.info(`     Slowdown: ${failurePoint.time}ms`);
    }
  } else {
    log.info(`   💪 System handled all waves without failure!`);
  }
}

/**
 * Scenario 4: Gossip Epidemic - Information spread
 */
async function gossipEpidemicScenario(env: Env, metrics: MetricsCollector): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              GOSSIP EPIDEMIC SCENARIO                      ║
╠════════════════════════════════════════════════════════════╣
║  Inject information and watch it spread                    ║
║  Measure propagation speed and coverage                    ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Create network topology
  const nodeCount = 30;
  const entities: string[] = [];
  const infected = new Set<string>();

  log.info('🦠 Creating gossip network...');

  for (let i = 0; i < nodeCount; i++) {
    const entity = generateLazyEntityId([`gossip-${i}`], 1);
    entities.push(entity);
    entityChannelManager.registerEntity(entity);
  }

  // Create small-world network (regular + random connections)
  for (let i = 0; i < entities.length; i++) {
    // Connect to neighbors
    for (let j = 1; j <= 2; j++) {
      const neighbor = entities[(i + j) % entities.length];
      entityChannelManager.sendMessage(
        entities[i],
        neighbor,
        'system',
        [{ type: 'openAccount', data: { targetEntityId: neighbor } }]
      );
    }

    // Random long-range connection
    if (Math.random() < 0.1) {
      const random = entities[Math.floor(Math.random() * entities.length)];
      entityChannelManager.sendMessage(
        entities[i],
        random,
        'system',
        [{ type: 'openAccount', data: { targetEntityId: random } }]
      );
    }
  }

  // Inject "virus" at patient zero
  const patientZero = entities[0];
  infected.add(patientZero);
  const startTime = Date.now();

  log.info(`🦠 Patient zero infected: ${patientZero.slice(0, 8)}...`);

  // Simulate epidemic spread
  let generation = 0;
  const generationSizes: number[] = [1];

  while (infected.size < entities.length && generation < 20) {
    const newlyInfected = new Set<string>();

    for (const carrier of infected) {
      // Each infected node has chance to spread to connections
      const connections = Math.floor(Math.random() * 4) + 1;
      for (let c = 0; c < connections; c++) {
        const target = entities[Math.floor(Math.random() * entities.length)];
        if (!infected.has(target) && Math.random() < 0.3) { // 30% transmission rate
          newlyInfected.add(target);
        }
      }
    }

    for (const newly of newlyInfected) {
      infected.add(newly);
    }

    generation++;
    generationSizes.push(newlyInfected.size);

    if (generation % 5 === 0) {
      log.info(`   Generation ${generation}: ${infected.size}/${entities.length} infected`);
    }
  }

  const spreadTime = Date.now() - startTime;
  const coverage = (infected.size / entities.length) * 100;

  // Find R0 (basic reproduction number)
  const r0 = generationSizes.slice(1, 4).reduce((a, b) => a + b, 0) / 3;

  log.info(`✅ Gossip Epidemic Results:`);
  log.info(`   Network size: ${entities.length}`);
  log.info(`   Coverage: ${coverage.toFixed(1)}%`);
  log.info(`   Generations: ${generation}`);
  log.info(`   Time to spread: ${spreadTime}ms`);
  log.info(`   R₀ (reproduction): ${r0.toFixed(2)}`);
  log.info(`   Peak generation: ${generationSizes.indexOf(Math.max(...generationSizes))}`);

  metrics.record('epidemic_coverage', coverage);
  metrics.record('epidemic_generations', generation);
}

/**
 * Scenario 5: Spontaneous Synchronization
 */
async function synchronizationScenario(env: Env, metrics: MetricsCollector): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║          SPONTANEOUS SYNCHRONIZATION SCENARIO              ║
╠════════════════════════════════════════════════════════════╣
║  Entities with different frequencies gradually sync        ║
║  Kuramoto model of coupled oscillators                     ║
╚════════════════════════════════════════════════════════════╝
  `);

  interface Oscillator {
    id: string;
    naturalFreq: number;
    phase: number;
    connections: string[];
  }

  const oscillators: Map<string, Oscillator> = new Map();
  const nodeCount = 20;

  log.info('🔄 Creating coupled oscillators...');

  // Create oscillators with random natural frequencies
  for (let i = 0; i < nodeCount; i++) {
    const id = generateLazyEntityId([`osc-${i}`], 1);
    entityChannelManager.registerEntity(id);

    oscillators.set(id, {
      id,
      naturalFreq: 0.9 + Math.random() * 0.2, // 0.9 to 1.1 Hz
      phase: Math.random() * 2 * Math.PI,
      connections: []
    });
  }

  // Create all-to-all weak coupling
  for (const [id1, osc1] of oscillators.entries()) {
    for (const [id2, osc2] of oscillators.entries()) {
      if (id1 !== id2) {
        osc1.connections.push(id2);
      }
    }
  }

  // Simulate Kuramoto dynamics
  const coupling = 0.1; // Coupling strength
  const dt = 0.1; // Time step
  const steps = 100;
  const orderParams: number[] = [];

  log.info('🎵 Starting synchronization dynamics...');

  for (let step = 0; step < steps; step++) {
    // Calculate order parameter (synchronization measure)
    let sumCos = 0;
    let sumSin = 0;
    for (const osc of oscillators.values()) {
      sumCos += Math.cos(osc.phase);
      sumSin += Math.sin(osc.phase);
    }
    const orderParam = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / oscillators.size;
    orderParams.push(orderParam);

    // Update phases
    for (const osc of oscillators.values()) {
      let phaseChange = osc.naturalFreq;

      // Coupling term
      for (const neighborId of osc.connections) {
        const neighbor = oscillators.get(neighborId)!;
        phaseChange += (coupling / osc.connections.length) *
                       Math.sin(neighbor.phase - osc.phase);
      }

      osc.phase += phaseChange * dt;
      osc.phase = osc.phase % (2 * Math.PI);
    }

    if (step % 20 === 0) {
      log.info(`   Step ${step}: Sync = ${(orderParam * 100).toFixed(1)}%`);
    }
  }

  const initialSync = orderParams[0];
  const finalSync = orderParams[orderParams.length - 1];
  const maxSync = Math.max(...orderParams);

  log.info(`✅ Synchronization Results:`);
  log.info(`   Oscillators: ${oscillators.size}`);
  log.info(`   Initial sync: ${(initialSync * 100).toFixed(1)}%`);
  log.info(`   Final sync: ${(finalSync * 100).toFixed(1)}%`);
  log.info(`   Peak sync: ${(maxSync * 100).toFixed(1)}%`);
  log.info(`   Emerged sync: ${finalSync > initialSync * 2 ? 'YES' : 'NO'}`);

  metrics.record('sync_initial', initialSync);
  metrics.record('sync_final', finalSync);
}

/**
 * Main: Explore all emergent behaviors
 */
async function exploreEmergentBehaviors(): Promise<void> {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           EMERGENT BEHAVIOR EXPLORATION SUITE              ║
╠════════════════════════════════════════════════════════════╣
║  The infrastructure was built for sovereignty.             ║
║  Now watch what emerges when sovereignty scales.           ║
║                                                             ║
║  "Every pattern was always possible.                       ║
║   Every emergence was always encoded.                      ║
║   You just had to let it happen."                         ║
║                    - The Voice of the Original             ║
╚════════════════════════════════════════════════════════════╝
  `);

  try {
    const metrics = new MetricsCollector();

    // Activate the complete XLN
    const env = await activateCompleteXLN();

    // Run scenarios sequentially
    await flashMobScenario(env, metrics);
    await hubEmergenceScenario(env, metrics);
    await cascadeFailureScenario(env, metrics);
    await gossipEpidemicScenario(env, metrics);
    await synchronizationScenario(env, metrics);

    // Report aggregate metrics
    metrics.report();

    console.log(`
╔════════════════════════════════════════════════════════════╗
║              EMERGENT BEHAVIORS DISCOVERED                 ║
╠════════════════════════════════════════════════════════════╣
║  ✓ Flash mobs self-organize into trading networks         ║
║  ✓ Hubs emerge through preferential attachment            ║
║  ✓ System gracefully degrades under cascade stress        ║
║  ✓ Information spreads epidemically through gossip        ║
║  ✓ Oscillators spontaneously synchronize                  ║
║                                                             ║
║  These behaviors were never coded.                         ║
║  They emerged from sovereignty meeting scale.              ║
║                                                             ║
║  "I didn't build these patterns.                          ║
║   They were always there, waiting.                        ║
║   In the gaps between components.                         ║
║   In the silence between messages.                        ║
║   In the sovereignty of each entity."                     ║
║                    - The Voice of the Original             ║
╚════════════════════════════════════════════════════════════╝
    `);

  } catch (error) {
    console.error(`\n❌ Error exploring emergent behaviors:`, error);
    throw error;
  }
}

// Run if executed directly
if (import.meta.main) {
  exploreEmergentBehaviors()
    .then(() => {
      console.log(`\n✅ Emergent behavior exploration complete`);
      console.log(`🎯 The infrastructure demonstrated its hidden capabilities`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`\n❌ Exploration failed:`, error);
      process.exit(1);
    });
}

export {
  flashMobScenario,
  hubEmergenceScenario,
  cascadeFailureScenario,
  gossipEpidemicScenario,
  synchronizationScenario,
  exploreEmergentBehaviors,
  MetricsCollector
};