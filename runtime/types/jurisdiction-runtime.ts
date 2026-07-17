import type { JAdapter } from '../jadapter/types';
import type { JBatch } from '../jurisdiction/batch';
import type { EntityProviderActionJTxData } from './entity-provider-actions';

export type CertifiedRegistrationEvidence = {
  version: 1;
  source: 'FoundationBootstrapped' | 'EntityRegistered';
  stackKey: string;
  entityId: string;
  boardHash: string;
  activationHeight: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  emitter: string;
  topics: string[];
  data: string;
  rawLogDigest: string;
  receiptsRoot: string;
  encodedReceipt: string;
  receiptProofNodes: string[];
  receiptLogIndex: number;
  observedThroughHeight: number;
  observedTipBlockHash: string;
  observedHeadHeight: number;
  confirmationDepth: number;
  witnessRuntimeId: string;
  witnessSignature: string;
};

export type JAdapterFailureCategory = 'transient' | 'terminal';

/** Structured external-adapter failure retained across Runtime WAL replay. */
export type JAdapterFailure = {
  category: JAdapterFailureCategory;
  code: string;
  message: string;
};

/**
 * JReplica = Jurisdiction replica (J-Machine EVM state)
 * Contains optional stateRoot for BrowserVM time travel + decoded contracts for UI.
 * RPC-backed jurisdictions are external machines; do not fake a bytes32 root.
 */
export interface JReplica {
  name: string;                           // "ethereum", "base", "simnet"
  blockNumber: bigint;                    // Current J-block height
  stateRoot: Uint8Array | null;           // 32 bytes for BrowserVM time travel; null for RPC/external roots
  mempool: JTx[];                         // Pending settlement txs

  // Block creation delay (ms-based for universal timing)
  // Creates visual delay where batches sit in mempool as yellow cubes
  blockDelayMs: number;                   // Delay in ms before processing mempool (default: 300)
  blockTimeMs?: number;                   // Settlement-chain block time estimate used for cross-j wall-clock deadlines
  lastBlockTimestamp: number;             // Timestamp (ms) of last block creation
  blockReady?: boolean;                   // True when mempool has items and blockDelayMs elapsed

  // JAdapter instance (for balance queries, transactions, etc)
  // Works with both browservm and rpc modes
  jadapter?: JAdapter;
  // RPC endpoints for this jurisdiction (preferred for j-watcher + batch broadcast)
  rpcs?: string[];
  // Chain id (optional, prefer jadapter.chainId when available)
  chainId?: number;
  // Persisted local view of depository.defaultDisputeDelay for deterministic handlers.
  defaultDisputeDelayBlocks?: number;
  /** Trusted watcher finality policy persisted with validator-local receipt evidence. */
  watcherConfirmationDepth?: number;

  // Visual position (for 3D rendering)
  position: { x: number; y: number; z: number };

  // Contract addresses (primary)
  depositoryAddress?: string; // Primary depository address (for replay protection)
  entityProviderAddress?: string; // Primary entity provider address
  entityProviderDeploymentBlock?: number;

  // Additional deployed contract addresses.
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
}

/** J-Machine transaction (settlement layer) */
export type JTx =
  | {
      type: 'batch'; // ALL J-operations go through batch (matches Depository.processBatch)
      entityId: string;
      data: {
        batch: JBatch;
        hankoSignature?: string; // Quorum hanko (attached post-commit by entity consensus)
        batchHash?: string; // Hash of encoded batch (for hanko signing)
        encodedBatch?: string; // ABI-encoded batch (for on-chain submission)
        entityNonce?: number; // Entity nonce used for this batch
        /** Deterministic Entity broadcast generation; never ABI-encoded. */
        batchGeneration?: number;
        feeOverrides?: {
          gasBumpBps?: number;
          maxFeePerGasWei?: string;
          maxPriorityFeePerGasWei?: string;
        };
        batchSize: number;
        signerId?: string;
        /** Runtime-local WAL attempt metadata. Never ABI-encoded. */
        runtimeSubmitAttempt?: {
          attemptId: string;
          attemptNumber: number;
          attemptedAt: number;
          batchGeneration: number;
        };
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
    }
  | {
      type: 'debtEnforcement'; // Drain FIFO debt from Depository reserves.
      entityId: string;
      data: {
        tokenId: number;
        maxIterations: bigint;
        signerId?: string;
      };
      timestamp: number;
    }
  | {
      type: 'entityProviderTransfer';
      entityId: string;
      data: EntityProviderActionJTxData;
      timestamp: number;
    }
  | {
      type: 'entityProviderReleaseControlShares';
      entityId: string;
      data: EntityProviderActionJTxData;
      timestamp: number;
    }
  | {
      type: 'entityProviderCancelAction';
      entityId: string;
      data: EntityProviderActionJTxData;
      timestamp: number;
    };
