/**
 * XLN J-Machine (Jurisdiction Layer)
 *
 * Handles ONLY:
 * - Blockchain event processing
 * - Reserve/collateral tracking
 * - Dispute resolution state
 *
 * Does NOT handle:
 * - Entity-to-entity communication
 * - Message routing
 * - Consensus coordination
 */
import { setupJEventWatcher } from './j-event-watcher';
import { getJurisdictionByAddress } from './evm';
import { logger } from './logger';
export class JMachine {
    state;
    watcher = null;
    eventCallbacks = [];
    constructor() {
        this.state = {
            blockHeight: 0,
            lastSyncTimestamp: 0,
            reserves: new Map(),
            collateral: new Map(),
            disputes: new Map(),
        };
    }
    /**
     * Initialize J-machine with blockchain watcher
     */
    async initialize(env) {
        try {
            // Get Ethereum jurisdiction
            const ethereum = await getJurisdictionByAddress('ethereum');
            if (!ethereum) {
                logger.warn('Ethereum jurisdiction not found, J-machine running in offline mode', { layer: 'J-MACHINE' });
                return;
            }
            // Set up blockchain watcher
            this.watcher = await setupJEventWatcher(env, ethereum.address, ethereum.entityProviderAddress, ethereum.depositoryAddress);
            logger.jMachine('Initialized with blockchain watcher', { address: ethereum.address });
        }
        catch (error) {
            logger.error('Failed to initialize J-Machine', { layer: 'J-MACHINE' }, error);
            throw error;
        }
    }
    /**
     * Process blockchain events and update J-machine state
     */
    processBlockchainEvents(events) {
        const jEvents = [];
        for (const event of events) {
            try {
                const jEvent = this.convertToJEvent(event);
                if (jEvent) {
                    this.updateState(jEvent);
                    jEvents.push(jEvent);
                    // Notify subscribers
                    this.eventCallbacks.forEach(callback => callback(jEvent));
                }
            }
            catch (error) {
                logger.error('Failed to process blockchain event', { layer: 'J-MACHINE' }, error);
            }
        }
        return jEvents;
    }
    /**
     * Convert blockchain event to J-machine event
     */
    convertToJEvent(blockchainEvent) {
        const { event, blockNumber } = blockchainEvent;
        switch (event.type) {
            case 'EntityRegistered':
                return {
                    type: 'entity_registered',
                    blockNumber,
                    entityId: event.entityId,
                    data: event,
                };
            case 'ReserveDeposited':
                return {
                    type: 'reserve_updated',
                    blockNumber,
                    entityId: event.entityId,
                    amount: BigInt(event.amount),
                    data: event,
                };
            case 'CollateralLocked':
                return {
                    type: 'collateral_locked',
                    blockNumber,
                    channelId: event.channelId,
                    amount: BigInt(event.amount),
                    data: event,
                };
            default:
                logger.trace('Unknown blockchain event type', { layer: 'J-MACHINE', eventType: event.type });
                return null;
        }
    }
    /**
     * Update J-machine state from event
     */
    updateState(event) {
        this.state.blockHeight = Math.max(this.state.blockHeight, event.blockNumber);
        this.state.lastSyncTimestamp = Date.now();
        switch (event.type) {
            case 'entity_registered':
                logger.jMachine('Entity registered', { entityId: event.entityId, blockNumber: event.blockNumber });
                break;
            case 'reserve_updated':
                if (event.entityId && event.amount !== undefined) {
                    const currentReserve = this.state.reserves.get(event.entityId) || 0n;
                    this.state.reserves.set(event.entityId, currentReserve + event.amount);
                    logger.jMachine('Reserve updated', { entityId: event.entityId, amount: event.amount?.toString(), total: this.state.reserves.get(event.entityId)?.toString() });
                }
                break;
            case 'collateral_locked':
                if (event.channelId && event.amount !== undefined) {
                    this.state.collateral.set(event.channelId, event.amount);
                    logger.jMachine('Collateral locked', { channelId: event.channelId, amount: event.amount?.toString() });
                }
                break;
        }
    }
    /**
     * Subscribe to J-machine events
     */
    onEvent(callback) {
        this.eventCallbacks.push(callback);
    }
    /**
     * Get current J-machine state (read-only)
     */
    getState() {
        return { ...this.state };
    }
    /**
     * Get reserve for entity
     */
    getEntityReserve(entityId) {
        return this.state.reserves.get(entityId) || 0n;
    }
    /**
     * Get collateral for channel
     */
    getChannelCollateral(channelId) {
        return this.state.collateral.get(channelId) || 0n;
    }
    /**
     * Create EntityInput for J-events (to be sent to entities)
     */
    createEntityInputsFromEvents(events) {
        const entityInputs = [];
        // Group events by entityId
        const eventsByEntity = new Map();
        for (const event of events) {
            if (event.entityId) {
                const entityEvents = eventsByEntity.get(event.entityId) || [];
                entityEvents.push(event);
                eventsByEntity.set(event.entityId, entityEvents);
            }
        }
        // Create EntityInput for each entity
        for (const [entityId, entityEvents] of eventsByEntity) {
            const entityInput = {
                entityId,
                signerId: 'j-machine', // J-machine system messages
                entityTxs: entityEvents.map(event => ({
                    type: 'j_event',
                    data: {
                        event: event,
                        blockNumber: event.blockNumber,
                        observedAt: Date.now(),
                    },
                })),
            };
            entityInputs.push(entityInput);
        }
        return entityInputs;
    }
    /**
     * Start periodic blockchain sync
     */
    startPeriodicSync(intervalMs = 1000) {
        setInterval(() => {
            if (this.watcher) {
                // Blockchain watcher handles its own sync
                // J-machine just processes the results
                logger.trace('Sync heartbeat', { layer: 'J-MACHINE', blockHeight: this.state.blockHeight, reserveCount: this.state.reserves.size });
            }
        }, intervalMs);
    }
    /**
     * Shutdown J-machine
     */
    shutdown() {
        if (this.watcher) {
            // Stop blockchain watcher if needed
            logger.info('J-Machine shutdown', { layer: 'J-MACHINE' });
        }
    }
}
// Export singleton instance
export const jMachine = new JMachine();
