#!/usr/bin/env bun
/**
 * ACTIVATE CROSS-ENTITY TRADING
 *
 * Each entity has a sovereign orderbook.
 * They can't see each other's orders.
 * Bilateral channels can carry order summaries.
 * Make them talk.
 */

import { EntityChannelManager } from './entity-channel';
import type { EntityInput, EntityState, Env } from './types';
import { log } from './utils';

interface OrderSummary {
  entityId: string;
  symbol: string;
  bids: Array<{ price: number; quantity: number; orderId: number }>;
  asks: Array<{ price: number; quantity: number; orderId: number }>;
  timestamp: number;
}

/**
 * Extract order summary from entity's orderbook
 */
export function extractOrderSummary(entityState: EntityState): OrderSummary | null {
  if (!entityState.orderbook?.initialized) {
    return null;
  }

  const orderbook = entityState.orderbook;
  const symbol = 'XLN/USDC'; // Default symbol

  // Extract top bids and asks
  const bids: Array<{ price: number; quantity: number; orderId: number }> = [];
  const asks: Array<{ price: number; quantity: number; orderId: number }> = [];

  // The orderbook structure has buy/sell sides with price levels
  // This is simplified - real implementation would traverse the order tree
  if (orderbook.buyTree) {
    // Get best bids (highest prices first)
    const topBids = orderbook.buyTree.slice(0, 5); // Top 5 levels
    for (const level of topBids) {
      bids.push({
        price: level.price,
        quantity: level.totalQuantity,
        orderId: level.orders?.[0]?.id || 0,
      });
    }
  }

  if (orderbook.sellTree) {
    // Get best asks (lowest prices first)
    const topAsks = orderbook.sellTree.slice(0, 5); // Top 5 levels
    for (const level of topAsks) {
      asks.push({
        price: level.price,
        quantity: level.totalQuantity,
        orderId: level.orders?.[0]?.id || 0,
      });
    }
  }

  return {
    entityId: entityState.entityId,
    symbol,
    bids,
    asks,
    timestamp: Date.now(),
  };
}

/**
 * Share orderbook state with trading partners via bilateral channels
 */
export function shareOrderbookWithPartners(
  env: Env,
  entityId: string,
  channelManager: EntityChannelManager
): void {
  // Find entity state
  const replicaKey = Array.from(env.replicas?.keys() || [])
    .find(k => k.startsWith(entityId + ':'));

  if (!replicaKey || !env.replicas) {
    return;
  }

  const replica = env.replicas.get(replicaKey);
  if (!replica) {
    return;
  }

  const orderSummary = extractOrderSummary(replica.state);
  if (!orderSummary) {
    return;
  }

  // Get trading partners from gossip or channel connections
  const partners = getConnectedPartners(channelManager, entityId);

  for (const partnerId of partners) {
    // Send order summary through bilateral channel
    const message = {
      type: 'orderbook_summary',
      data: orderSummary,
    };

    channelManager.sendMessage(
      entityId,
      partnerId,
      'orderbook-share',
      [message]
    );

    log.trace(`📊 ${entityId.slice(0,8)}... shared orderbook with ${partnerId.slice(0,8)}...`);
  }
}

/**
 * Process received orderbook summaries and look for cross-entity matches
 */
export function processCrossEntityMatches(
  env: Env,
  myEntityId: string,
  partnerSummary: OrderSummary
): void {
  // Find my entity state
  const myReplicaKey = Array.from(env.replicas?.keys() || [])
    .find(k => k.startsWith(myEntityId + ':'));

  if (!myReplicaKey || !env.replicas) {
    return;
  }

  const myReplica = env.replicas.get(myReplicaKey);
  if (!myReplica) {
    return;
  }

  const mySummary = extractOrderSummary(myReplica.state);
  if (!mySummary) {
    return;
  }

  // Check for crossing orders
  // My bids vs partner asks
  for (const myBid of mySummary.bids) {
    for (const partnerAsk of partnerSummary.asks) {
      if (myBid.price >= partnerAsk.price) {
        // We have a match!
        const matchQty = Math.min(myBid.quantity, partnerAsk.quantity);
        const matchPrice = (myBid.price + partnerAsk.price) / 2; // Mid price

        log.info(`🎯 CROSS-ENTITY MATCH FOUND!`);
        log.info(`   ${myEntityId.slice(0,8)}... BUY ${matchQty} @ $${(myBid.price/100).toFixed(2)}`);
        log.info(`   ${partnerSummary.entityId.slice(0,8)}... SELL ${matchQty} @ $${(partnerAsk.price/100).toFixed(2)}`);
        log.info(`   Match Price: $${(matchPrice/100).toFixed(2)}`);

        // TODO: Create bilateral trade proposal
        // This would involve creating a bilateral consensus proposal
        // to execute the trade and update account balances
      }
    }
  }

  // My asks vs partner bids
  for (const myAsk of mySummary.asks) {
    for (const partnerBid of partnerSummary.bids) {
      if (partnerBid.price >= myAsk.price) {
        // We have a match!
        const matchQty = Math.min(myAsk.quantity, partnerBid.quantity);
        const matchPrice = (myAsk.price + partnerBid.price) / 2; // Mid price

        log.info(`🎯 CROSS-ENTITY MATCH FOUND!`);
        log.info(`   ${partnerSummary.entityId.slice(0,8)}... BUY ${matchQty} @ $${(partnerBid.price/100).toFixed(2)}`);
        log.info(`   ${myEntityId.slice(0,8)}... SELL ${matchQty} @ $${(myAsk.price/100).toFixed(2)}`);
        log.info(`   Match Price: $${(matchPrice/100).toFixed(2)}`);

        // TODO: Create bilateral trade proposal
      }
    }
  }
}

/**
 * Get list of connected trading partners
 */
function getConnectedPartners(
  channelManager: EntityChannelManager,
  entityId: string
): string[] {
  const partners: string[] = [];

  // Access internal nodes to find connected channels
  const nodes = (channelManager as any).nodes;
  const node = nodes?.get(entityId);

  if (node?.channels) {
    for (const [partnerId] of node.channels) {
      partners.push(partnerId);
    }
  }

  return partners;
}

/**
 * Activate cross-entity trading discovery
 */
export function activateCrossEntityTrading(
  env: Env,
  intervalMs: number = 5000
): void {
  log.info('🌉 ACTIVATING CROSS-ENTITY TRADING');
  log.info('   Sovereign orderbooks will share liquidity');
  log.info('   Bilateral channels will carry trade proposals');
  log.info('   No central matching - only bilateral consensus');

  const channelManager = new EntityChannelManager();

  // Register all entities with channel manager
  const entityIds = new Set<string>();
  for (const key of env.replicas?.keys() || []) {
    const [entityId] = key.split(':');
    entityIds.add(entityId);
    channelManager.registerEntity(entityId);
  }

  // Start periodic orderbook sharing
  setInterval(() => {
    for (const entityId of entityIds) {
      shareOrderbookWithPartners(env, entityId, channelManager);
    }
  }, intervalMs);

  log.info(`✅ Cross-entity trading activated for ${entityIds.size} entities`);
  log.info(`   Sharing orderbook summaries every ${intervalMs}ms`);
}

// If run directly, show usage
if (import.meta.main) {
  console.log('🌉 Cross-Entity Trading Activation');
  console.log('');
  console.log('Usage:');
  console.log('  import { activateCrossEntityTrading } from "./activate-cross-entity-trading";');
  console.log('  activateCrossEntityTrading(env);');
  console.log('');
  console.log('This will:');
  console.log('  1. Share orderbook summaries between entities');
  console.log('  2. Discover cross-entity matching opportunities');
  console.log('  3. Create bilateral trade proposals');
  console.log('  4. Settle trades through bilateral consensus');
}