/**
 * XLN Entity Channel System
 *
 * Implements direct entity-to-entity communication channels.
 * Replaces global coordinator pattern with bilateral sovereignty.
 *
 * Key Principles:
 * - Entities communicate directly (no central server)
 * - Each entity-pair has dedicated bilateral channel
 * - Messages delivered point-to-point
 * - No global state coordination
 */

import { EntityInput, EntityTx } from './types';

export interface EntityMessage {
  fromEntityId: string;
  toEntityId: string;
  signerId: string;
  entityTxs: EntityTx[];
  timestamp: number;
  messageId: string;
  sequenceNumber: number;
}

export interface EntityChannel {
  // Channel identity
  localEntityId: string;
  remoteEntityId: string;

  // Message queues (bilateral)
  outgoingMessages: EntityMessage[];  // Messages TO remote entity
  incomingMessages: EntityMessage[];  // Messages FROM remote entity

  // Sequence tracking
  nextOutgoingSeq: number;
  lastIncomingSeq: number;

  // Sync state
  lastSyncTimestamp: number;
  connectionStatus: 'connected' | 'disconnected' | 'syncing';
}

export interface EntityNode {
  entityId: string;

  // Direct channels to other entities
  channels: Map<string, EntityChannel>;  // remoteEntityId -> channel

  // Local message processing
  incomingQueue: EntityMessage[];
  processingQueue: EntityMessage[];
}

export class EntityChannelManager {
  private nodes: Map<string, EntityNode> = new Map();
  private messageCallbacks: Map<string, (message: EntityMessage) => void> = new Map();

  /**
   * Register entity node for direct communication
   */
  registerEntity(entityId: string): EntityNode {
    if (this.nodes.has(entityId)) {
      return this.nodes.get(entityId)!;
    }

    const node: EntityNode = {
      entityId,
      channels: new Map(),
      incomingQueue: [],
      processingQueue: [],
    };

    this.nodes.set(entityId, node);
    console.log(`📡 ENTITY-CHANNEL: Registered entity ${entityId.slice(0, 10)}... for direct communication`);

    return node;
  }

  /**
   * Create or get bilateral channel between two entities
   */
  getOrCreateChannel(localEntityId: string, remoteEntityId: string): EntityChannel {
    const localNode = this.nodes.get(localEntityId);
    if (!localNode) {
      throw new Error(`Entity ${localEntityId} not registered`);
    }

    let channel = localNode.channels.get(remoteEntityId);
    if (!channel) {
      channel = {
        localEntityId,
        remoteEntityId,
        outgoingMessages: [],
        incomingMessages: [],
        nextOutgoingSeq: 1,
        lastIncomingSeq: 0,
        lastSyncTimestamp: 0,
        connectionStatus: 'disconnected',
      };

      localNode.channels.set(remoteEntityId, channel);
      console.log(`🔗 ENTITY-CHANNEL: Created bilateral channel ${localEntityId.slice(0, 8)}... ↔ ${remoteEntityId.slice(0, 8)}...`);
    }

    return channel;
  }

  /**
   * Send message directly from one entity to another (bilateral)
   */
  sendMessage(
    fromEntityId: string,
    toEntityId: string,
    signerId: string,
    entityTxs: EntityTx[]
  ): EntityMessage {
    // Get or create outgoing channel
    const channel = this.getOrCreateChannel(fromEntityId, toEntityId);

    // Create message
    const message: EntityMessage = {
      fromEntityId,
      toEntityId,
      signerId,
      entityTxs,
      timestamp: Date.now(),
      messageId: `${fromEntityId}:${toEntityId}:${channel.nextOutgoingSeq}`,
      sequenceNumber: channel.nextOutgoingSeq,
    };

    // Add to outgoing queue
    channel.outgoingMessages.push(message);
    channel.nextOutgoingSeq++;

    console.log(`📤 ENTITY-CHANNEL: ${fromEntityId.slice(0, 8)}... → ${toEntityId.slice(0, 8)}... (seq: ${message.sequenceNumber}, txs: ${entityTxs.length})`);

    // Deliver message immediately (in-memory simulation)
    this.deliverMessage(message);

    return message;
  }

  /**
   * Deliver message to target entity (simulates P2P delivery)
   */
  private deliverMessage(message: EntityMessage): void {
    const targetNode = this.nodes.get(message.toEntityId);
    if (!targetNode) {
      console.warn(`⚠️ ENTITY-CHANNEL: Target entity ${message.toEntityId} not registered for message delivery`);
      return;
    }

    // Get or create incoming channel
    const channel = this.getOrCreateChannel(message.toEntityId, message.fromEntityId);

    // Add to incoming queue
    channel.incomingMessages.push(message);
    targetNode.incomingQueue.push(message);

    console.log(`📥 ENTITY-CHANNEL: ${message.toEntityId.slice(0, 8)}... ← ${message.fromEntityId.slice(0, 8)}... (seq: ${message.sequenceNumber})`);

    // Notify message callback if registered
    const callback = this.messageCallbacks.get(message.toEntityId);
    if (callback) {
      callback(message);
    }
  }

  /**
   * Register callback for incoming messages to entity
   */
  onMessage(entityId: string, callback: (message: EntityMessage) => void): void {
    this.messageCallbacks.set(entityId, callback);
  }

  /**
   * Get all pending messages for entity
   */
  getPendingMessages(entityId: string): EntityMessage[] {
    const node = this.nodes.get(entityId);
    if (!node) {
      return [];
    }

    const messages = [...node.incomingQueue];
    node.incomingQueue = []; // Clear queue after retrieval
    return messages;
  }

  /**
   * Convert EntityMessage to EntityInput for processing
   */
  messageToEntityInput(message: EntityMessage): EntityInput {
    return {
      entityId: message.toEntityId,
      signerId: message.signerId,
      entityTxs: message.entityTxs,
      // Include metadata for bilateral tracking
      metadata: {
        fromEntityId: message.fromEntityId,
        messageId: message.messageId,
        sequenceNumber: message.sequenceNumber,
        timestamp: message.timestamp,
      },
    };
  }

  /**
   * Get channel status between two entities
   */
  getChannelStatus(localEntityId: string, remoteEntityId: string): {
    exists: boolean;
    outgoingCount: number;
    incomingCount: number;
    lastSync: number;
    status: string;
  } {
    const node = this.nodes.get(localEntityId);
    if (!node) {
      return { exists: false, outgoingCount: 0, incomingCount: 0, lastSync: 0, status: 'no_node' };
    }

    const channel = node.channels.get(remoteEntityId);
    if (!channel) {
      return { exists: false, outgoingCount: 0, incomingCount: 0, lastSync: 0, status: 'no_channel' };
    }

    return {
      exists: true,
      outgoingCount: channel.outgoingMessages.length,
      incomingCount: channel.incomingMessages.length,
      lastSync: channel.lastSyncTimestamp,
      status: channel.connectionStatus,
    };
  }

  /**
   * Get all channels for debugging
   */
  getAllChannels(): Map<string, EntityChannel[]> {
    const allChannels = new Map<string, EntityChannel[]>();

    for (const [entityId, node] of this.nodes) {
      const entityChannels = Array.from(node.channels.values());
      allChannels.set(entityId, entityChannels);
    }

    return allChannels;
  }

  /**
   * Broadcast message to multiple entities (fan-out)
   */
  broadcastMessage(
    fromEntityId: string,
    toEntityIds: string[],
    signerId: string,
    entityTxs: EntityTx[]
  ): EntityMessage[] {
    const messages: EntityMessage[] = [];

    for (const toEntityId of toEntityIds) {
      const message = this.sendMessage(fromEntityId, toEntityId, signerId, entityTxs);
      messages.push(message);
    }

    console.log(`📡 ENTITY-CHANNEL: Broadcast from ${fromEntityId.slice(0, 8)}... to ${toEntityIds.length} entities`);
    return messages;
  }

  /**
   * Sync channel state (for future P2P networking)
   */
  syncChannel(localEntityId: string, remoteEntityId: string): void {
    const channel = this.getOrCreateChannel(localEntityId, remoteEntityId);
    channel.lastSyncTimestamp = Date.now();
    channel.connectionStatus = 'connected';

    console.log(`🔄 ENTITY-CHANNEL: Synced channel ${localEntityId.slice(0, 8)}... ↔ ${remoteEntityId.slice(0, 8)}...`);
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): {
    totalNodes: number;
    totalChannels: number;
    totalMessages: number;
    activeChannels: number;
  } {
    let totalChannels = 0;
    let totalMessages = 0;
    let activeChannels = 0;

    for (const node of this.nodes.values()) {
      totalChannels += node.channels.size;

      for (const channel of node.channels.values()) {
        totalMessages += channel.outgoingMessages.length + channel.incomingMessages.length;
        if (channel.connectionStatus === 'connected') {
          activeChannels++;
        }
      }
    }

    return {
      totalNodes: this.nodes.size,
      totalChannels,
      totalMessages,
      activeChannels,
    };
  }
}

// Export singleton instance
export const entityChannelManager = new EntityChannelManager();