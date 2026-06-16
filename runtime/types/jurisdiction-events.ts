/**
 * Common metadata for all J-events (for JBlock tracking).
 */
interface JEventMetadata {
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
}

export interface DisputeFinalizationEvidence {
  sender: string;
  counterentity: string;
  initialNonce: string;
  initialProofbodyHash: string;
  finalProofbodyHash: string;
  leftArguments: string;
  rightArguments: string;
  starterInitialArguments: string;
  starterIncrementedArguments: string;
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
  transactionHash: string;
}

/**
 * Observation of a J-block by a single signer.
 * Submitted as j_event EntityTx, aggregated by entity consensus.
 */
export interface JBlockObservation {
  signerId: string;
  jHeight: number;
  jBlockHash: string;
  eventsHash: string;
  events: JurisdictionEvent[];
  disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
  disputeFinalizationEvidenceHash?: string;
  observedAt: number;
}

/**
 * Finalized J-block after threshold agreement.
 * Events from this block can be safely applied to entity state.
 */
export interface JBlockFinalized {
  jHeight: number;
  jBlockHash: string;
  events: JurisdictionEvent[];
  finalizedAt: number;
  signerCount: number;
}
