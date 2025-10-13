/**
 * J-Machine Event Watcher
 *
 * First-principles design:
 * 1. Find all proposer replicas in runtime
 * 2. Sync each proposer from their last jBlock (not duplicate events)
 * 3. Feed new j-events to proposer replicas through runtime process()
 * 4. Simple single polling loop - no complex timers or historical sync
 */

import { ethers } from 'ethers';
import type { Env } from './types.js';

// Debug flags - reduced for cleaner output
const DEBUG = false; // Reduced j-watcher verbosity
const HEAVY_LOGS = false;

// Event types we care about from the jurisdiction

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
  private signers: Map<string, SignerConfig> = new Map();
  private isWatching: boolean = false;

  // Minimal ABIs for events we need
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
    'event TransferReserveToCollateral(bytes32 indexed receivingEntity, bytes32 indexed counterentity, uint256 collateral, int256 ondelta, uint256 indexed tokenId)',
  ];

  constructor(config: WatcherConfig) {
    // Resolve relative URLs to full URLs for ethers.js (browser compat)
    let resolvedRpcUrl = config.rpcUrl;
    if (typeof window !== 'undefined' && config.rpcUrl.startsWith('/')) {
      resolvedRpcUrl = new URL(config.rpcUrl, window.location.origin).href;
      console.log(`🔧 J-WATCHER: Resolved ${config.rpcUrl} → ${resolvedRpcUrl}`);
    }

    this.provider = new ethers.JsonRpcProvider(resolvedRpcUrl);

    this.entityProviderContract = new ethers.Contract(
      config.entityProviderAddress,
      this.entityProviderABI,
      this.provider,
    );

    this.depositoryContract = new ethers.Contract(config.depositoryAddress, this.depositoryABI, this.provider);

    if (DEBUG) {
      console.log(`🔭 J-WATCHER: Initialized with RPC: ${config.rpcUrl}`);
      console.log(`🔭 J-WATCHER: EntityProvider: ${config.entityProviderAddress}`);
      console.log(`🔭 J-WATCHER: Depository: ${config.depositoryAddress}`);
    }
  }

  /**
   * Add a signer configuration for monitoring (legacy compatibility)
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
    console.log('🔭 J-WATCHER: Starting simple first-principles watcher...');

    try {
      // Test blockchain connection
      const currentBlock = await this.provider.getBlockNumber();
      console.log(`🔭 J-WATCHER: Connected to blockchain at block ${currentBlock}`);
    } catch (error) {
      console.log(`🔭⚠️  J-WATCHER: Blockchain not ready, will retry: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Simple polling every 1 second - first principles approach
    setInterval(async () => {
      if (!this.isWatching) return;

      try {
        await this.syncAllProposerReplicas(env);
      } catch (error) {
        if (DEBUG && !(error instanceof Error && error.message.includes('ECONNREFUSED'))) {
          console.error('🔭❌ J-WATCHER: Sync error:', error instanceof Error ? error.message : String(error));
        }
      }
    }, 1000);

    console.log('🔭 J-WATCHER: Started with simple 1s polling');
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
   * Core logic: Find proposer replicas, sync each from last jBlock
   * This is the first-principles approach you requested
   */
  private async syncAllProposerReplicas(env: Env): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (DEBUG) {
        console.log(`🔭🔍 SYNC-START: Current blockchain block=${currentBlock}, total replicas=${env.replicas.size}`);
        console.log(`🔭🔍 SYNC-ENV-TIMESTAMP: env.timestamp=${env.timestamp}`);
        for (const [replicaKey, replica] of env.replicas.entries()) {
          console.log(`🔭🔍 REPLICA-STATE: ${replicaKey} → jBlock=${replica.state.jBlock}, height=${replica.state.height}, isProposer=${replica.isProposer}`);
        }
      }

      // 1. Find all proposer replicas that need syncing
      const proposerReplicas: Array<{entityId: string, signerId: string, lastJBlock: number}> = [];

      for (const [replicaKey, replica] of env.replicas.entries()) {
        if (replica.isProposer) {
          const [entityId, signerId] = replicaKey.split(':');
          if (!entityId || !signerId) continue;
          const lastJBlock = replica.state.jBlock || 0;

          if (DEBUG) {
            console.log(`🔭🔍 REPLICA-CHECK: ${signerId} → Entity ${entityId.slice(0,10)}... jBlock=${lastJBlock}, currentBlock=${currentBlock}, isProposer=${replica.isProposer}`);
          }

          if (lastJBlock < currentBlock) {
            proposerReplicas.push({ entityId, signerId, lastJBlock });

            if (HEAVY_LOGS) {
              console.log(`🔭🔍 PROPOSER-SYNC: Found proposer ${signerId} for entity ${entityId.slice(0,10)}... at jBlock ${lastJBlock}, needs sync to ${currentBlock}`);
            }
          } else {
            if (DEBUG) {
              console.log(`🔭✅ REPLICA-SYNCED: ${signerId} → Entity ${entityId.slice(0,10)}... already synced (jBlock=${lastJBlock} >= currentBlock=${currentBlock})`);
            }
          }
        }
      }

      if (proposerReplicas.length === 0) {
        // Completely silent when no sync needed
        return;
      }

      if (DEBUG) {
        console.log(`🔭⚡ SYNC: ${proposerReplicas.length} proposer replicas need sync to block ${currentBlock}`);
        for (const { entityId, signerId, lastJBlock } of proposerReplicas) {
          console.log(`🔭📋 SYNC-QUEUE: ${signerId} → Entity ${entityId.slice(0,10)}... from j-block ${lastJBlock + 1} to ${currentBlock}`);
        }
      }

      // 2. Sync each proposer replica from their last jBlock
      for (const { entityId, signerId, lastJBlock } of proposerReplicas) {
        await this.syncEntityFromJBlock(entityId, signerId, lastJBlock + 1, currentBlock, env);
      }

    } catch (error) {
      // Don't spam connection errors
      if (!(error instanceof Error) || !error.message.includes('ECONNREFUSED')) {
        throw error;
      }
    }
  }

  /**
   * Sync a specific entity from its last jBlock to current block
   */
  private async syncEntityFromJBlock(
    entityId: string,
    signerId: string,
    fromBlock: number,
    toBlock: number,
    env: Env
  ): Promise<void> {
    if (fromBlock > toBlock) return;

    if (DEBUG) {
      console.log(`🔭📡 ENTITY-SYNC: Entity ${entityId.slice(0,10)}... (${signerId}) from j-block ${fromBlock} to ${toBlock}`);
    }

    try {
      // Get new events for this entity in this block range
      const events = await this.getEntityEventsInRange(entityId, fromBlock, toBlock);

      if (events.length === 0) {
        if (HEAVY_LOGS) {
          console.log(`🔭⚪ ENTITY-SYNC: No events found for entity ${entityId.slice(0,10)}... in blocks ${fromBlock}-${toBlock}`);
        }
        return;
      }

      console.log(`🔭📦 ENTITY-SYNC: Found ${events.length} new events for entity ${entityId.slice(0,10)}... in blocks ${fromBlock}-${toBlock}`);

      // Process events chronologically and feed to proposer
      for (const event of events) {
        this.feedEventToProposer(entityId, signerId, event, env);
      }

      console.log(`🔭✅ ENTITY-SYNC: Queued ${events.length} events for entity ${entityId.slice(0,10)}... (${signerId})`);

    } catch (error) {
      console.error(`🔭❌ ENTITY-SYNC: Error syncing entity ${entityId.slice(0,10)}...`, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Get all events for a specific entity in block range
   */
  private async getEntityEventsInRange(entityId: string, fromBlock: number, toBlock: number) {
    if (HEAVY_LOGS) {
      console.log(`🔭🔍 EVENT-QUERY: Fetching events for entity ${entityId.slice(0,10)}... blocks ${fromBlock}-${toBlock}`);
    }

    // Get all relevant events for this entity
    const reserveFilter = this.depositoryContract.filters['ReserveUpdated'];
    const settlementFilter = this.depositoryContract.filters['SettlementProcessed'];
    const r2cFilter = this.depositoryContract.filters['TransferReserveToCollateral'];

    if (!reserveFilter || !settlementFilter || !r2cFilter) {
      throw new Error('Contract filters not available');
    }

    const [reserveEvents, settlementEventsLeft, settlementEventsRight, r2cEventsReceiving, r2cEventsCounterparty] = await Promise.all([
      this.depositoryContract.queryFilter(
        reserveFilter(entityId),
        fromBlock,
        toBlock
      ),
      this.depositoryContract.queryFilter(
        settlementFilter(entityId, null, null),
        fromBlock,
        toBlock
      ),
      this.depositoryContract.queryFilter(
        settlementFilter(null, entityId, null),
        fromBlock,
        toBlock
      ),
      this.depositoryContract.queryFilter(
        r2cFilter(entityId, null, null), // receivingEntity
        fromBlock,
        toBlock
      ),
      this.depositoryContract.queryFilter(
        r2cFilter(null, entityId, null), // counterentity
        fromBlock,
        toBlock
      )
    ]);

    if (HEAVY_LOGS) {
      console.log(`🔭🔍 EVENT-QUERY: Entity ${entityId.slice(0,10)}... - Reserve: ${reserveEvents.length}, SettlementLeft: ${settlementEventsLeft.length}, SettlementRight: ${settlementEventsRight.length}, R2C: ${r2cEventsReceiving.length + r2cEventsCounterparty.length}`);
    }

    // Combine and sort chronologically
    const allEvents = [
      ...reserveEvents.map(e => ({ ...e, eventType: 'ReserveUpdated' })),
      ...settlementEventsLeft.map(e => ({ ...e, eventType: 'SettlementProcessed', side: 'left' })),
      ...settlementEventsRight.map(e => ({ ...e, eventType: 'SettlementProcessed', side: 'right' })),
      ...r2cEventsReceiving.map(e => ({ ...e, eventType: 'TransferReserveToCollateral', side: 'receiving' })),
      ...r2cEventsCounterparty.map(e => ({ ...e, eventType: 'TransferReserveToCollateral', side: 'counterparty' }))
    ].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return (a.transactionIndex || 0) - (b.transactionIndex || 0);
    });

    if (HEAVY_LOGS && allEvents.length > 0) {
      console.log(`🔭🔍 EVENT-QUERY: Entity ${entityId.slice(0,10)}... total events: ${allEvents.length}`);
      allEvents.forEach((event, i) => {
        console.log(`🔭🔍 EVENT-${i}: ${event.eventType} at block ${event.blockNumber} tx ${event.transactionIndex}`);
      });
    }

    return allEvents;
  }

  /**
   * Feed event to proposer replica via server entityInputs
   */
  private feedEventToProposer(entityId: string, signerId: string, event: any, env: Env): void {
    let entityTx;

    if (event.eventType === 'ReserveUpdated') {
      entityTx = {
        type: 'j_event' as const,
        data: {
          from: signerId,
          event: {
            type: 'ReserveUpdated',
            data: {
              entity: entityId,
              tokenId: Number(event.args.tokenId),
              newBalance: event.args.newBalance.toString(),
              symbol: `TKN${event.args.tokenId}`,
              decimals: 18,
            },
          },
          observedAt: Date.now(),
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        },
      };

      if (DEBUG) {
        console.log(`🔭💰 R2R-EVENT: Entity ${entityId.slice(0,10)}... Token ${event.args.tokenId} Balance ${(Number(event.args.newBalance) / 1e18).toFixed(4)} (block ${event.blockNumber})`);
      }

    } else if (event.eventType === 'SettlementProcessed') {
      const isLeft = event.side === 'left';
      const counterpartyId = isLeft ? event.args.rightEntity.toString() : event.args.leftEntity.toString();
      const ownReserve = isLeft ? event.args.leftReserve : event.args.rightReserve;
      const counterpartyReserve = isLeft ? event.args.rightReserve : event.args.leftReserve;
      const ondelta = isLeft ? event.args.ondelta : -event.args.ondelta;

      entityTx = {
        type: 'j_event' as const,
        data: {
          from: signerId,
          event: {
            type: 'SettlementProcessed',
            data: {
              leftEntity: event.args.leftEntity.toString(),
              rightEntity: event.args.rightEntity.toString(),
              counterpartyEntityId: counterpartyId,
              tokenId: Number(event.args.tokenId),
              ownReserve: ownReserve.toString(),
              counterpartyReserve: counterpartyReserve.toString(),
              collateral: event.args.collateral.toString(),
              ondelta: ondelta.toString(),
              side: event.side,
            },
          },
          observedAt: Date.now(),
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        },
      };

      if (DEBUG) {
        console.log(`🔭💱 SETTLE-EVENT: Entity ${entityId.slice(0,10)}... vs ${counterpartyId.slice(0,10)}... (${event.side} side, block ${event.blockNumber})`);
      }
    } else if (event.eventType === 'TransferReserveToCollateral') {
      entityTx = {
        type: 'j_event' as const,
        data: {
          from: signerId,
          event: {
            type: 'TransferReserveToCollateral',
            data: {
              receivingEntity: event.args.receivingEntity.toString(),
              counterentity: event.args.counterentity.toString(),
              collateral: event.args.collateral.toString(),
              ondelta: event.args.ondelta.toString(),
              tokenId: Number(event.args.tokenId),
              side: event.side, // 'receiving' or 'counterparty'
            },
          },
          observedAt: Date.now(),
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        },
      };

      if (DEBUG) {
        console.log(`🔭💰 R2C-EVENT: Entity ${entityId.slice(0,10)}... (${event.side} side) collateral=${event.args.collateral.toString()}, block ${event.blockNumber}`);
      }
    }

    if (entityTx) {
      // Feed to runtime processing queue
      console.log(`🚨 J-WATCHER-CREATING-EVENT: ${signerId} creating j-event ${event.eventType} block=${event.blockNumber} for entity ${entityId.slice(0,10)}...`);
      env.runtimeInput.entityInputs.push({
        entityId: entityId,
        signerId: signerId,
        entityTxs: [entityTx],
      });

      console.log(`🔭✅ J-WATCHER-QUEUED: ${signerId} → Entity ${entityId.slice(0,10)}... (${event.eventType}) block=${event.blockNumber} - Queue length now: ${env.runtimeInput.entityInputs.length}`);
    }
  }

  /**
   * Legacy compatibility method - not used in first-principles design
   */
  async syncNewlyCreatedEntities(_env: Env): Promise<boolean> {
    if (DEBUG) {
      console.log('🔭⚠️  J-WATCHER: syncNewlyCreatedEntities called (legacy) - first-principles design handles this automatically');
    }
    return false;
  }

  /**
   * Get current blockchain block number
   */
  async getCurrentBlockNumber(): Promise<number> {
    try {
      return await this.provider.getBlockNumber();
    } catch (error) {
      if (DEBUG) {
        console.log(`🔭⚠️  J-WATCHER: Could not get current block, using 0:`, error instanceof Error ? error.message : String(error));
      }
      return 0;
    }
  }

  /**
   * Get current watching status
   */
  getStatus(): { isWatching: boolean; signerCount: number } {
    return {
      isWatching: this.isWatching,
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
 * Updated for first-principles design
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
    startBlock: 0,
  });

  // Add example signers (legacy compatibility - not used in first-principles design)
  watcher.addSigner('s1', 's1-private-key', ['1', '2', '3', '4', '5']);
  watcher.addSigner('s2', 's2-private-key', ['1', '2', '3', '4', '5']);
  watcher.addSigner('s3', 's3-private-key', ['1', '2', '3', '4', '5']);

  await watcher.startWatching(env);

  if (DEBUG) {
    console.log('🔭✅ J-WATCHER: Setup complete with first-principles design');
  }

  return watcher;
}