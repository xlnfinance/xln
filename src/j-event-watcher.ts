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

// Event types we care about from the jurisdiction
interface JurisdictionEvent {
  type: 'entity_registered' | 'control_shares_released' | 'shares_received' | 'name_assigned';
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
  private isWatching: boolean = false;

  // Contract ABIs (minimal for events we care about)
  private entityProviderABI = [
    "event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash)",
    "event ControlSharesReleased(bytes32 indexed entityId, address indexed depository, uint256 controlAmount, uint256 dividendAmount, string purpose)",
    "event NameAssigned(string indexed name, uint256 indexed entityNumber)"
  ];

  private depositoryABI = [
    "event ControlSharesReceived(address indexed entityProvider, address indexed fromEntity, uint256 indexed tokenId, uint256 amount, bytes data)"
  ];

  constructor(config: WatcherConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    this.entityProviderContract = new ethers.Contract(
      config.entityProviderAddress,
      this.entityProviderABI,
      this.provider
    );

    this.depositoryContract = new ethers.Contract(
      config.depositoryAddress,
      this.depositoryABI,
      this.provider
    );

    this.lastProcessedBlock = config.startBlock || 0;
  }

  /**
   * Add a signer configuration for monitoring
   */
  addSigner(signerId: string, privateKey: string, entityIds: string[]) {
    this.signers.set(signerId, {
      signerId,
      privateKey,
      entityIds
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
    console.log(`🔭 J-WATCHER: Starting to watch from block ${this.lastProcessedBlock}`);

    // Set up event listeners for real-time events
    this.setupEventListeners(env);

    // Process any historical events we missed
    await this.processHistoricalEvents(env);

    console.log('🔭 J-WATCHER: Started successfully');
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
      this.handleJurisdictionEvent({
        type: 'entity_registered',
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        entityId: entityId.toString(),
        entityNumber: Number(entityNumber),
        data: { boardHash }
      }, env);
    });

    this.entityProviderContract.on('ControlSharesReleased', (entityId, depository, controlAmount, dividendAmount, purpose, event) => {
      this.handleJurisdictionEvent({
        type: 'control_shares_released',
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        entityId: entityId.toString(),
        entityNumber: Number(entityId), // entityId is the number for registered entities
        data: { depository, controlAmount, dividendAmount, purpose }
      }, env);
    });

    this.entityProviderContract.on('NameAssigned', (name, entityNumber, event) => {
      this.handleJurisdictionEvent({
        type: 'name_assigned',
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        entityNumber: Number(entityNumber),
        data: { name }
      }, env);
    });

    // Depository events
    this.depositoryContract.on('ControlSharesReceived', (entityProvider, fromEntity, tokenId, amount, data, event) => {
      // Extract entity number from tokenId (control tokens use entity number directly)
      const entityNumber = this.extractEntityNumberFromTokenId(Number(tokenId));

      this.handleJurisdictionEvent({
        type: 'shares_received',
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        entityNumber: entityNumber,
        data: { entityProvider, fromEntity, tokenId, amount, data }
      }, env);
    });
  }

  /**
   * Process historical events since last processed block
   */
  private async processHistoricalEvents(env: Env): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();

      if (this.lastProcessedBlock >= currentBlock) {
        if (DEBUG) console.log('🔭 J-WATCHER: No new blocks to process');
        return;
      }

      console.log(`🔭 J-WATCHER: Processing blocks ${this.lastProcessedBlock + 1} to ${currentBlock}`);

      // Get events in batches to avoid RPC limits
      const batchSize = 1000;
      for (let fromBlock = this.lastProcessedBlock + 1; fromBlock <= currentBlock; fromBlock += batchSize) {
        const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);

        await this.processBlockRange(fromBlock, toBlock, env);
      }

      this.lastProcessedBlock = currentBlock;
    } catch (error) {
      console.error('🔭 J-WATCHER: Error processing historical events:', error);
    }
  }

  /**
   * Process events in a specific block range
   */
  private async processBlockRange(fromBlock: number, toBlock: number, env: Env): Promise<void> {
    try {
      // Get all relevant events from both contracts
      const [epEvents, depEvents] = await Promise.all([
        this.entityProviderContract.queryFilter("", fromBlock, toBlock),
        this.depositoryContract.queryFilter("", fromBlock, toBlock)
      ]);

      // Process events in chronological order
      const allEvents = [...epEvents, ...depEvents].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return a.transactionIndex - b.transactionIndex;
      });

      for (const event of allEvents) {
        await this.processContractEvent(event, env);
      }

    } catch (error) {
      console.error(`🔭 J-WATCHER: Error processing blocks ${fromBlock}-${toBlock}:`, error);
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
            data: { boardHash: event.args.boardHash }
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
              purpose: event.args.purpose
            }
          };
          break;

        case 'NameAssigned':
          jurisdictionEvent = {
            type: 'name_assigned',
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            entityNumber: Number(event.args.entityNumber),
            data: { name: event.args.name }
          };
          break;

        case 'ControlSharesReceived':
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
              data: event.args.data
            }
          };
          break;

        default:
          return; // Skip unknown events
      }

      this.handleJurisdictionEvent(jurisdictionEvent, env);

    } catch (error) {
      console.error('🔭 J-WATCHER: Error processing contract event:', error);
    }
  }

  /**
   * Handle a jurisdiction event by creating entity transactions
   */
  private handleJurisdictionEvent(jEvent: JurisdictionEvent, env: Env): void {
    if (DEBUG) {
      console.log(`🔭 J-EVENT: ${jEvent.type} at block ${jEvent.blockNumber} for entity #${jEvent.entityNumber}`);
      console.log(`🔭 J-EVENT-DATA:`, jEvent.data);
    }

    // Find all signers that care about this entity
    const interestedSigners = Array.from(this.signers.values()).filter(signer => {
      const entityId = jEvent.entityNumber?.toString();
      return entityId && signer.entityIds.includes(entityId);
    });

    if (interestedSigners.length === 0) {
      if (DEBUG) console.log(`🔭 J-EVENT: No signers interested in entity #${jEvent.entityNumber}`);
      return;
    }

    // Create entity transaction for each interested signer
    for (const signer of interestedSigners) {
      const entityTx: EntityTx = {
        type: 'j_event',
        data: {
          from: signer.signerId,
          event: jEvent,
          observedAt: Date.now(),
          blockNumber: jEvent.blockNumber,
          transactionHash: jEvent.transactionHash
        }
      };

      // Submit to entity via server input
      if (env.serverInput && jEvent.entityNumber) {
        env.serverInput.entityInputs.push({
          entityId: jEvent.entityNumber.toString(),
          signerId: signer.signerId,
          entityTxs: [entityTx]
        });

        if (DEBUG) {
          console.log(`🔭 J-SUBMIT: Signer ${signer.signerId} submitting j-event to entity #${jEvent.entityNumber}`);
        }
      }
    }
  }

  /**
   * Extract entity number from token ID
   * Control tokens use entity number directly, dividend tokens have high bit set
   */
  private extractEntityNumberFromTokenId(tokenId: number): number {
    // Remove the high bit if set (dividend token)
    return tokenId & 0x7FFFFFFF;
  }

  /**
   * Get current watching status
   */
  getStatus(): { isWatching: boolean; lastProcessedBlock: number; signerCount: number } {
    return {
      isWatching: this.isWatching,
      lastProcessedBlock: this.lastProcessedBlock,
      signerCount: this.signers.size
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
export async function setupJEventWatcher(env: Env, rpcUrl: string, entityProviderAddr: string, depositoryAddr: string): Promise<JEventWatcher> {
  const watcher = createJEventWatcher({
    rpcUrl,
    entityProviderAddress: entityProviderAddr,
    depositoryAddress: depositoryAddr,
    startBlock: 0 // Start from genesis, or could be configured
  });

  // Add example signers (would be configured per deployment)
  watcher.addSigner('alice', 'alice-private-key', ['1', '2', '3']);
  watcher.addSigner('bob', 'bob-private-key', ['1', '2']);

  await watcher.startWatching(env);

  return watcher;
}
