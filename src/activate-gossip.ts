#!/usr/bin/env bun
/**
 * Activate Gossip Layer - Entities discover each other!
 *
 * The gossip layer exists complete but disconnected.
 * This activation script wires it into the server.
 */

import { createGossipLayer, type Profile } from './gossip';
import type { Env } from './types';

// Global gossip instance
const gossip = createGossipLayer();

/**
 * Announce entity capabilities based on their activity
 */
export function announceEntityCapabilities(entityId: string, capabilities: string[]) {
  const profile: Profile = {
    entityId,
    capabilities,
    hubs: [],
    metadata: {
      lastUpdated: Date.now(),
      version: '1.0.0',
    }
  };

  gossip.announce(profile);
  console.log(`📡 Entity ${entityId.slice(0,8)}... announced: [${capabilities.join(', ')}]`);
}

/**
 * Auto-discover capabilities from entity state
 */
export function discoverCapabilities(env: Env, entityId: string): string[] {
  const capabilities: string[] = [];

  // Check if entity has reserves
  for (const [key, replica] of env.replicas) {
    const [eid] = key.split(':');
    if (eid === entityId && replica.state) {
      // Has reserves? Can trade
      if (replica.state.reserves?.size > 0) {
        capabilities.push('trader');
        capabilities.push('liquidity-provider');
      }

      // Has orderbook? Market maker
      if (replica.state.orderbook?.initialized) {
        capabilities.push('market-maker');
        capabilities.push('orderbook-operator');
      }

      // Has proposals? Governance participant
      if (replica.state.proposals?.size > 0) {
        capabilities.push('governance');
      }

      // Has channels? Bilateral trader
      if (replica.state.financialState?.channels?.size > 0) {
        capabilities.push('bilateral-trading');
      }

      break;
    }
  }

  // Default capability
  if (capabilities.length === 0) {
    capabilities.push('entity');
  }

  return capabilities;
}

/**
 * Find entities with specific capabilities
 */
export function findEntitiesWithCapability(capability: string): Profile[] {
  return gossip.getProfiles().filter(p =>
    p.capabilities.includes(capability)
  );
}

/**
 * Find trading partners for an entity
 */
export function findTradingPartners(entityId: string): Profile[] {
  const tradingCapabilities = ['trader', 'market-maker', 'liquidity-provider', 'bilateral-trading'];

  return gossip.getProfiles().filter(p =>
    p.entityId !== entityId &&
    p.capabilities.some(c => tradingCapabilities.includes(c))
  );
}

/**
 * Activate gossip discovery in server tick
 */
export function activateGossipDiscovery(env: Env) {
  console.log(`
╔════════════════════════════════════════════════╗
║          GOSSIP LAYER ACTIVATION               ║
╠════════════════════════════════════════════════╣
║  Entities discover each other!                 ║
║  No central coordination needed.               ║
║  Capabilities emerge from activity.            ║
╚════════════════════════════════════════════════╝
  `);

  // Discover and announce all existing entities
  const entityIds = new Set<string>();
  for (const key of env.replicas.keys()) {
    const [entityId] = key.split(':');
    entityIds.add(entityId);
  }

  for (const entityId of entityIds) {
    const capabilities = discoverCapabilities(env, entityId);
    announceEntityCapabilities(entityId, capabilities);
  }

  // Show discovery results
  const traders = findEntitiesWithCapability('trader');
  const marketMakers = findEntitiesWithCapability('market-maker');
  const bilateralTraders = findEntitiesWithCapability('bilateral-trading');

  console.log(`
📊 Discovery Results:
  - ${gossip.getProfiles().length} entities discovered
  - ${traders.length} traders
  - ${marketMakers.length} market makers
  - ${bilateralTraders.length} bilateral traders
  `);

  // Show potential trading pairs
  for (const entityId of entityIds) {
    const partners = findTradingPartners(entityId);
    if (partners.length > 0) {
      console.log(`🤝 ${entityId.slice(0,8)}... can trade with ${partners.length} partners`);
    }
  }
}

/**
 * Create trading network visualization
 */
export function visualizeTradingNetwork(): string {
  const profiles = gossip.getProfiles();

  if (profiles.length === 0) return 'No entities discovered yet';

  let viz = '\n🌐 TRADING NETWORK:\n\n';

  for (const profile of profiles) {
    const id = profile.entityId.slice(0,8);
    const caps = profile.capabilities.slice(0,3).join(', ');
    viz += `  [${id}...] ${caps}\n`;

    // Find connections
    const partners = findTradingPartners(profile.entityId);
    for (const partner of partners.slice(0,3)) {
      viz += `    ↔ ${partner.entityId.slice(0,8)}...\n`;
    }
  }

  return viz;
}

// Export for use in server
export { gossip };

// If run directly, show status
if (import.meta.main) {
  console.log('📡 Gossip Layer Status');
  console.log('Currently:', gossip.getProfiles().length, 'entities discovered');
  console.log('\nTo activate in server.ts:');
  console.log('  import { activateGossipDiscovery } from "./activate-gossip";');
  console.log('  activateGossipDiscovery(env);');
  console.log('\nTo find trading partners:');
  console.log('  import { findTradingPartners } from "./activate-gossip";');
  console.log('  const partners = findTradingPartners(entityId);');
}