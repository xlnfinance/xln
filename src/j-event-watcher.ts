/**
 * J-Machine Event Watcher
 *
 * MVP implementation that watches for jurisdiction events (EntityProvider.sol, Depository.sol)
 * and automatically submits them to the corresponding entity machines.
 *
 * This enables the j-machine ↔ e-machine event flow where:
 * - All signers listen to their jurisdiction locally
 * - When they see new events, they make entity transactions about what they observed
 * - Uses Hanko signatures for all on-entity-behalf transactions
 */

import { ethers } from 'ethers';

import type { EntityTx, Env } from './types.js';

// Debug flag for logging
const DEBUG = true;
const HEAVY_LOGS = true; // Extra verbose logging for sync debugging

// Event types we care about from the jurisdiction
interface JurisdictionEvent {
  type: 'entity_registered' | 'control_shares_released' | 'shares_received' | 'name_assigned' | 'reserve_updated' | 'reserve_transferred' | 'settlement_processed';
  blockNumber: number;
  transactionHash: string;
  entityId?: string;
  entityNumber?: number;
  data: any;
}

interface WatcherConfig {
  rpcUrl: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  startBlock?: number;
}

interface SignerConfig {
  signerId: string;
  privateKey: string;
  entityIds: string[]; // Which entities this signer cares about
}

export class JEventWatcher {
  private provider: ethers.JsonRpcProvider;
  private entityProviderContract: ethers.Contract;
  private depositoryContract: ethers.Contract;
  private config: WatcherConfig;
  private signers: Map<string, SignerConfig> = new Map();
  private lastProcessedBlock: number = 0;
  private syncInProgress: boolean = false;
  private isWatching: boolean = false;

  // Contract ABIs (minimal for events we care about)
  private entityProviderABI = [
    'event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)',
    'event ControlSharesReleased(bytes32 indexed entityId, address indexed depository, uint256 controlAmount, uint256 dividendAmount, string purpose)',
    'event NameAssigned(string indexed name, uint256 indexed entityNumber)',
  ];

  private depositoryABI = [
    'event ControlSharesReceived(address indexed entityProvider, address indexed fromEntity, uint256 indexed tokenId, uint256 amount, bytes data)',
    'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
    'event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint256 indexed tokenId, uint256 amount)',
    'event SettlementProcessed(bytes32 indexed leftEntity, bytes32 indexed rightEntity, uint256 indexed tokenId, uint256 leftReserve, uint256 rightReserve, uint256 collateral, int256 ondelta)',
  ];

  constructor(config: WatcherConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    this.entityProviderContract = new ethers.Contract(
      config.entityProviderAddress,
      this.entityProviderABI,
      this.provider,
    );

    this.depositoryContract = new ethers.Contract(config.depositoryAddress, this.depositoryABI, this.provider);

    this.lastProcessedBlock = config.startBlock || 0;
  }

  /**
   * Add a signer configuration for monitoring
   */
  addSigner(signerId: string, privateKey: string, entityIds: string[]) {
    this.signers.set(signerId, {
      signerId,
      privateKey,
      entityIds,
    });

    if (DEBUG) {
      console.log(`🔭 J-WATCHER: Added signer ${signerId} monitoring entities: ${entityIds.join(', ')}`);
    }
  }

  /**
   * Start watching for jurisdiction events
   */
  async startWatching(env: Env): Promise<void> {
    if (this.isWatching) {
      console.log('🔭 J-WATCHER: Already watching');
      return;
    }

    this.isWatching = true;
    
    // Initialize from current block - 10 for new watchers, entities manage their own jBlock
    const currentBlock = await this.provider.getBlockNumber();
    this.lastProcessedBlock = Math.max(0, currentBlock - 10);

    console.log(`🔭 J-WATCHER: Starting from block ${this.lastProcessedBlock}`);

    // Set up event listeners for real-time events
    this.setupEventListeners(env);

    // Process any historical events we missed
    await this.processHistoricalEvents(env);

    // Sync historical events for entities with jBlock=0
    await this.syncHistoricalEventsForNewEntities(env);

    // Start periodic sync every 500ms
    this.startPeriodicSync(env);

    // Start continuous entity monitoring every 1 second
    this.startContinuousEntityMonitoring(env);

    console.log(`🔭 J-WATCHER: Monitoring J-machine from block ${this.lastProcessedBlock}`);
  }

  /**
   * Start periodic sync to catch new events
   */
  private startPeriodicSync(env: Env): void {
    setInterval(async () => {
      if (!this.isWatching || this.syncInProgress) {
        return;
      }
      
      try {
        this.syncInProgress = true;
        await this.syncNewEvents(env);
        
      } catch (error) {
        console.error('🔭❌ J-WATCHER: Error during periodic sync:', error);
      } finally {
        this.syncInProgress = false;
      }
    }, 500); // Sync every 500ms
  }

  /**
   * Sync only new events since last processed block
   */
  private async syncNewEvents(env: Env): Promise<void> {
    const currentBlock = await this.provider.getBlockNumber();
    
    if (currentBlock <= this.lastProcessedBlock) {
      // Completely silent when no new blocks
      return;
    }

    const newBlocks = currentBlock - this.lastProcessedBlock;
    let totalEventsProcessed = 0;

    // Process new blocks in batches
    const batchSize = 100;
    for (let fromBlock = this.lastProcessedBlock + 1; fromBlock <= currentBlock; fromBlock += batchSize) {
      const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);
      
      const eventsInBatch = await this.processBlockRange(fromBlock, toBlock, env);
      totalEventsProcessed += eventsInBatch;
    }

    // Update local last processed block
    this.lastProcessedBlock = currentBlock;
    
    // Only log if we actually found events
    if (totalEventsProcessed > 0) {
      console.log(`🔭⚡ J-MACHINE SYNC: Found ${totalEventsProcessed} events in ${newBlocks} new blocks (now at J-block ${currentBlock})`);
    }
  }

  /**
   * Stop watching
   */
  stopWatching(): void {
    this.isWatching = false;
    this.entityProviderContract.removeAllListeners();
    this.depositoryContract.removeAllListeners();
    console.log('🔭 J-WATCHER: Stopped watching');
  }

  /**
   * Set up real-time event listeners
   */
  private setupEventListeners(env: Env): void {
    // EntityProvider events
    this.entityProviderContract.on('EntityRegistered', (entityId, entityNumber, boardHash, event) => {
      this.handleJurisdictionEvent(
        {
          type: 'entity_registered',
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          entityId: entityId.toString(),
          entityNumber: Number(entityNumber),
          data: { boardHash },
        },
        env,
      );
    });

    this.entityProviderContract.on(
      'ControlSharesReleased',
      (entityId, depository, controlAmount, dividendAmount, purpose, event) => {
        this.handleJurisdictionEvent(
          {
            type: 'control_shares_released',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityId: entityId.toString(),
            entityNumber: Number(entityId), // entityId is the number for registered entities
            data: { depository, controlAmount, dividendAmount, purpose },
          },
          env,
        );
      },
    );

    this.entityProviderContract.on('NameAssigned', (name, entityNumber, event) => {
      this.handleJurisdictionEvent(
        {
          type: 'name_assigned',
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          entityNumber: Number(entityNumber),
          data: { name },
        },
        env,
      );
    });

    // Depository events
    this.depositoryContract.on('ControlSharesReceived', (entityProvider, fromEntity, tokenId, amount, data, event) => {
      // Extract entity number from tokenId (control tokens use entity number directly)
      const entityNumber = this.extractEntityNumberFromTokenId(Number(tokenId));

      this.handleJurisdictionEvent(
        {
          type: 'shares_received',
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          entityNumber: entityNumber,
          data: { entityProvider, fromEntity, tokenId, amount, data },
        },
        env,
      );
    });

    // Reserve events from Depository
    this.depositoryContract.on('ReserveUpdated', (entity, tokenId, newBalance, event) => {
      this.handleReserveUpdatedEvent(entity, tokenId, newBalance, event, env);
    });

    this.depositoryContract.on('ReserveTransferred', (from, to, tokenId, amount, event) => {
      // Handle transfer events for both sender and receiver entities
      const fromEntityNumber = Number(from);
      const toEntityNumber = Number(to);
      
      // Submit event for sender entity
      this.handleJurisdictionEvent(
        {
          type: 'reserve_transferred',
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          entityNumber: fromEntityNumber,
          data: { from, to, tokenId: Number(tokenId), amount: amount.toString(), direction: 'sent' },
        },
        env,
      );
      
      // Submit event for receiver entity  
      this.handleJurisdictionEvent(
        {
          type: 'reserve_transferred',
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          entityNumber: toEntityNumber,
          data: { from, to, tokenId: Number(tokenId), amount: amount.toString(), direction: 'received' },
        },
        env,
      );
    });

    // Settlement events from Depository
    this.depositoryContract.on('SettlementProcessed', (leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral, ondelta, event) => {
      this.handleSettlementProcessedEvent(leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral, ondelta, event, env);
    });
  }

  /**
   * Process historical events since last processed block
   */
  private async processHistoricalEvents(env: Env): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (this.lastProcessedBlock >= currentBlock) {
        if (HEAVY_LOGS) console.log('🔭⏸️  J-WATCHER: No historical blocks to process');
        return;
      }

      const blocksToProcess = currentBlock - this.lastProcessedBlock;
      if (HEAVY_LOGS) {
        console.log(`🔭📚 J-WATCHER HISTORICAL: Processing ${blocksToProcess} blocks (${this.lastProcessedBlock + 1} → ${currentBlock})`);
      }

      // Get events in batches to avoid RPC limits
      const batchSize = 1000;
      for (let fromBlock = this.lastProcessedBlock + 1; fromBlock <= currentBlock; fromBlock += batchSize) {
        const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);

        if (HEAVY_LOGS) {
          console.log(`🔭📦 J-WATCHER HISTORICAL: Batch ${fromBlock} → ${toBlock}`);
        }

        await this.processBlockRange(fromBlock, toBlock, env);
      }

      this.lastProcessedBlock = currentBlock;
      
      if (HEAVY_LOGS) {
        console.log(`🔭✅ J-WATCHER HISTORICAL: Completed! Processed ${blocksToProcess} blocks`);
      }
    } catch (error) {
      console.error('🔭❌ J-WATCHER: Error processing historical events:', error);
    }
  }

  /**
   * Process events in a specific block range
   * @returns number of events processed
   */
  private async processBlockRange(fromBlock: number, toBlock: number, env: Env): Promise<number> {
    try {
      // For new entities with jBlock=0, we need to get ALL historical events for their entityId
      const entityFilters = this.getEntityFiltersForHistoricalSync(env, fromBlock);
      
      // Get all relevant events from both contracts by querying specific events
      const [
        entityRegisteredEvents,
        controlSharesReleasedEvents,
        nameAssignedEvents,
        controlSharesReceivedEvents,
        reserveUpdatedEvents,
        reserveTransferredEvents,
        settlementProcessedEvents
      ] = await Promise.all([
        this.entityProviderContract.queryFilter(this.entityProviderContract.filters.EntityRegistered(), fromBlock, toBlock),
        this.entityProviderContract.queryFilter(this.entityProviderContract.filters.ControlSharesReleased(), fromBlock, toBlock),
        this.entityProviderContract.queryFilter(this.entityProviderContract.filters.NameAssigned(), fromBlock, toBlock),
        this.depositoryContract.queryFilter(this.depositoryContract.filters.ControlSharesReceived(), fromBlock, toBlock),
        this.depositoryContract.queryFilter(this.depositoryContract.filters.ReserveUpdated(), fromBlock, toBlock),
        this.depositoryContract.queryFilter(this.depositoryContract.filters.ReserveTransferred(), fromBlock, toBlock),
        this.depositoryContract.queryFilter(this.depositoryContract.filters.SettlementProcessed(), fromBlock, toBlock),
      ]);

      // Combine all events and sort chronologically
      const allEvents = [
        ...entityRegisteredEvents,
        ...controlSharesReleasedEvents, 
        ...nameAssignedEvents,
        ...controlSharesReceivedEvents,
        ...reserveUpdatedEvents,
        ...reserveTransferredEvents,
        ...settlementProcessedEvents
      ].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return a.transactionIndex - b.transactionIndex;
      });

      // Only log if we found events
      if (allEvents.length > 0) {
        console.log(`🔭⚡ J-WATCHER: Processing ${allEvents.length} events from blocks ${fromBlock}-${toBlock}`);
        for (const event of allEvents) {
          await this.processContractEvent(event, env);
        }
      }
      
      return allEvents.length;
    } catch (error) {
      console.error(`🔭❌ J-WATCHER: Error processing blocks ${fromBlock}-${toBlock}:`, error);
      return 0;
    }
  }

  /**
   * Process a single contract event
   */
  private async processContractEvent(event: any, env: Env): Promise<void> {
    try {
      let jurisdictionEvent: JurisdictionEvent;

      switch (event.eventName || event.event) {
        case 'EntityRegistered':
          jurisdictionEvent = {
            type: 'entity_registered',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityId: event.args.entityId.toString(),
            entityNumber: Number(event.args.entityNumber),
            data: { boardHash: event.args.boardHash },
          };
          break;

        case 'ControlSharesReleased':
          jurisdictionEvent = {
            type: 'control_shares_released',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityId: event.args.entityId.toString(),
            entityNumber: Number(event.args.entityId),
            data: {
              depository: event.args.depository,
              controlAmount: event.args.controlAmount.toString(),
              dividendAmount: event.args.dividendAmount.toString(),
              purpose: event.args.purpose,
            },
          };
          break;

        case 'NameAssigned':
          jurisdictionEvent = {
            type: 'name_assigned',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityNumber: Number(event.args.entityNumber),
            data: { name: event.args.name },
          };
          break;

        case 'ControlSharesReceived': {
          const entityNumber = this.extractEntityNumberFromTokenId(Number(event.args.tokenId));
          jurisdictionEvent = {
            type: 'shares_received',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityNumber: entityNumber,
            data: {
              entityProvider: event.args.entityProvider,
              fromEntity: event.args.fromEntity,
              tokenId: event.args.tokenId.toString(),
              amount: event.args.amount.toString(),
              data: event.args.data,
            },
          };
          break;
        }

        case 'ReserveUpdated':
          // Handle ReserveUpdated events with special processing
          this.handleReserveUpdatedEvent(
            event.args.entity.toString(),
            event.args.tokenId,
            event.args.newBalance,
            event,
            env
          );
          return; // Don't process through normal flow

        case 'ReserveTransferred':
          // Process for sender entity
          jurisdictionEvent = {
            type: 'reserve_transferred',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityNumber: Number(event.args.from),
            data: {
              from: event.args.from.toString(),
              to: event.args.to.toString(),
              tokenId: Number(event.args.tokenId),
              amount: event.args.amount.toString(),
              direction: 'sent',
            },
          };
          this.handleJurisdictionEvent(jurisdictionEvent, env);
          
          // Process for receiver entity
          jurisdictionEvent = {
            type: 'reserve_transferred',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityNumber: Number(event.args.to),
            data: {
              from: event.args.from.toString(),
              to: event.args.to.toString(),
              tokenId: Number(event.args.tokenId),
              amount: event.args.amount.toString(),
              direction: 'received',
            },
          };
          break;

        case 'SettlementProcessed':
          // Handle SettlementProcessed events with special processing
          this.handleSettlementProcessedEvent(
            event.args.leftEntity.toString(),
            event.args.rightEntity.toString(),
            event.args.tokenId,
            event.args.leftReserve,
            event.args.rightReserve,
            event.args.collateral,
            event.args.ondelta,
            event,
            env
          );
          return; // Don't process through normal flow

        default:
          return; // Skip unknown events
      }

      this.handleJurisdictionEvent(jurisdictionEvent, env);
    } catch (error) {
      console.error('🔭 J-WATCHER: Error processing contract event:', error);
    }
  }

  /**
   * Handle SettlementProcessed events specifically
   * Feed event to both left and right entities' machines
   */
  private handleSettlementProcessedEvent(
    leftEntity: string,
    rightEntity: string,
    tokenId: bigint,
    leftReserve: bigint,
    rightReserve: bigint,
    collateral: bigint,
    ondelta: bigint,
    event: any,
    env: Env
  ): void {
    console.log(`🔍 SETTLEMENT-EVENT: Handling SettlementProcessed between ${leftEntity.slice(0,10)}... and ${rightEntity.slice(0,10)}... tokenId=${tokenId} block=${event.blockNumber}`);
    
    // Feed settlement event to both left and right entities
    this.feedSettlementToEntity(leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral, ondelta, event, env, 'left');
    this.feedSettlementToEntity(rightEntity, leftEntity, tokenId, rightReserve, leftReserve, collateral, -ondelta, event, env, 'right');
  }

  /**
   * Feed settlement event to a specific entity
   */
  private feedSettlementToEntity(
    entityId: string,
    counterpartyId: string,
    tokenId: bigint,
    ownReserve: bigint,
    counterpartyReserve: bigint,
    collateral: bigint,
    ondelta: bigint,
    event: any,
    env: Env,
    side: 'left' | 'right'
  ): void {
    // Find the proposer replica for this entity
    const proposerReplica = this.findProposerReplica(entityId, env);
    if (!proposerReplica) {
      console.log(`🔭⚠️  SETTLEMENT-EVENT: No entity found for ${entityId.slice(0, 10)}...`);
      return;
    }

    // Check if entity has already processed this block
    const replicaKey = `${entityId}:${proposerReplica.signerId}`;
    const replica = env.replicas.get(replicaKey);
    if (replica && event.blockNumber <= replica.state.jBlock) {
      console.log(`🔄 Skipping settlement j-event for ${entityId.slice(0, 10)}... at block ${event.blockNumber} (entity at j-block ${replica.state.jBlock})`);
      return;
    }

    // Create j-event for this entity
    const entityTx = {
      type: 'j_event' as const,
      data: {
        from: proposerReplica.signerId,
        event: {
          type: 'SettlementProcessed',
          data: {
            leftEntity: side === 'left' ? entityId : counterpartyId,
            rightEntity: side === 'left' ? counterpartyId : entityId,
            counterpartyEntityId: counterpartyId,
            tokenId: Number(tokenId),
            ownReserve: ownReserve.toString(),
            counterpartyReserve: counterpartyReserve.toString(),
            collateral: collateral.toString(),
            ondelta: ondelta.toString(),
            side: side,
          },
        },
        observedAt: Date.now(),
        blockNumber: event.blockNumber || 0,
        transactionHash: event.transactionHash || '0x0000000000000000',
      },
    };

    // Submit to entity via the proposer replica
    env.serverInput.entityInputs.push({
      entityId: entityId,
      signerId: proposerReplica.signerId,
      entityTxs: [entityTx],
    });

    console.log(`🔭✅ SETTLEMENT PROCESSED: ${proposerReplica.signerId} processed settlement for Entity ${entityId.slice(0, 10)}... (${side} side)`);
  }

  /**
   * Handle ReserveUpdated events specifically
   * Feed event to the proposer replica for this entity
   */
  private handleReserveUpdatedEvent(entity: string, tokenId: bigint, newBalance: bigint, event: any, env: Env): void {
    console.log(`🔍 RESERVE-EVENT: Handling ReserveUpdated for entity ${entity.slice(0,10)}... tokenId=${tokenId} balance=${newBalance} block=${event.blockNumber}`);
    
    // Find the proposer replica for this entity
    const proposerReplica = this.findProposerReplica(entity, env);
    if (!proposerReplica) {
      console.log(`🔭⚠️  J-MACHINE EVENT: No entity found for reserve update ${entity.slice(0, 10)}...`);
      console.log(`🔭🔍 Available replicas: ${Array.from(env.replicas.keys()).join(', ')}`);
      return;
    }

    // Check if entity has already processed this block
    const replicaKey = `${entity}:${proposerReplica.signerId}`;
    const replica = env.replicas.get(replicaKey);
    console.log(`🔍 JBLOCK-DEBUG: Entity ${entity.slice(0, 10)}... event block ${event.blockNumber} vs entity jBlock ${replica?.state.jBlock}`);
    if (replica && event.blockNumber <= replica.state.jBlock) {
      console.log(`🔄 Skipping j-event for ${entity.slice(0, 10)}... at block ${event.blockNumber} (entity at j-block ${replica.state.jBlock})`);
      return;
    }

    // Log the actual reserve update with readable amounts
    const blockNum = event?.blockNumber || 'unknown';
    const txHash = event?.transactionHash || 'unknown';
    console.log(`🔭💰 R2R DETECTED: Entity ${entity.slice(0, 10)}... Token ${tokenId} Balance ${(Number(newBalance) / 1e18).toFixed(4)} (J-block ${blockNum})`);

    // Create j-event in the format expected by handleJEvent
    const entityTx = {
      type: 'j_event' as const,
      data: {
        from: proposerReplica.signerId,
        event: {
          type: 'ReserveUpdated', // Exact type expected by handler
          data: {
            entity: entity,
            tokenId: Number(tokenId),
            newBalance: newBalance.toString(),
            symbol: `TKN${tokenId}`, // Default symbol
            decimals: 18, // Default decimals
          },
        },
        observedAt: Date.now(),
        blockNumber: event.blockNumber || 0,
        transactionHash: event.transactionHash || '0x0000000000000000',
      },
    };

    // Submit to entity via the proposer replica
    env.serverInput.entityInputs.push({
      entityId: entity, // Use the bytes32 entity ID directly
      signerId: proposerReplica.signerId,
      entityTxs: [entityTx],
    });

    console.log(`🔭✅ R2R PROCESSED: ${proposerReplica.signerId} processed reserve update for Entity ${entity.slice(0, 10)}...`);
    console.log(`🔍 QUEUE-DEBUG: Added to entityInputs, total queue length: ${env.serverInput.entityInputs.length}`);
  }

  /**
   * Handle a jurisdiction event by creating entity transactions
   * Feed event to the proposer replica for this entity
   */
  private handleJurisdictionEvent(jEvent: JurisdictionEvent, env: Env): void {
    console.log(`🔭⚡ J-EVENT: ${jEvent.type} at block ${jEvent.blockNumber} for entity #${jEvent.entityNumber}`);

    if (!jEvent.entityNumber) {
      console.log(`🔭⚠️  J-EVENT: Missing entity number for event ${jEvent.type}`);
      return;
    }

    // Convert entity number to entity ID and find proposer replica
    const entityId = this.generateEntityId(jEvent.entityNumber);
    const proposerReplica = this.findProposerReplica(entityId, env);
    
    if (!proposerReplica) {
      console.log(`🔭⚠️  J-EVENT: No proposer replica found for entity #${jEvent.entityNumber}`);
      return;
    }

    // Check if entity has already processed this block
    const replicaKey = `${entityId}:${proposerReplica.signerId}`;
    const replica = env.replicas.get(replicaKey);
    if (replica && jEvent.blockNumber <= replica.state.jBlock) {
      if (DEBUG) console.log(`🔄 Skipping j-event for entity #${jEvent.entityNumber} at block ${jEvent.blockNumber} (entity at j-block ${replica.state.jBlock})`);
      return;
    }

    // Create entity transaction for the proposer with proper structure
    const entityTx: EntityTx = {
      type: 'j_event',
      data: {
        from: proposerReplica.signerId,
        event: {
          type: jEvent.type,
          data: jEvent.data,
        },
        observedAt: Date.now(),
        blockNumber: jEvent.blockNumber || 0,
        transactionHash: jEvent.transactionHash || '0x0000000000000000',
      },
    };

    // Submit to entity via the proposer replica
    env.serverInput.entityInputs.push({
      entityId: entityId,
      signerId: proposerReplica.signerId,
      entityTxs: [entityTx],
    });

    console.log(`🔭📤 J-EVENT: ${proposerReplica.signerId} → Entity #${jEvent.entityNumber} (${jEvent.type})`);
  }

  /**
   * Extract entity number from token ID
   * Control tokens use entity number directly, dividend tokens have high bit set
   */
  private extractEntityNumberFromTokenId(tokenId: number): number {
    // Remove the high bit if set (dividend token)
    return tokenId & 0x7fffffff;
  }

  /**
   * Find the proposer replica for a given entity and check if event should be processed
   */
  private findProposerReplica(entityId: string, env: Env): { signerId: string; shouldProcess: boolean } | null {
    // Look for a replica that has isProposer = true for this entity
    // Replica keys are in format "entityId:signerName" e.g. "0x000...001:s1"
    for (const [replicaKey, replica] of env.replicas.entries()) {
      const [keyEntityId, signerName] = replicaKey.split(':');
      if (keyEntityId === entityId && replica.isProposer) {
        return { signerId: signerName, shouldProcess: true };
      }
    }
    
    // Fallback: find any replica for this entity
    for (const [replicaKey, replica] of env.replicas.entries()) {
      const [keyEntityId, signerName] = replicaKey.split(':');
      if (keyEntityId === entityId) {
        return { signerId: signerName, shouldProcess: true };
      }
    }
    
    return null;
  }

  /**
   * Get the minimum jBlock from all entities to avoid reprocessing
   */
  private getMinEntityBlock(env: Env): number {
    let minBlock = 0;
    for (const [replicaKey, replica] of env.replicas.entries()) {
      minBlock = Math.max(minBlock, replica.state.jBlock || 0);
    }
    return minBlock;
  }

  /**
   * Get entity filters for historical sync - entities that need historical events
   */
  private getEntityFiltersForHistoricalSync(env: Env, fromBlock: number): string[] {
    const needsHistoricalSync: string[] = [];
    
    for (const [replicaKey, replica] of env.replicas.entries()) {
      const entityJBlock = replica.state.jBlock || 0;
      
      // If entity's jBlock is behind fromBlock, it needs historical sync
      if (entityJBlock < fromBlock) {
        const [entityId] = replicaKey.split(':');
        if (!needsHistoricalSync.includes(entityId)) {
          needsHistoricalSync.push(entityId);
          if (DEBUG) console.log(`🔄 Entity ${entityId.slice(0, 10)}... needs historical sync from j-block ${entityJBlock}`);
        }
      }
    }
    
    return needsHistoricalSync;
  }

  /**
   * Sync historical events for entities that have jBlock=0 (newly created)
   */
  private async syncHistoricalEventsForNewEntities(env: Env): Promise<boolean> {
    const currentBlock = await this.provider.getBlockNumber();
    
    console.log(`🔍 SYNC-DEBUG: Checking ${env.replicas.size} replicas for jBlock=0`);
    
    // Find entities that need historical sync
    const newEntities: string[] = [];
    for (const [replicaKey, replica] of env.replicas.entries()) {
      console.log(`🔍 SYNC-DEBUG: Replica ${replicaKey}: jBlock=${replica.state.jBlock}`);
      if (replica.state.jBlock === 0) {
        const [entityId] = replicaKey.split(':');
        if (!newEntities.includes(entityId)) {
          newEntities.push(entityId);
          console.log(`🔍 SYNC-DEBUG: Added entity ${entityId} to sync list`);
        }
      }
    }
    
    console.log(`🔍 SYNC-DEBUG: Found ${newEntities.length} entities needing sync: [${newEntities.map(e => e.slice(0,10)+'...').join(', ')}]`);
    
    if (newEntities.length === 0) {
      console.log('🔄 No new entities requiring historical sync');
      return false;
    }
    
    console.log(`🔄 Syncing historical events for ${newEntities.length} new entities from block 0 to ${currentBlock}`);
    console.log(`🔍 QUEUE-DEBUG: Initial entityInputs length: ${env.serverInput.entityInputs.length}`);
    
    for (const entityId of newEntities) {
      console.log(`🔄 Fetching historical ReserveUpdated events for entity ${entityId.slice(0, 10)}...`);
      
      try {
        // Get all ReserveUpdated events for this specific entity
        const reserveEvents = await this.depositoryContract.queryFilter(
          this.depositoryContract.filters.ReserveUpdated(entityId), // Filter by entity
          0, // From block 0
          currentBlock
        );
        
        console.log(`🔄 Found ${reserveEvents.length} historical ReserveUpdated events for entity ${entityId.slice(0, 10)}...`);
        console.log(`🔄🔍 Full entityId being synced: ${entityId}`);
        console.log(`🔄🔍 Available replicas during sync: ${Array.from(env.replicas.keys()).join(', ')}`);
        
        // Sort events chronologically
        reserveEvents.sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) {
            return a.blockNumber - b.blockNumber;
          }
          return (a.transactionIndex || 0) - (b.transactionIndex || 0);
        });
        
        // Process each event individually and trigger processing after each one
        // This ensures jBlock gets updated progressively, not all at once
        for (const event of reserveEvents) {
          console.log(`🔄🎯 Processing historical event: block ${event.blockNumber}, tx ${event.transactionHash}`);
          
          // Clear any previous entityInputs to process events one by one
          const originalInputsLength = env.serverInput.entityInputs.length;
          
          // Process this single event
          await this.processContractEvent(event, env);
          
          // If this event was queued, process it immediately before the next one
          if (env.serverInput.entityInputs.length > originalInputsLength) {
            console.log(`🔄⚡ Processing single historical event immediately to update jBlock`);
            // Import processUntilEmpty to process this single event
            const { processUntilEmpty } = await import('./server.js');
            await processUntilEmpty(env, []);
            console.log(`🔄✅ Historical event processed, entity jBlock updated`);
          }
        }
        
      } catch (error) {
        console.error(`🔄❌ Error syncing historical events for entity ${entityId.slice(0, 10)}...`, error);
      }
    }
    
    console.log(`✅ Historical event sync completed for ${newEntities.length} entities`);
    
    // Return true if we processed any entities (events were processed individually)
    return newEntities.length > 0;
  }

  /**
   * Generate entity ID from entity number (matches server logic)
   */
  private generateEntityId(entityNumber: number): string {
    // Convert number to bytes32 hex string (matches generateNumberedEntityId)
    return '0x' + entityNumber.toString(16).padStart(64, '0');
  }

  /**
   * Trigger historical sync for newly added entities
   * Call this after entities are created to sync their historical events
   */
  async syncNewlyCreatedEntities(env: Env): Promise<boolean> {
    if (!this.isWatching) {
      if (DEBUG) console.log('🔄 J-WATCHER not watching, skipping newly created entity sync');
      return false;
    }
    
    console.log('🔄 Checking for newly created entities needing historical sync...');
    return await this.syncHistoricalEventsForNewEntities(env);
  }

  /**
   * Start continuous entity monitoring - checks all entities every 1 second
   */
  private startContinuousEntityMonitoring(env: Env): void {
    setInterval(async () => {
      if (!this.isWatching) return;

      try {
        const currentBlock = await this.provider.getBlockNumber();
        const entitiesNeedingSync: Array<{entityId: string, currentJBlock: number}> = [];

        // Check all entities
        for (const [replicaKey, replica] of env.replicas.entries()) {
          const [entityId] = replicaKey.split(':');
          const currentJBlock = replica.state.jBlock || 0;
          
          // If entity jBlock is behind current blockchain, it needs sync
          if (currentJBlock < currentBlock) {
            entitiesNeedingSync.push({entityId, currentJBlock});
          }
        }

        if (entitiesNeedingSync.length > 0) {
          console.log(`🔍 CONTINUOUS-CHECK: Checked ${env.replicas.size} entities against block ${currentBlock}, ${entitiesNeedingSync.length} need sync`);
          for (const {entityId, currentJBlock} of entitiesNeedingSync) {
            console.log(`🔄 ENTITY-SYNC: Entity ${entityId.slice(0,10)}... at jBlock ${currentJBlock}, syncing to block ${currentBlock}`);
            await this.syncEntityFromBlock(entityId, currentJBlock + 1, currentBlock, env);
          }
        }
      } catch (error) {
        console.error('🔄❌ Error in continuous entity monitoring:', error);
      }
    }, 1000); // Every 1 second
  }

  /**
   * Sync a specific entity from a specific block range
   */
  private async syncEntityFromBlock(entityId: string, fromBlock: number, toBlock: number, env: Env): Promise<void> {
    try {
      console.log(`🔄📡 SYNC-RANGE: Syncing entity ${entityId.slice(0,10)}... from block ${fromBlock} to ${toBlock}`);
      
      // Get ReserveUpdated events for this entity in this range
      const reserveEvents = await this.depositoryContract.queryFilter(
        this.depositoryContract.filters.ReserveUpdated(entityId),
        fromBlock,
        toBlock
      );

      console.log(`🔄📦 SYNC-RANGE: Found ${reserveEvents.length} ReserveUpdated events for entity ${entityId.slice(0,10)}...`);

      // Sort events chronologically
      reserveEvents.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return (a.transactionIndex || 0) - (b.transactionIndex || 0);
      });

      // Process each event individually
      for (const event of reserveEvents) {
        console.log(`🔄⚡ SYNC-RANGE: Processing event block ${event.blockNumber} for entity ${entityId.slice(0,10)}...`);
        
        const beforeLength = env.serverInput.entityInputs.length;
        await this.processContractEvent(event, env);
        const afterLength = env.serverInput.entityInputs.length;
        
        console.log(`🔍 EVENT-DEBUG: entityInputs length before=${beforeLength}, after=${afterLength}`);
        
        // Process immediately to update jBlock
        if (env.serverInput.entityInputs.length > 0) {
          console.log(`🔄💥 SYNC-RANGE: Calling processUntilEmpty to process ${env.serverInput.entityInputs.length} queued events`);
          const { processUntilEmpty } = await import('./server.js');
          await processUntilEmpty(env, []);
          
          // Check if jBlock was updated
          const replica = env.replicas.get(`${entityId}:${this.findProposerReplica(entityId, env)?.signerId}`);
          const newJBlock = replica?.state.jBlock || 0;
          console.log(`🔄✅ SYNC-RANGE: ProcessUntilEmpty completed, entity jBlock now: ${newJBlock}`);
        } else {
          console.log(`🔄⚠️ SYNC-RANGE: No events were queued for processing!`);
        }
      }
      
    } catch (error) {
      console.error(`🔄❌ SYNC-RANGE: Error syncing entity ${entityId.slice(0,10)}... from block ${fromBlock}:`, error);
    }
  }

  /**
   * Get current watching status
   */
  getStatus(): { isWatching: boolean; lastProcessedBlock: number; signerCount: number } {
    return {
      isWatching: this.isWatching,
      lastProcessedBlock: this.lastProcessedBlock,
      signerCount: this.signers.size,
    };
  }
}

/**
 * Create and configure a J-Event Watcher instance
 */
export function createJEventWatcher(config: WatcherConfig): JEventWatcher {
  return new JEventWatcher(config);
}

/**
 * Helper function to set up watcher with common configuration
 */
export async function setupJEventWatcher(
  env: Env,
  rpcUrl: string,
  entityProviderAddr: string,
  depositoryAddr: string,
): Promise<JEventWatcher> {
  const watcher = createJEventWatcher({
    rpcUrl,
    entityProviderAddress: entityProviderAddr,
    depositoryAddress: depositoryAddr,
    startBlock: 0, // Start from genesis, or could be configured
  });

  // Add example signers (would be configured per deployment)
  watcher.addSigner('s1', 's1-private-key', ['1', '2', '3', '4', '5']);
  watcher.addSigner('s2', 's2-private-key', ['1', '2', '3', '4', '5']);
  watcher.addSigner('s3', 's3-private-key', ['1', '2', '3', '4', '5']);

  await watcher.startWatching(env);

  return watcher;
}
