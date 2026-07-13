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

/**
 * Jurisdiction event data for j_event transactions.
 * Includes a canonical eventsHash so BFT consensus is over the exact event set,
 * not merely over a block hash observed by signers.
 */
export interface JurisdictionEventData {
  from: string;
  jurisdictionRef: string;
  event: JurisdictionEvent;
  events?: JurisdictionEvent[];
  // Optional calldata-derived evidence. This is deliberately outside
  // canonical eventsHash: transformer args are adversarial evidence and must not
  // fork J-event consensus when a provider cannot serve transaction input.
  disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
  disputeFinalizationEvidenceHash?: string;
  eventsHash?: string;
  signature?: string;
  observedAt: number;
  blockNumber: number;
  blockHash: string;
  /** Debug metadata only; each canonical event carries its own transactionHash. */
  transactionHash?: string;
}

/**
 * Observation of a J-block by a single signer.
 * Submitted as j_event EntityTx, aggregated by entity consensus.
 */
export interface JBlockObservation {
  signerId: string;
  jurisdictionRef: string;
  jHeight: number;
  jBlockHash: string;
  eventsHash: string;
  events: JurisdictionEvent[];
  signature: string;
  disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
  disputeFinalizationEvidenceHash?: string;
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

/**
 * One validator's signed claim about its complete jurisdiction history through
 * a height. The eventHistoryRoot is an append-only accumulator over that
 * validator's own event-block observations; histories are never unioned.
 */
export interface JHistoryCheckpoint {
  signerId: string;
  jurisdictionRef: string;
  baseHeight: number;
  scannedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
  signature: string;
}

export interface JHistoryCheckpointAttestation {
  signerId: string;
  signedThroughHeight: number;
  tipBlockHash: string;
  eventHistoryRoot: string;
  signature: string;
}

/** Stake-quorum certificate for one common validator-history prefix. */
export interface JHistoryFinality {
  jurisdictionRef: string;
  baseHeight: number;
  finalizedThroughHeight: number;
  /** Present only when a supporting checkpoint ends exactly at the finalized prefix. */
  tipBlockHash?: string;
  eventHistoryRoot: string;
  attestations: JHistoryCheckpointAttestation[];
  signerCount: number;
  signerPower: bigint;
}

/**
 * One validator's immutable vote inside a finalized J-block certificate.
 * The shared block identity and eventsHash live on JBlockFinalized; these
 * fields retain enough data to independently verify each validator signature.
 */
export interface JBlockAttestation {
  signerId: string;
  signature: string;
  disputeFinalizationEvidenceHash?: string;
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
  events: JurisdictionEvent[];
  attestations: JBlockAttestation[];
  finalizedAt: number;
  signerCount: number;
  signerPower: bigint;
}
