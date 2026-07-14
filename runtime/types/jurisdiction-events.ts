/**
 * Common metadata for all J-events (for JBlock tracking).
 */
interface JEventMetadata {
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  /** Canonical EVM log position within the block. */
  logIndex?: number;
  /** Stable order when one Solidity log expands into multiple xln events. */
  eventIndex?: number;
}

export interface DisputeFinalizationEvidence {
  sender: string;
  counterentity: string;
  initialNonce: string;
  finalNonce: string;
  initialProofbodyHash: string;
  finalProofbodyHash: string;
  leftArguments: string;
  rightArguments: string;
  starterInitialArguments: string;
  starterIncrementedArguments: string;
  sig: string;
}

/**
 * Jurisdiction event types - discriminated union for type safety.
 * Each on-chain event has its own typed data structure.
 */
export type JurisdictionEvent =
  | (JEventMetadata & {
      type: 'ReserveUpdated';
      data: {
        entity: string;
        tokenId: number;
        newBalance: string;
        symbol?: string;
        decimals?: number;
      };
    })
  | (JEventMetadata & {
      type: 'ExternalWalletSnapshot';
      data: {
        entityId: string;
        owner: string;
        nativeBalance?: string;
        tokenBalances?: Array<{
          tokenAddress: string;
          tokenId?: number;
          balance: string;
        }>;
        allowances?: Array<{
          tokenAddress: string;
          spender: string;
          allowance: string;
        }>;
      };
    })
  | (JEventMetadata & {
      type: 'ExternalWalletDelta';
      data: {
        entityId: string;
        owner: string;
        tokenAddress: string;
        tokenId?: number;
        balanceDelta?: string;
        spender?: string;
        allowance?: string;
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
        tokenId: number;
        leftReserve: string;
        rightReserve: string;
        collateral: string;
        ondelta: string;
        nonce: number;
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
        entityId: string;
        hankoHash: string;
        nonce: number;
        success: boolean;
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
        nonce: string;
        proofbodyHash: string;
        watchSeed: string;
        starterInitialArguments: string;
        starterIncrementedArguments: string;
        batchNonce?: number;
      };
    })
  | (JEventMetadata & {
      type: 'DisputeFinalized';
      data: {
        sender: string;
        counterentity: string;
        initialNonce: string;
        initialProofbodyHash: string;
        finalProofbodyHash: string;
        batchNonce?: number;
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
    })
  | (JEventMetadata & {
      type: 'DebtForgiven';
      data: {
        debtor: string;
        creditor: string;
        tokenId: number;
        amountForgiven: string;
        debtIndex: number;
      };
    });

/** One event-bearing EVM block inside an ordered jurisdiction range. */
export interface JurisdictionEventBlock {
  blockNumber: number;
  blockHash: string;
  eventsHash: string;
  events: JurisdictionEvent[];
  disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
  disputeFinalizationEvidenceHash?: string;
}

/**
 * One proposer-authenticated jurisdiction prefix. Validators compare this
 * exact ordered range with their own durable local history before signing the
 * enclosing Entity frame; the Entity Hanko is the only quorum certificate.
 */
export interface JurisdictionEventData {
  from: string;
  jurisdictionRef: string;
  baseHeight: number;
  scannedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
  rangeHash: string;
  blocks: JurisdictionEventBlock[];
  signature: string;
  observedAt: number;
}

/**
 * One canonical event-bearing jurisdiction block as observed by a validator.
 * This is local evidence until an Entity frame includes the same ordered
 * block in a J range and obtains the normal Entity Hanko.
 */
export interface ValidatorJEventBlock {
  jurisdictionRef: string;
  jHeight: number;
  jBlockHash: string;
  eventsHash: string;
  events: JurisdictionEvent[];
  disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
  disputeFinalizationEvidenceHash?: string;
}

export interface ValidatorJBlockHeader {
  jHeight: number;
  jBlockHash: string;
}

/**
 * Validator-private, durable J-chain view. It is persisted with EntityReplica
 * metadata but deliberately excluded from EntityState and every consensus
 * hash: validators may be synchronized to different chain heights.
 */
export interface ValidatorJHistory {
  jurisdictionRef: string;
  scannedThroughHeight: number;
  tipBlockHash: string;
  eventBlocks: Map<number, ValidatorJEventBlock>;
  blockHashes: Map<number, string>;
}

/** Entity-certified jurisdiction-history prefix. */
export interface JHistoryFinality {
  jurisdictionRef: string;
  baseHeight: number;
  finalizedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
  proposerSignerId: string;
  proposerSignature: string;
  entityHeight: number;
}

/**
 * Finalized J-block after threshold agreement.
 * Events from this block can be safely applied to entity state.
 */
export interface JBlockFinalized {
  jurisdictionRef: string;
  jHeight: number;
  jBlockHash: string;
  eventsHash: string;
  /**
   * Canonical hash of transaction-calldata evidence consumed by the reducer.
   * The event log alone does not bind finalNonce or transformer arguments.
   */
  disputeFinalizationEvidenceHash?: string;
  events: JurisdictionEvent[];
  finalizedAt: number;
  proposerSignerId: string;
  proposerSignature: string;
}
