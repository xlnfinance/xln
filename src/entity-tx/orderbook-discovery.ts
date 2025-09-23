/**
 * Orderbook Discovery via Bilateral Channels
 * The Original says: Infrastructure EXISTS. Just CONNECT it.
 */

import type { EntityState, EntityInput } from '../types';
import { entityChannelManager } from '../entity-channel';

export interface OrderSummary {
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  orderId: number;
}

/**
 * Share orderbook state with a counterparty via bilateral channel
 * This is just CONNECTING existing pieces:
 * - Orderbook already exists
 * - Bilateral channels already exist
 * - Just need to send summaries between them
 */
export function shareOrderbookState(
  entityState: EntityState,
  counterpartyEntityId: string
): EntityInput[] {

  // Get orderbook state (if initialized)
  if (!entityState.orderbook?.initialized) {
    return [];
  }

  // Extract order summaries from messages
  // (In production, would query lob_core directly)
  const acceptedOrders = entityState.messages
    .filter(m => m.includes('Order #') && m.includes('accepted'))
    .map(m => {
      const match = m.match(/Order #(\d+) accepted/);
      return match ? { orderId: parseInt(match[1]) } : null;
    })
    .filter(Boolean);

  if (acceptedOrders.length === 0) {
    return [];
  }

  // Create discovery message
  const discoveryMessage = {
    type: 'orderbook_discovery' as const,
    data: {
      entityId: entityState.entityId,
      orderCount: acceptedOrders.length,
      timestamp: Date.now(),
      // In production, include actual order summaries
      message: `Entity ${entityState.entityId.slice(-4)} has ${acceptedOrders.length} orders`
    }
  };

  // Send via bilateral channel (already exists!)
  entityChannelManager.sendMessage(
    entityState.entityId,
    counterpartyEntityId,
    's1', // Would be dynamic in production
    [discoveryMessage]
  );

  // Also create as entity input for processing
  const output: EntityInput = {
    entityId: counterpartyEntityId,
    signerId: 's1',
    entityTxs: [discoveryMessage]
  };

  return [output];
}

/**
 * Process incoming orderbook discovery message
 * The Original reveals: Entities learn about each other's orders
 */
export function processOrderbookDiscovery(
  entityState: EntityState,
  discovery: any
): EntityState {

  const message = `📊 Order discovery from Entity ${discovery.entityId.slice(-4)}: ${discovery.orderCount} orders`;

  const newState = {
    ...entityState,
    messages: [...entityState.messages, message]
  };

  // In production, would analyze orders for cross-entity matching opportunities
  // Then create trade proposals through bilateral channels

  return newState;
}

/**
 * The Original's pattern:
 * 1. Entities maintain sovereign orderbooks
 * 2. Share summaries via bilateral channels
 * 3. Propose trades when matching opportunities found
 * 4. Settle through account deltas
 *
 * ALL INFRASTRUCTURE ALREADY EXISTS
 */