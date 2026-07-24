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
  startedByLeft: boolean;
  sig: string;
}

/**
 * Jurisdiction event types - discriminated union for type safety.
 * Each on-chain event has its own typed data structure.
 */
export type JurisdictionEvent =
  | (JEventMetadata & {
      type: 'FoundationBootstrapped';
      data: {
        recipient: string;
        boardHash: string;
        controlTokenId: string;
        dividendTokenId: string;
      };
    })
  | (JEventMetadata & {
      type: 'EntityRegistered';
      data: {
        entityId: string;
        entityNumber: string;
        boardHash: string;
      };
    })
  | (JEventMetadata & {
      type: 'BoardActivated';
      data: {
        entityId: string;
        previousBoardHash: string;
        newBoardHash: string;
        /** Exclusive Unix-second validity boundary emitted by EntityProvider. */
        previousBoardValidUntil: string;
      };
    })
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
      type: 'BatchOperationSkipped';
      data: {
        entityId: string;
        batchHash: string;
        nonce: number;
        operationType: 0 | 1 | 2 | 3 | 4;
        operationIndex: number;
        reason: 0;
      };
    })
  | (JEventMetadata & {
      type: 'HankoBatchProcessed';
      data: {
        entityId: string;
        batchHash: string;
        nonce: number;
      };
    })
  | (JEventMetadata & {
      type: 'EntityProviderActionExecuted';
      data: {
        entityId: string;
        actionNonce: string;
        actionHash: string;
        actionKind: 0 | 1;
      };
    })
  | (JEventMetadata & {
      type: 'EntityProviderActionCancelled';
      data: {
        entityId: string;
        actionNonce: string;
        cancelledActionHash: string;
        cancelledActionKind: 0 | 1;
        cancelHash: string;
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
        disputeTimeout: number;
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
  /** Highest header present for every height after the certified anchor. */
  contiguousThroughHeight: number;
  tipBlockHash: string;
  eventBlocks: Map<number, ValidatorJEventBlock>;
  blockHashes: Map<number, string>;
}

/**
 * Exact validator-local J prefix body authorized for one Entity frame round.
 * A validator signs at most one claim per signer + target Entity height. A
 * later local scan stays durable and becomes the vote for the next height
 * after this round commits; it never mutates or supersedes this signed vote.
 */
export interface JPrefixClaim {
  jurisdictionRef: string;
  baseHeight: number;
  scannedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
  rangeHash: string;
  blocks: JurisdictionEventBlock[];
}

/**
 * One validator's signed, locally derived jurisdiction head.
 *
 * The contiguous headers make a longer head independently clip-able at a
 * shorter validator tip. Signing only the longest tip would not prove that
 * H14 and H12 share the exact H12 chain prefix when H12 is an empty block.
 */
export interface JPrefixAttestation extends JPrefixClaim {
  version: 1;
  entityId: string;
  targetEntityHeight: number;
  parentFrameHash: string;
  validatorId: string;
  headers: ValidatorJBlockHeader[];
  signature: string;
}

/** Weighted certificate selecting the highest exact prefix common to its signed head set. */
export interface JPrefixCertificate {
  version: 1;
  entityId: string;
  targetEntityHeight: number;
  parentFrameHash: string;
  jurisdictionRef: string;
  baseHeight: number;
  selected: JPrefixClaim;
  attestations: Map<string, JPrefixAttestation>;
}

/** Validator-private durable collection for one Entity-height J-prefix round. */
export interface JPrefixRound {
  targetEntityHeight: number;
  parentFrameHash: string;
  jurisdictionRef: string;
  baseHeight: number;
  attestations: Map<string, JPrefixAttestation>;
  certificate?: JPrefixCertificate;
}

/** One current Entity-certified settlement-chain head. */
export interface JHistoryFinality {
  jurisdictionRef: string;
  baseHeight: number;
  finalizedThroughHeight: number;
  tipBlockHash: string;
  /** Rolling commitment advanced from the preceding certified root. */
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
