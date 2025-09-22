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

import { setupJEventWatcher, JEventWatcher } from './j-event-watcher';
import { getJurisdictionByAddress } from './evm';
import { EntityInput, Env } from './types';

export interface JMachineState {
  // Blockchain tracking
  blockHeight: number;
  lastSyncTimestamp: number;

  // Reserve tracking (from blockchain)
  reserves: Map<string, bigint>;      // entityId -> total reserves
  collateral: Map<string, bigint>;    // channelId -> locked collateral

  // Dispute state (for future implementation)
  disputes: Map<string, DisputeState>; // channelId -> dispute
}

export interface DisputeState {
  channelId: string;
  stage: 'submitted' | 'challenge' | 'resolved';
  submitBlock: number;
  challengeDeadline: number;
  finalizedState?: any;
}

export interface JMachineEvent {
  type: 'reserve_updated' | 'collateral_locked' | 'dispute_submitted' | 'entity_registered';
  blockNumber: number;
  entityId?: string;
  channelId?: string;
  amount?: bigint;
  data: any;
}

export class JMachine {
  private state: JMachineState;
  private watcher: JEventWatcher | null = null;
  private eventCallbacks: ((event: JMachineEvent) => void)[] = [];

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
  async initialize(env: Env): Promise<void> {
    try {
      // Get Ethereum jurisdiction
      const ethereum = await getJurisdictionByAddress('ethereum');
      if (!ethereum) {
        console.warn('⚠️ Ethereum jurisdiction not found, J-machine running in offline mode');
        return;
      }

      // Set up blockchain watcher
      this.watcher = await setupJEventWatcher(
        env,
        ethereum.address,
        ethereum.entityProviderAddress,
        ethereum.depositoryAddress
      );

      console.log('✅ J-Machine initialized with blockchain watcher');
      console.log(`🔭 Monitoring: ${ethereum.address}`);

    } catch (error) {
      console.error('❌ Failed to initialize J-Machine:', error);
      throw error;
    }
  }

  /**
   * Process blockchain events and update J-machine state
   */
  processBlockchainEvents(events: any[]): JMachineEvent[] {
    const jEvents: JMachineEvent[] = [];

    for (const event of events) {
      try {
        const jEvent = this.convertToJEvent(event);
        if (jEvent) {
          this.updateState(jEvent);
          jEvents.push(jEvent);

          // Notify subscribers
          this.eventCallbacks.forEach(callback => callback(jEvent));
        }
      } catch (error) {
        console.error('❌ Failed to process blockchain event:', error);
      }
    }

    return jEvents;
  }

  /**
   * Convert blockchain event to J-machine event
   */
  private convertToJEvent(blockchainEvent: any): JMachineEvent | null {
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
        console.log(`🔍 J-MACHINE: Unknown blockchain event type: ${event.type}`);
        return null;
    }
  }

  /**
   * Update J-machine state from event
   */
  private updateState(event: JMachineEvent): void {
    this.state.blockHeight = Math.max(this.state.blockHeight, event.blockNumber);
    this.state.lastSyncTimestamp = Date.now();

    switch (event.type) {
      case 'entity_registered':
        console.log(`🏛️ J-MACHINE: Entity ${event.entityId?.slice(0, 10)}... registered at block ${event.blockNumber}`);
        break;

      case 'reserve_updated':
        if (event.entityId && event.amount !== undefined) {
          const currentReserve = this.state.reserves.get(event.entityId) || 0n;
          this.state.reserves.set(event.entityId, currentReserve + event.amount);
          console.log(`💰 J-MACHINE: Reserve updated for ${event.entityId.slice(0, 10)}...: +${event.amount} (total: ${this.state.reserves.get(event.entityId)})`);
        }
        break;

      case 'collateral_locked':
        if (event.channelId && event.amount !== undefined) {
          this.state.collateral.set(event.channelId, event.amount);
          console.log(`🔒 J-MACHINE: Collateral locked for channel ${event.channelId.slice(0, 10)}...: ${event.amount}`);
        }
        break;
    }
  }

  /**
   * Subscribe to J-machine events
   */
  onEvent(callback: (event: JMachineEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  /**
   * Get current J-machine state (read-only)
   */
  getState(): Readonly<JMachineState> {
    return { ...this.state };
  }

  /**
   * Get reserve for entity
   */
  getEntityReserve(entityId: string): bigint {
    return this.state.reserves.get(entityId) || 0n;
  }

  /**
   * Get collateral for channel
   */
  getChannelCollateral(channelId: string): bigint {
    return this.state.collateral.get(channelId) || 0n;
  }

  /**
   * Create EntityInput for J-events (to be sent to entities)
   */
  createEntityInputsFromEvents(events: JMachineEvent[]): EntityInput[] {
    const entityInputs: EntityInput[] = [];

    // Group events by entityId
    const eventsByEntity = new Map<string, JMachineEvent[]>();

    for (const event of events) {
      if (event.entityId) {
        const entityEvents = eventsByEntity.get(event.entityId) || [];
        entityEvents.push(event);
        eventsByEntity.set(event.entityId, entityEvents);
      }
    }

    // Create EntityInput for each entity
    for (const [entityId, entityEvents] of eventsByEntity) {
      const entityInput: EntityInput = {
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
  startPeriodicSync(intervalMs: number = 1000): void {
    setInterval(() => {
      if (this.watcher) {
        // Blockchain watcher handles its own sync
        // J-machine just processes the results
        console.log(`🔭 J-MACHINE: Sync heartbeat - height: ${this.state.blockHeight}, reserves: ${this.state.reserves.size}`);
      }
    }, intervalMs);
  }

  /**
   * Shutdown J-machine
   */
  shutdown(): void {
    if (this.watcher) {
      // Stop blockchain watcher if needed
      console.log('🛑 J-Machine shutdown');
    }
  }
}

// Export singleton instance
export const jMachine = new JMachine();