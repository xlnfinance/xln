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

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL J-EVENTS (Single Source of Truth - must match Depository.sol)
// ═══════════════════════════════════════════════════════════════════════════
//
// These are the ONLY events that update entity state. Each has ONE purpose:
//
// ReserveUpdated  - Entity reserve balance changed (mint, R2R, settlement)
//                   Handler: entity.reserves[tokenId] = newBalance
//
// AccountSettled  - Bilateral account state changed
//                   Handler: entity.accounts[counterparty] = { collateral, ondelta, reserves }
//
// Design: One event = One state change. No redundant events.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical J-Event types that j-watcher processes.
 * MUST match Depository.sol and Account.sol event definitions.
 */
export const CANONICAL_J_EVENTS = ['ReserveUpdated', 'SecretRevealed', 'AccountSettled', 'DisputeStarted', 'DisputeFinalized', 'DebtCreated'] as const;
export type CanonicalJEvent = (typeof CANONICAL_J_EVENTS)[number];

/**
 * Verify that an event name is a canonical j-event we handle.
 * Call this at startup to catch mismatches between Solidity and TypeScript.
 */
export function assertCanonicalEvent(eventName: string): asserts eventName is CanonicalJEvent {
  if (!CANONICAL_J_EVENTS.includes(eventName as CanonicalJEvent)) {
    throw new Error(
      `J-EVENT PARITY ERROR: "${eventName}" is not a canonical j-event.\n` +
      `Canonical events: ${CANONICAL_J_EVENTS.join(', ')}\n` +
      `If Solidity added a new event, add it to CANONICAL_J_EVENTS in j-event-watcher.ts`
    );
  }
}

/**
 * BrowserVM event interface (matches browserVMProvider.ts EVMEvent)
 */
export interface BrowserVMEvent {
  name: string;
  args: Record<string, any>;
  blockNumber?: number;
  blockHash?: string;
  timestamp?: number;
}

/**
 * BrowserVM interface for event subscription.
 * onAny receives BATCHED events (all events from one tx/block together).
 */
export interface BrowserVMEventSource {
  onAny(callback: (events: BrowserVMEvent[]) => void): () => void;
  getBlockNumber(): bigint;
  getBlockHash(): string;
}

interface WatcherConfig {
  rpcUrl: string;
  entityProviderAddress: string;
  depositoryAddress: string;
  startBlock?: number;
  browserVM?: BrowserVMEventSource; // Optional BrowserVM for simnet mode
}

interface SignerConfig {
  signerId: string;
  privateKey: string;
  entityIds: string[]; // Which entities this signer cares about
}

export class JEventWatcher {
  private provider: ethers.JsonRpcProvider | null = null;
  private entityProviderContract: ethers.Contract | null = null;
  private depositoryContract: ethers.Contract | null = null;
  private signers: Map<string, SignerConfig> = new Map();
  private isWatching: boolean = false;
  private syntheticTxCounter: number = 0;

  // BrowserVM mode (simnet)
  private browserVM: BrowserVMEventSource | null = null;
  private browserVMUnsubscribe: (() => void) | null = null;
  private env: Env | null = null; // Store env reference for BrowserVM event handling

  // Minimal ABIs for events we need (EntityProvider events, not j-events)
  private entityProviderABI = [
    'event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)',
    'event ControlSharesReleased(bytes32 indexed entityId, address indexed depository, uint256 controlAmount, uint256 dividendAmount, string purpose)',
    'event NameAssigned(string indexed name, uint256 indexed entityNumber)',
  ];

  // Canonical j-events ABI - MUST match CANONICAL_J_EVENTS
  private depositoryABI = [
    // Canonical j-events (update entity state)
    'event ReserveUpdated(bytes32 indexed entity, uint256 indexed tokenId, uint256 newBalance)',
    'event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret)',
    'event AccountSettled(tuple(bytes32 left, bytes32 right, uint256 tokenId, uint256 leftReserve, uint256 rightReserve, uint256 collateral, int256 ondelta)[])',
    'event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed disputeNonce, bytes32 proofbodyHash, bytes initialArguments)',
    'event DisputeFinalized(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed initialDisputeNonce, bytes32 initialProofbodyHash, bytes32 finalProofbodyHash)',
    'event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex)',
  ];

  /**
   * Verify ABI parity between depositoryABI and CANONICAL_J_EVENTS.
   * Throws on mismatch - catches Solidity/TypeScript drift at startup.
   */
  private verifyABIParity(): void {
    // Extract event names from ABI strings
    const abiEventNames = this.depositoryABI.map(abi => {
      const match = abi.match(/^event\s+(\w+)/);
      return match ? match[1] : null;
    }).filter(Boolean) as string[];

    // Check each canonical event is in ABI
    for (const canonicalEvent of CANONICAL_J_EVENTS) {
      if (!abiEventNames.includes(canonicalEvent)) {
        throw new Error(
          `J-EVENT ABI PARITY ERROR: "${canonicalEvent}" is in CANONICAL_J_EVENTS but missing from depositoryABI.\n` +
          `Add the event ABI string to depositoryABI in j-event-watcher.ts`
        );
      }
    }

    // Check each ABI event is canonical
    for (const abiEvent of abiEventNames) {
      if (!CANONICAL_J_EVENTS.includes(abiEvent as CanonicalJEvent)) {
        throw new Error(
          `J-EVENT ABI PARITY ERROR: "${abiEvent}" is in depositoryABI but not in CANONICAL_J_EVENTS.\n` +
          `Either add it to CANONICAL_J_EVENTS or remove from depositoryABI`
        );
      }
    }

    if (DEBUG) {
      console.log(`🔭✅ J-WATCHER: ABI parity verified - ${CANONICAL_J_EVENTS.join(', ')}`);
    }
  }

  constructor(config: WatcherConfig) {
    // Verify ABI parity at initialization
    this.verifyABIParity();

    // BrowserVM mode - subscribe to events directly, no RPC needed
    if (config.browserVM) {
      this.browserVM = config.browserVM;
      console.log(`🔭 J-WATCHER: Initialized in BrowserVM mode (simnet)`);
      return;
    }

    // Ethers RPC mode
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
    this.env = env; // Store for BrowserVM event handler

    // BrowserVM mode - subscribe to batched events
    if (this.browserVM) {
      console.log('🔭 J-WATCHER: Starting BrowserVM subscription mode...');
      this.browserVMUnsubscribe = this.browserVM.onAny((events) => {
        // Events arrive as batch (all events from one tx/block)
        this.handleBrowserVMEventBatch(events);
      });
      console.log('🔭 J-WATCHER: Started with BrowserVM event subscription (batched)');
      return;
    }

    // Ethers RPC mode
    console.log('🔭 J-WATCHER: Starting simple first-principles watcher...');

    try {
      // Test blockchain connection
      const currentBlock = await this.provider!.getBlockNumber();
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
   * Handle batched BrowserVM events - all events from one tx/block arrive together.
   * Creates ONE j_event EntityTx per entity containing ALL relevant events.
   */
  private handleBrowserVMEventBatch(events: BrowserVMEvent[]): void {
    if (!this.env) {
      console.error('🔭❌ J-WATCHER: No env reference for BrowserVM events');
      return;
    }

    // Filter to canonical events only
    const canonicalEvents = events.filter(e => CANONICAL_J_EVENTS.includes(e.name as CanonicalJEvent));
    if (canonicalEvents.length === 0) {
      if (DEBUG) console.log(`J-WATCHER: No canonical events in batch of ${events.length}`);
      return;
    }

    // All events in batch share same block info (they're from same tx)
    const firstEvent = canonicalEvents[0];
    const blockNumber = firstEvent.blockNumber ?? Number(this.browserVM!.getBlockNumber());
    const blockHash = firstEvent.blockHash ?? this.browserVM!.getBlockHash();

    console.log(`📡 [1/3] J-EVENT-BATCH: ${canonicalEvents.length} events from block ${blockNumber}`);

    // Group events by relevant entity
    // Each entity gets ONE observation containing ALL its relevant events
    const eventsByEntity = new Map<string, { signerId: string; events: BrowserVMEvent[] }>();

    for (const [replicaKey, replica] of this.env.eReplicas.entries()) {
      if (!replica.isProposer) continue;

      const [entityId, signerId] = replicaKey.split(':');
      if (!entityId || !signerId) continue;

      // Find all events relevant to this entity
      const relevantEvents = canonicalEvents.filter(e => this.isEventRelevantToEntity(e, entityId));
      if (relevantEvents.length === 0) continue;

      // Accumulate (in case multiple signers for same entity)
      if (!eventsByEntity.has(entityId)) {
        eventsByEntity.set(entityId, { signerId, events: [] });
      }
      // Merge events (dedup handled later in j-events.ts)
      for (const e of relevantEvents) {
        eventsByEntity.get(entityId)!.events.push(e);
      }
    }

    // Create ONE j_event EntityTx per entity with ALL its events
    for (const [entityId, { signerId, events: relevantEvents }] of eventsByEntity) {
      // Convert all events to j_event format (flatMap because AccountSettled can have multiple)
      const jEvents = relevantEvents.flatMap(e => this.browserVMEventToJEvents(e, blockNumber, blockHash, entityId));

      if (jEvents.length === 0) continue;

      // Create single EntityTx with all events for this block
      const entityTx = {
        type: 'j_event' as const,
        data: {
          from: signerId,
          observedAt: this.getEventTimestamp(),
          blockNumber,
          blockHash,
          transactionHash: `browservm-${blockNumber}-${this.syntheticTxCounter++}`,
          // Pass all events in one observation
          events: jEvents,
          // For backwards compat, also include first event as 'event'
          event: jEvents[0],
        },
      };

      console.log(`   📮 QUEUE → ${entityId.slice(-4)} (${jEvents.length} events from block ${blockNumber})`);
      this.env.runtimeInput.entityInputs.push({
        entityId,
        signerId,
        entityTxs: [entityTx],
      });
    }
  }

  /**
   * Convert single BrowserVM event to JurisdictionEvent(s) format.
   * Returns ARRAY because AccountSettled can contain multiple settlements for same entity.
   */
  private browserVMEventToJEvents(event: BrowserVMEvent, blockNumber: number, blockHash: string, entityId: string): any[] {
    switch (event.name) {
      case 'ReserveUpdated':
        return [{
          type: 'ReserveUpdated',
          data: {
            entity: event.args.entity,
            tokenId: Number(event.args.tokenId),
            newBalance: event.args.newBalance?.toString() || '0',
          },
        }];

      case 'AccountSettled': {
        // Return ALL settlements relevant to this entity (not just first)
        const results: any[] = [];
        const settledArray = event.args.settled || event.args[''] || event.args[0] || [];
        for (const settled of settledArray) {
          const left = settled[0] || settled.left;
          const right = settled[1] || settled.right;
          if (left === entityId || right === entityId) {
            const tokenId = Number(settled[2] ?? settled.tokenId ?? 0);
            const leftReserve = (settled[3] ?? settled.leftReserve ?? 0n).toString();
            const rightReserve = (settled[4] ?? settled.rightReserve ?? 0n).toString();
            const collateral = (settled[5] ?? settled.collateral ?? 0n).toString();
            const ondelta = (settled[6] ?? settled.ondelta ?? 0n).toString();
            const isLeft = entityId === left;

            results.push({
              type: 'AccountSettled',
              data: {
                leftEntity: left,
                rightEntity: right,
                counterpartyEntityId: isLeft ? right : left,
                tokenId,
                ownReserve: isLeft ? leftReserve : rightReserve,
                counterpartyReserve: isLeft ? rightReserve : leftReserve,
                collateral,
                ondelta,
                side: isLeft ? 'left' : 'right',
              },
            });
          }
        }
        return results;
      }

      case 'SecretRevealed':
        return [{
          type: 'SecretRevealed',
          data: {
            hashlock: event.args.hashlock,
            revealer: event.args.revealer,
            secret: event.args.secret,
          },
        }];

      case 'DisputeStarted':
        return [{
          type: 'DisputeStarted',
          data: {
            sender: event.args.sender,
            counterentity: event.args.counterentity,
            disputeNonce: event.args.disputeNonce,
            proofbodyHash: event.args.proofbodyHash,  // From on-chain
            initialArguments: event.args.initialArguments || '0x',
          },
        }];

      case 'DisputeFinalized':
        return [{
          type: 'DisputeFinalized',
          data: {
            sender: event.args.sender,
            counterentity: event.args.counterentity,
            initialDisputeNonce: event.args.initialDisputeNonce,
            initialProofbodyHash: event.args.initialProofbodyHash,
            finalProofbodyHash: event.args.finalProofbodyHash,
          },
        }];

      case 'DebtCreated':
        return [{
          type: 'DebtCreated',
          data: {
            debtor: event.args.debtor,
            creditor: event.args.creditor,
            tokenId: Number(event.args.tokenId),
            amount: event.args.amount?.toString() || '0',
            debtIndex: Number(event.args.debtIndex || 0),
          },
        }];

      default:
        return [];
    }
  }

  /**
   * Check if a BrowserVM event is relevant to an entity
   * Only handles CANONICAL_J_EVENTS - ReserveUpdated, AccountSettled, DisputeStarted, DebtCreated
   */
  private isEventRelevantToEntity(event: BrowserVMEvent, entityId: string): boolean {
    // Normalize entity IDs for comparison (bytes32 from contract vs string in runtime)
    const normalizeId = (id: any): string => String(id).toLowerCase();
    const normalizedEntityId = normalizeId(entityId);

    switch (event.name) {
      case 'ReserveUpdated':
        return normalizeId(event.args.entity) === normalizedEntityId;
      case 'SecretRevealed':
        // Global relevance: any entity with a matching hashlock should observe
        return true;
      case 'AccountSettled': {
        // AccountSettled has array of Settled structs - check if entity is left or right in any
        // Can be event.args.settled (named param) or event.args[0] (unnamed) or event.args['']
        const settledArray = event.args.settled || event.args[''] || event.args[0] || [];
        for (const settled of settledArray) {
          const left = normalizeId(settled[0] || settled.left);
          const right = normalizeId(settled[1] || settled.right);
          if (left === normalizedEntityId || right === normalizedEntityId) return true;
        }
        return false;
      }

      case 'DisputeStarted':
        // Entity is relevant if they are sender OR counterentity (both need to know)
        return normalizeId(event.args.sender) === normalizedEntityId || normalizeId(event.args.counterentity) === normalizedEntityId;

      case 'DisputeFinalized':
        // Entity is relevant if they are sender OR counterentity (both need to know)
        return normalizeId(event.args.sender) === normalizedEntityId || normalizeId(event.args.counterentity) === normalizedEntityId;

      case 'DebtCreated':
        // Entity is relevant if they are debtor OR creditor
        return normalizeId(event.args.debtor) === normalizedEntityId || normalizeId(event.args.creditor) === normalizedEntityId;

      default:
        return false;
    }
  }

  /**
   * Stop watching
   */
  stopWatching(): void {
    this.isWatching = false;

    // BrowserVM mode cleanup
    if (this.browserVMUnsubscribe) {
      this.browserVMUnsubscribe();
      this.browserVMUnsubscribe = null;
      console.log('🔭 J-WATCHER: Stopped BrowserVM subscription');
      return;
    }

    // Ethers mode cleanup
    if (this.entityProviderContract) {
      this.entityProviderContract.removeAllListeners();
    }
    if (this.depositoryContract) {
      this.depositoryContract.removeAllListeners();
    }
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
        console.log(`🔭🔍 SYNC-START: Current blockchain block=${currentBlock}, total eReplicas=${env.eReplicas.size}`);
        console.log(`🔭🔍 SYNC-ENV-TIMESTAMP: env.timestamp=${env.timestamp}`);
        for (const [replicaKey, replica] of env.eReplicas.entries()) {
          console.log(`🔭🔍 REPLICA-STATE: ${replicaKey} → jBlock=${replica.state.lastFinalizedJHeight}, height=${replica.state.height}, isProposer=${replica.isProposer}`);
        }
      }

      // 1. Find all proposer replicas that need syncing
      const proposerReplicas: Array<{entityId: string, signerId: string, lastJBlock: number}> = [];

      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        if (replica.isProposer) {
          const [entityId, signerId] = replicaKey.split(':');
          if (!entityId || !signerId) continue;
          const lastJBlock = replica.state.lastFinalizedJHeight || 0;

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

      // Batch events by block for JBlock consensus
      const batches = new Map<string, { blockNumber: number; blockHash?: string; events: any[] }>();

      for (const event of events) {
        const blockNumber = event.blockNumber ?? 0;
        const blockHash = event.blockHash || '';
        const key = `${blockNumber}:${blockHash || '0x0'}`;
        if (!batches.has(key)) {
          batches.set(key, { blockNumber, blockHash, events: [] });
        }
        batches.get(key)!.events.push(event);
      }

      const batchList = Array.from(batches.values()).sort((a, b) => a.blockNumber - b.blockNumber);
      for (const batch of batchList) {
        const blockHash = await this.resolveBlockHash(batch.blockNumber, batch.blockHash);
        this.queueEventBatchToProposer(entityId, signerId, batch.events, batch.blockNumber, blockHash, env);
      }

      console.log(`🔭✅ ENTITY-SYNC: Queued ${events.length} events in ${batchList.length} batches for entity ${entityId.slice(0,10)}... (${signerId})`);

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

    if (!reserveFilter) {
      throw new Error('Contract filters not available');
    }

    // Note: AccountSettled event support for ethers RPC mode can be added here when needed
    // Currently only supporting ReserveUpdated for RPC mode (BrowserVM has full AccountSettled support)
    const [reserveEvents] = await Promise.all([
      this.depositoryContract.queryFilter(
        reserveFilter(entityId),
        fromBlock,
        toBlock
      ),
    ]);

    if (HEAVY_LOGS) {
      console.log(`🔭🔍 EVENT-QUERY: Entity ${entityId.slice(0,10)}... - Reserve: ${reserveEvents.length}`);
    }

    // Combine and sort chronologically
    const allEvents = [
      ...reserveEvents.map(e => ({ ...e, eventType: 'ReserveUpdated' })),
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
   * Resolve block hash for RPC batches (fallback to provider if needed).
   */
  private async resolveBlockHash(blockNumber: number, blockHash?: string): Promise<string> {
    if (blockHash && blockHash !== '0x0') {
      return blockHash;
    }

    if (!this.provider) {
      return '0x0';
    }

    try {
      const block = await this.provider.getBlock(blockNumber);
      return block?.hash || '0x0';
    } catch {
      return '0x0';
    }
  }

  /**
   * Convert a single RPC event into a J-event payload.
   */
  private rpcEventToJEvent(entityId: string, event: any): any | null {
    if (event.eventType === 'ReserveUpdated') {
      if (DEBUG) {
        console.log(`🔭💰 R2R-EVENT: Entity ${entityId.slice(0,10)}... Token ${event.args.tokenId} Balance ${(Number(event.args.newBalance) / 1e18).toFixed(4)} (block ${event.blockNumber})`);
      }

      return {
        type: 'ReserveUpdated',
        data: {
          entity: entityId,
          tokenId: Number(event.args.tokenId),
          newBalance: event.args.newBalance.toString(),
          symbol: `TKN${event.args.tokenId}`,
          decimals: 18,
        },
      };
    }

    return null;
  }

  /**
   * Feed a batched set of events to a proposer replica via runtime entityInputs.
   */
  private queueEventBatchToProposer(
    entityId: string,
    signerId: string,
    events: any[],
    blockNumber: number,
    blockHash: string,
    env: Env
  ): void {
    const jEvents = events
      .map(event => this.rpcEventToJEvent(entityId, event))
      .filter(Boolean);

    if (jEvents.length === 0) {
      return;
    }

    const entityTx = {
      type: 'j_event' as const,
      data: {
        from: signerId,
        observedAt: this.getEventTimestamp(),
        blockNumber,
        blockHash,
        transactionHash: `rpc-${blockNumber}-${this.syntheticTxCounter++}`,
        events: jEvents,
        event: jEvents[0],
      },
    };

    console.log(`🚨 J-WATCHER-CREATING-EVENT: ${signerId} creating j-event batch block=${blockNumber} for entity ${entityId.slice(0,10)}... (${jEvents.length} events)`);
    env.runtimeInput.entityInputs.push({
      entityId: entityId,
      signerId: signerId,
      entityTxs: [entityTx],
    });

    console.log(`🔭✅ J-WATCHER-QUEUED: ${signerId} → Entity ${entityId.slice(0,10)}... (${jEvents.length} events) block=${blockNumber} - Queue length now: ${env.runtimeInput.entityInputs.length}`);
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

  private getEventTimestamp(): number {
    return this.env?.timestamp ?? 0;
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

  // Legacy signer registry intentionally omitted (first-principles design).

  await watcher.startWatching(env);

  if (DEBUG) {
    console.log('🔭✅ J-WATCHER: Setup complete with first-principles design');
  }

  return watcher;
}

/**
 * Helper function to set up watcher with BrowserVM (simnet mode)
 */
export async function setupBrowserVMWatcher(
  env: Env,
  browserVM: BrowserVMEventSource,
): Promise<JEventWatcher> {
  const watcher = createJEventWatcher({
    rpcUrl: '', // Not used in BrowserVM mode
    entityProviderAddress: '',
    depositoryAddress: '',
    browserVM,
  });

  await watcher.startWatching(env);

  console.log('🔭✅ J-WATCHER: Setup complete with BrowserVM mode');

  return watcher;
}
