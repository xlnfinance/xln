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
export class EntityChannelManager {
    nodes = new Map();
    messageCallbacks = new Map();
    /**
     * Register entity node for direct communication
     */
    registerEntity(entityId) {
        if (this.nodes.has(entityId)) {
            return this.nodes.get(entityId);
        }
        const node = {
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
    getOrCreateChannel(localEntityId, remoteEntityId) {
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
    sendMessage(fromEntityId, toEntityId, signerId, entityTxs) {
        // Get or create outgoing channel
        const channel = this.getOrCreateChannel(fromEntityId, toEntityId);
        // Create message
        const message = {
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
    deliverMessage(message) {
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
    onMessage(entityId, callback) {
        this.messageCallbacks.set(entityId, callback);
    }
    /**
     * Get all pending messages for entity
     */
    getPendingMessages(entityId) {
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
    messageToEntityInput(message) {
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
    getChannelStatus(localEntityId, remoteEntityId) {
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
    getAllChannels() {
        const allChannels = new Map();
        for (const [entityId, node] of this.nodes) {
            const entityChannels = Array.from(node.channels.values());
            allChannels.set(entityId, entityChannels);
        }
        return allChannels;
    }
    /**
     * Broadcast message to multiple entities (fan-out)
     */
    broadcastMessage(fromEntityId, toEntityIds, signerId, entityTxs) {
        const messages = [];
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
    syncChannel(localEntityId, remoteEntityId) {
        const channel = this.getOrCreateChannel(localEntityId, remoteEntityId);
        channel.lastSyncTimestamp = Date.now();
        channel.connectionStatus = 'connected';
        console.log(`🔄 ENTITY-CHANNEL: Synced channel ${localEntityId.slice(0, 8)}... ↔ ${remoteEntityId.slice(0, 8)}...`);
    }
    /**
     * Get statistics for monitoring
     */
    getStats() {
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
