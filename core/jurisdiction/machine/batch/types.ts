import type { ProofBodyStruct } from '../../../../jurisdictions/typechain-types/Depository.sol/Depository.js';
import type { JurisdictionConfig } from '../../../entity/types';
import type { RuntimeFailureSignal } from '../../../protocol/errors/failure-taxonomy';

export interface JBatch {
  reserveToExternalToken: Array<{
    receivingEntity: string;
    tokenId: number;
    amount: bigint;
  }>;
  externalTokenToReserve: Array<{
    entity: string;
    contractAddress: string;
    externalTokenId: bigint;
    tokenType: number;
    internalTokenId: number;
    amount: bigint;
  }>;
  reserveToReserve: Array<{
    receivingEntity: string;
    tokenId: number;
    amount: bigint;
  }>;
  reserveToCollateral: Array<{
    tokenId: number;
    receivingEntity: string;
    pairs: Array<{
      entity: string;
      amount: bigint;
    }>;
  }>;
  collateralToReserve: Array<{
    counterparty: string;
    tokenId: number;
    amount: bigint;
    nonce: number;
    sig: string;
  }>;
  settlements: Array<{
    leftEntity: string;
    rightEntity: string;
    diffs: Array<{
      tokenId: number;
      leftDiff: bigint;
      rightDiff: bigint;
      collateralDiff: bigint;
      ondeltaDiff: bigint;
    }>;
    forgiveDebtsInTokenIds: number[];
    sig: string;
    nonce: number;
  }>;
  disputeStarts: Array<{
    counterentity: string;
    nonce: number;
    proposerIsLeft: boolean;
    proofbodyHash: string;
    initialProofbody: ProofBodyStruct;
    watchSeed: string;
    sig: string;
    starterInitialArguments: string;
    starterCounterArguments: string;
    starterCounterProofCommitment: string;
  }>;
  counterDisputes: Array<{
    counterentity: string;
    initialNonce: number;
    initialProofbodyHash: string;
    counterNonce: number;
    proposerIsLeft: boolean;
    counterProofbody: ProofBodyStruct;
    sig: string;
  }>;
  disputeFinalizations: Array<{
    counterentity: string;
    initialNonce: number;
    finalNonce: number;
    proposerIsLeft: boolean;
    initialProofbodyHash: string;
    finalProofbody: ProofBodyStruct;
    starterArguments: string;
    otherArguments: string;
    sig: string;
    startedByLeft: boolean;
    cooperative: false;
    /** Exact authenticated L1 deadline; runtime-only and not ABI-encoded. */
    submitNotBeforeTimestamp?: number;
  }>;
  revealSecrets: Array<{
    transformer: string;
    secret: string;
  }>;
  hashLadderRegistrations: Array<{
    counterpartyEntity: string;
    targetRole: boolean;
    fullHash: string;
    partialRoot: string;
    witness: {
      fillRatio: number;
      fullSecret: string;
      reveals: [string, string, string, string];
    };
  }>;
}

type JBatchStatus = 'empty' | 'accumulating' | 'sent' | 'failed';

export interface SentJBatch {
  batch: JBatch;
  batchHash: string;
  encodedBatch: string;
  entityNonce: number;
  firstSubmittedAt: number;
  lastSubmittedAt: number;
  submitAttempts: number;
  feeOverrides?: Extract<import('../../../types/jurisdiction-runtime').JTx, { type: 'batch' }>['data']['feeOverrides'];
  txHash?: string;
  lastFailure?: {
    message: string;
    failedAt: number;
    failure: RuntimeFailureSignal;
  };
  terminalFailure?: {
    message: string;
    failedAt: number;
    failure?: RuntimeFailureSignal;
  };
}

export interface JBatchState {
  batch: JBatch;
  jurisdiction: JurisdictionConfig | null;
  lastBroadcast: number;
  broadcastCount: number;
  failedAttempts: number;
  status: JBatchStatus;
  sentBatch?: SentJBatch;
  /**
   * Still-valid operations recovered from an invalidated immutable sentBatch.
   * They stay separate because merging valid batches can exceed contract limits.
   */
  recoveryBatches?: JBatch[];
  autoBroadcastDraft?: boolean;
  entityNonce?: number;
}

export type OptionalDisputeArgumentWarning = Readonly<{
  code:
    | 'DISPUTE_OPTIONAL_ARGUMENT_MALFORMED'
    | 'DISPUTE_OPTIONAL_ARGUMENT_OVERSIZED'
    | 'DISPUTE_OPTIONAL_ARGUMENT_AGGREGATE_OVERSIZED';
  context: string;
  originalBytes: number;
  limitBytes: number;
}>;

export type SanitizedOptionalDisputeArgument = Readonly<{
  value: string;
  warnings: readonly OptionalDisputeArgumentWarning[];
}>;

export type SettlementBatchOp = JBatch['settlements'][number];
export type HashLadderRegistration = JBatch['hashLadderRegistrations'][number];
