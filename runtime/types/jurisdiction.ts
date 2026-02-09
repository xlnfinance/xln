/**
 * Jurisdiction types - J-layer EVM settlement, events, blocks
 */

import type { JAdapter } from '../jadapter/types';

// ═══════════════════════════════════════════════════════════════
// JURISDICTION EVENTS
// ═══════════════════════════════════════════════════════════════

/**
 * Common metadata for all J-events (for JBlock tracking)
 */
interface JEventMetadata {
  blockNumber?: number;      // J-block number where event occurred
  blockHash?: string;        // J-block hash for consensus
  transactionHash?: string;  // On-chain transaction hash
}

/**
 * Jurisdiction event types - discriminated union for type safety
 * Each on-chain event has its own typed data structure
 */
export type JurisdictionEvent =
  | (JEventMetadata & {
      type: 'ReserveUpdated';
      data: {
        entity: string;
        tokenId: number;
        newBalance: string;
        symbol?: string;   // Optional - BrowserVM doesn't have token registry
        decimals?: number; // Optional - use TOKEN_REGISTRY lookup if missing
      };
    })
  | (JEventMetadata & {
      type: 'SecretRevealed';
      data: {
        hashlock: string;
        revealer: string;
        secret: string;
      };
    })
  | (JEventMetadata & {
      type: 'AccountSettled';
      data: {
        leftEntity: string;
        rightEntity: string;
        counterpartyEntityId: string;
        tokenId: number;
        ownReserve: string;
        counterpartyReserve: string;
        collateral: string;
        ondelta: string;
        side: 'left' | 'right';
      };
    })
  | (JEventMetadata & {
      type: 'InsuranceClaimed';
      data: {
        insured: string;
        insurer: string;
        creditor: string;
        tokenId: number;
        amount: string;
      };
    })
  | (JEventMetadata & {
      type: 'GovernanceEnabled';
      data: {
        entityId: string;
        proposalThreshold: number;
      };
    })
  | (JEventMetadata & {
      type: 'HankoBatchProcessed';
      data: {
        entityId: string;      // Entity that submitted the batch
        hankoHash: string;     // Hash of hanko data for verification
        nonce: number;         // Batch nonce (incrementing per entity)
        success: boolean;      // Whether batch processing succeeded
      };
    })
  | (JEventMetadata & {
      type: 'InsuranceRegistered';
      data: {
        insured: string;
        insurer: string;
        tokenId: number;
        limit: string;
        expiresAt: string;
      };
    })
  | (JEventMetadata & {
      type: 'InsuranceExpired';
      data: {
        insured: string;
        insurer: string;
        tokenId: number;
      };
    })
  | (JEventMetadata & {
      type: 'DebtCreated';
      data: {
        debtor: string;
        creditor: string;
        tokenId: number;
        amount: string;
        debtIndex: number;
      };
    })
  | (JEventMetadata & {
      type: 'DisputeStarted';
      data: {
        sender: string;
        counterentity: string;
        disputeNonce: string;
        proofbodyHash: string;
        initialArguments: string;
      };
    })
  | (JEventMetadata & {
      type: 'DisputeFinalized';
      data: {
        sender: string;
        counterentity: string;
        initialDisputeNonce: string;
        initialProofbodyHash: string;
        finalProofbodyHash: string;
      };
    })
  | (JEventMetadata & {
      type: 'DebtEnforced';
      data: {
        debtor: string;
        creditor: string;
        tokenId: number;
        amountPaid: string;
        remainingAmount: string;
        newDebtIndex: number;
      };
    });

/**
 * Jurisdiction event data for j_event transactions
 * Now with typed event discriminated union and JBlock consensus info
 */
export interface JurisdictionEventData {
  from: string;
  event: JurisdictionEvent;
  events?: JurisdictionEvent[]; // Batched events from same block
  observedAt: number;
  blockNumber: number;
  blockHash: string;  // Block hash for JBlock consensus
  transactionHash: string;
}

// ═══════════════════════════════════════════════════════════════
// J-BLOCK CONSENSUS (Multi-signer agreement on J-machine state)
// ═══════════════════════════════════════════════════════════════

export const JBLOCK_LIVENESS_INTERVAL = 100;

/**
 * Observation of a J-block by a single signer.
 * Submitted as j_event EntityTx, aggregated by entity consensus.
 */
export interface JBlockObservation {
  signerId: string;              // Who observed this
  jHeight: number;               // J-machine block number
  jBlockHash: string;            // EVM block hash (or BrowserVM frame hash)
  events: JurisdictionEvent[];   // Events relevant to this entity in this block
  observedAt: number;            // When signer observed this (for timeout detection)
}

/**
 * Finalized J-block after threshold agreement.
 * Events from this block can be safely applied to entity state.
 */
export interface JBlockFinalized {
  jHeight: number;
  jBlockHash: string;
  events: JurisdictionEvent[];
  finalizedAt: number;           // When consensus was reached
  signerCount: number;           // How many signers agreed (for audit)
}

// ═══════════════════════════════════════════════════════════════
// J-LAYER INPUTS & TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

/** J-layer input - queues JTx to jurisdiction mempool */
export interface JInput {
  jurisdictionName: string; // Which J-machine to queue to
  jTxs: JTx[]; // Transactions to queue
}

/** J-Machine transaction (settlement layer) */
export type JTx =
  | {
      type: 'batch'; // ALL J-operations go through batch (matches Depository.processBatch)
      entityId: string;
      data: {
        batch: any; // JBatch structure from j-batch.ts
        hankoSignature?: string;
        batchSize: number;
        signerId?: string;
      };
      timestamp: number;
      expectedJBlock?: number; // Expected j-block height (for replay protection)
    }
  | {
      type: 'mint'; // Admin/debug function for minting reserves
      entityId: string;
      data: {
        entityId: string;
        tokenId: number;
        amount: bigint;
      };
      timestamp: number;
    };

// ═══════════════════════════════════════════════════════════════
// J-REPLICA (Jurisdiction EVM state)
// ═══════════════════════════════════════════════════════════════

/**
 * JReplica = Jurisdiction replica (J-Machine EVM state)
 * Contains stateRoot for time travel + decoded contracts for UI
 */
export interface JReplica {
  name: string;                           // "ethereum", "base", "simnet"
  blockNumber: bigint;                    // Current J-block height
  stateRoot: Uint8Array;                  // 32 bytes - for time travel via setStateRoot()
  mempool: JTx[];                         // Pending settlement txs

  // Block creation delay (ms-based for universal timing)
  // Creates visual delay where batches sit in mempool as yellow cubes
  blockDelayMs: number;                   // Delay in ms before processing mempool (default: 300)
  lastBlockTimestamp: number;             // Timestamp (ms) of last block creation
  blockReady?: boolean;                   // True when mempool has items and blockDelayMs elapsed

  // JAdapter instance (for balance queries, transactions, etc)
  // Works with both browservm and rpc modes
  jadapter?: JAdapter;
  // RPC endpoints for this jurisdiction (preferred for j-watcher + batch broadcast)
  rpcs?: string[];
  // Chain id (optional, prefer jadapter.chainId when available)
  chainId?: number;

  // Visual position (for 3D rendering)
  position: { x: number; y: number; z: number };

  // Contract addresses (primary)
  depositoryAddress?: string; // Primary depository address (for replay protection)
  entityProviderAddress?: string; // Primary entity provider address

  // Decoded contract addresses for UI (deprecated - use depositoryAddress/entityProviderAddress)
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };

  // === SYNCED FROM DEPOSITORY.SOL ===
  // mapping(bytes32 => mapping(uint => uint)) _reserves
  reserves?: Map<string, Map<number, bigint>>;  // entityId -> tokenId -> amount

  // mapping(bytes => mapping(uint => AccountCollateral)) _collaterals
  collaterals?: Map<string, Map<number, { collateral: bigint; ondelta: bigint }>>; // accountKey -> tokenId -> {collateral, ondelta}

  // mapping(bytes32 => InsuranceLine[]) insuranceLines
  insuranceLines?: Map<string, Array<{ insurer: string; tokenId: number; remaining: bigint; expiresAt: bigint }>>;

  // === SYNCED FROM ENTITYPROVIDER.SOL ===
  // mapping(bytes32 => Entity) entities
  registeredEntities?: Map<string, { name: string; quorum: string[]; threshold: number }>;
}
