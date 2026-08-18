/**
 * J-Batch Aggregator System
 *
 * Accumulates entity operations into batches for atomic on-chain submission.
 * Pattern from 2019src.txt lines 3309-3399 (sharedState.batch aggregation)
 *
 * Design:
 * - Each entity accumulates operations in their jBatch
 * - Server periodically broadcasts batches (every 5s or when full)
 * - Batch is cleared after successful submission
 * - Failed batches are retried (with exponential backoff)
 */

import { ethers } from 'ethers';
import type { ProofBodyStruct } from '../../../../jurisdictions/typechain-types/Depository.sol/Depository.js';
import { validateJBatch } from '../batch-validation';
import type { JurisdictionConfig } from '../../../entity/types';
import type { RuntimeFailureSignal } from '../../../protocol/errors/failure-taxonomy';
import { normalizeEntityId, compareEntityIds } from '../../../entity/id';
import { createStructuredLogger, shortHash, shortId } from '../../../support/logger';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';
import { hashDepositoryBatchHankoPayload } from '../../../hanko/onchain-domain';

const jBatchLog = createStructuredLogger('j.batch');

/**
 * Batch structure matching Depository.sol (lines 203-231)
 */
export interface JBatch {
  // Reserve ↔ External Token (deposits/withdrawals to/from blockchain)
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

  // Reserve ↔ Reserve (entity-to-entity transfers)
  reserveToReserve: Array<{
    receivingEntity: string;
    tokenId: number;
    amount: bigint;
  }>;

  // Reserve → Collateral (fund account)
  reserveToCollateral: Array<{
    tokenId: number;
    receivingEntity: string; // Which entity is depositing
    pairs: Array<{
      entity: string; // Counterparty in the account
      amount: bigint;
    }>;
  }>;

  // Collateral → Reserve (C2R shortcut - expands to Settlement on-chain)
  collateralToReserve: Array<{
    counterparty: string;
    tokenId: number;
    amount: bigint;
    nonce: number; // signed nonce (must be > stored account nonce)
    sig: string; // counterparty hanko (still bilateral)
  }>;

  // Settlements - MUST match Solidity Settlement struct exactly
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
    sig: string; // Hanko signature (required when there are changes)
    nonce: number; // Settlement nonce
  }>;

  // Dispute proofs (active in Depository.sol) - unified nonce model
  disputeStarts: Array<{
    counterentity: string;
    nonce: number; // unified nonce (must be > stored account nonce)
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
    initialNonce: number; // nonce when dispute was started
    finalNonce: number; // signed finalize nonce; unilateral timeout path may keep equal to initialNonce
    proposerIsLeft: boolean;
    initialProofbodyHash: string;
    finalProofbody: ProofBodyStruct;
    starterArguments: string;
    otherArguments: string;
    sig: string;
    startedByLeft: boolean;
    cooperative: boolean;
    /**
     * Runtime-only submission gate for timeout-authorized proofs. This is the
     * exact authenticated L1 deadline and is deliberately not ABI-encoded.
     */
    submitNotBeforeTimestamp?: number;
  }>;

  // Flashloans (for atomic batch execution)
  flashloans: Array<{
    tokenId: number;
    amount: bigint;
  }>;

  // HTLC secret reveals (on-chain hashlock unlocks)
  revealSecrets: Array<{
    transformer: string;
    secret: string;
  }>;

  // Independent Sprites-like public evidence. The outer processBatch Hanko
  // authenticates the revealing Entity; counterpartyEntity derives the exact
  // bilateral Account namespace and has no authority outside that namespace.
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

/** Batch lifecycle: current accumulates, sentBatch tracks one in-flight submission */
type JBatchStatus = 'empty' | 'accumulating' | 'sent' | 'failed';

/** In-flight batch snapshot (authoritative until HankoBatchProcessed arrives). */
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

/**
 * JBatch state for an entity
 */
export interface JBatchState {
  batch: JBatch;
  jurisdiction: JurisdictionConfig | null;
  lastBroadcast: number;
  broadcastCount: number;
  failedAttempts: number;

  // Lifecycle tracking
  status: JBatchStatus;
  sentBatch?: SentJBatch;
  /**
   * Still-valid operations recovered from an invalidated immutable sentBatch.
   * They are broadcast before the editable draft and never merged into it:
   * two individually valid 50-op batches may not form one contract-valid batch.
   */
  recoveryBatches?: JBatch[];
  /** A protocol-forced draft must broadcast as soon as the in-flight batch clears. */
  autoBroadcastDraft?: boolean;
  entityNonce?: number; // Entity nonce used for this batch (for replay prevention)
}

export const J_BATCH_CONTRACT_LIMITS = {
  maxTotalOps: 50,
  maxFlashloans: 8,
  maxSettlements: 32,
  maxSettlementDiffs: 32,
  maxSettlementForgivenessIds: 32,
  maxDisputeStarts: 8,
  maxCounterDisputes: 8,
  // One transformer-capable finalization plus 100% gas reserve fits the
  // EIP-7825 2^24 transaction cap; independent disputes use independent txs.
  maxDisputeFinalizations: 1,
  maxReserveToCollateralPairs: 64,
  maxReserveToCollateralPairsTotal: 256,
  maxSecretReveals: 32,
  maxHashLadderRegistrations: 32,
  maxEncodedBatchBytes: 256 * 1024,
  maxDisputeProofBodyBytes: 176 * 1024,
  maxDisputeStarterArgumentsBytes: 64 * 1024,
  maxDisputeProofTokens: 128,
  maxDisputeTransformers: 32,
} as const;

const requireBatchRoom = (
  batch: JBatch,
  operation: string,
  addedOps = 1,
): void => {
  const nextSize = batchOpCount(batch) + Math.max(0, addedOps);
  if (nextSize > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: ${operation} would exceed total ops ` +
      `${nextSize}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
    );
  }
};

const requireArrayRoom = (
  name: string,
  currentLength: number,
  added: number,
  max: number,
): void => {
  const nextLength = currentLength + Math.max(0, added);
  if (nextLength > max) {
    throw new Error(`J_BATCH_LIMIT_EXCEEDED: ${name} ${nextLength}/${max}`);
  }
};

export function getJBatchContractLimitIssue(batch: JBatch): string | null {
  const totalOps = batchOpCount(batch);
  if (totalOps > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    return `total ops ${totalOps}/${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`;
  }
  if (batch.flashloans.length > J_BATCH_CONTRACT_LIMITS.maxFlashloans) {
    return `flashloans ${batch.flashloans.length}/${J_BATCH_CONTRACT_LIMITS.maxFlashloans}`;
  }
  if (batch.settlements.length > J_BATCH_CONTRACT_LIMITS.maxSettlements) {
    return `settlements ${batch.settlements.length}/${J_BATCH_CONTRACT_LIMITS.maxSettlements}`;
  }
  if (batch.disputeStarts.length > J_BATCH_CONTRACT_LIMITS.maxDisputeStarts) {
    return `disputeStarts ${batch.disputeStarts.length}/${J_BATCH_CONTRACT_LIMITS.maxDisputeStarts}`;
  }
  if (batch.counterDisputes.length > J_BATCH_CONTRACT_LIMITS.maxCounterDisputes) {
    return `counterDisputes ${batch.counterDisputes.length}/${J_BATCH_CONTRACT_LIMITS.maxCounterDisputes}`;
  }
  if (batch.disputeFinalizations.length > J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations) {
    return `disputeFinalizations ${batch.disputeFinalizations.length}/${J_BATCH_CONTRACT_LIMITS.maxDisputeFinalizations}`;
  }
  if (batch.revealSecrets.length > J_BATCH_CONTRACT_LIMITS.maxSecretReveals) {
    return `revealSecrets ${batch.revealSecrets.length}/${J_BATCH_CONTRACT_LIMITS.maxSecretReveals}`;
  }
  if (batch.hashLadderRegistrations.length > J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations) {
    return `hashLadderRegistrations ${batch.hashLadderRegistrations.length}/${J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations}`;
  }
  for (const [index, op] of batch.reserveToCollateral.entries()) {
    if (op.tokenId <= 0 || !Number.isSafeInteger(op.tokenId)) {
      return `reserveToCollateral[${index}].tokenId must be a positive safe integer`;
    }
    if (op.pairs.length === 0) {
      return `reserveToCollateral[${index}].pairs must not be empty`;
    }
    if (op.pairs.some((pair) => pair.amount <= 0n)) {
      return `reserveToCollateral[${index}].pairs amounts must be positive`;
    }
    if (op.pairs.length > J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairs) {
      return `reserveToCollateral[${index}].pairs ${op.pairs.length}/${J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairs}`;
    }
  }
  const reserveToCollateralPairCount = batch.reserveToCollateral.reduce(
    (count, operation) => count + operation.pairs.length,
    0,
  );
  if (
    reserveToCollateralPairCount
    > J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairsTotal
  ) {
    return (
      `reserveToCollateral.pairs total ${reserveToCollateralPairCount}/`
      + `${J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairsTotal}`
    );
  }
  for (const [index, settlement] of batch.settlements.entries()) {
    if (settlement.diffs.length > J_BATCH_CONTRACT_LIMITS.maxSettlementDiffs) {
      return `settlements[${index}].diffs ${settlement.diffs.length}/${J_BATCH_CONTRACT_LIMITS.maxSettlementDiffs}`;
    }
    if (
      settlement.forgiveDebtsInTokenIds.length
      > J_BATCH_CONTRACT_LIMITS.maxSettlementForgivenessIds
    ) {
      return (
        `settlements[${index}].forgiveDebtsInTokenIds `
        + `${settlement.forgiveDebtsInTokenIds.length}/${J_BATCH_CONTRACT_LIMITS.maxSettlementForgivenessIds}`
      );
    }
  }
  return null;
}

export function assertJBatchWithinContractLimits(batch: JBatch, context = 'jBatch'): void {
  const issue = getJBatchContractLimitIssue(batch);
  if (issue) {
    throw new Error(`J_BATCH_LIMIT_EXCEEDED: ${context}: ${issue}`);
  }
}

/**
 * Create empty batch (2019src.txt line 3368)
 */
export function createEmptyBatch(): JBatch {
  return {
    flashloans: [],
    reserveToReserve: [],
    reserveToCollateral: [],
    collateralToReserve: [],
    settlements: [],
    disputeStarts: [],
    counterDisputes: [],
    disputeFinalizations: [], // Match Solidity: FinalDisputeProof[]
    externalTokenToReserve: [],
    reserveToExternalToken: [],
    revealSecrets: [],
    hashLadderRegistrations: [],
  };
}

/**
 * J batches contain only plain objects, arrays, strings, booleans and BigInts.
 * A clone failure is corruption and must stop the frame. A hand-maintained
 * omission would silently skip the next Solidity field and sign different
 * bytes from those submitted on-chain.
 */
export const cloneJBatch = (batch: JBatch): JBatch => structuredClone(batch);

// ABI with C2R shortcut - matches Types.sol Batch struct
// NOTE: Always use this ABI now that contracts have been recompiled with collateralToReserve
const DEPOSITORY_BATCH_ABI =
  'tuple(' +
    'tuple(uint256 tokenId, uint256 amount)[] flashloans,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve,' +
    'tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral,' +
    'tuple(bytes32 counterparty, uint256 tokenId, uint256 amount, uint256 nonce, bytes sig)[] collateralToReserve,' +
    'tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig, uint256 nonce)[] settlements,' +
    'tuple(bytes32 counterentity, uint256 nonce, bool proposerIsLeft, bytes32 proofbodyHash, tuple(bytes32 watchSeed, uint32 leftResponseSeconds, uint32 rightResponseSeconds, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) initialProofbody, bytes32 watchSeed, bytes sig, bytes starterInitialArguments, bytes starterCounterArguments, bytes32 starterCounterProofCommitment)[] disputeStarts,' +
    'tuple(bytes32 counterentity, uint256 initialNonce, bytes32 initialProofbodyHash, uint256 counterNonce, bool proposerIsLeft, tuple(bytes32 watchSeed, uint32 leftResponseSeconds, uint32 rightResponseSeconds, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) counterProofbody, bytes sig)[] counterDisputes,' +
    'tuple(bytes32 counterentity, uint256 initialNonce, uint256 finalNonce, bool proposerIsLeft, bytes32 initialProofbodyHash, tuple(bytes32 watchSeed, uint32 leftResponseSeconds, uint32 rightResponseSeconds, int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes starterArguments, bytes otherArguments, bytes sig, bool startedByLeft, bool cooperative)[] disputeFinalizations,' +
    'tuple(bytes32 entity, address contractAddress, uint256 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken,' +
    'tuple(address transformer, bytes32 secret)[] revealSecrets,' +
    'tuple(bytes32 counterpartyEntity, bool targetRole, bytes32 fullHash, bytes32 partialRoot, tuple(uint16 fillRatio, bytes32 fullSecret, bytes32[4] reveals) witness)[] hashLadderRegistrations' +
  ')';
const DEPOSITORY_BATCH_PARAM = ethers.ParamType.from(DEPOSITORY_BATCH_ABI);

const PROOF_BODY_PARAM = ethers.ParamType.from(PROOF_BODY_ABI);

const encodedHexBytes = (value: string, label: string): number => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`J_DISPUTE_HEX_INVALID:${label}`);
  }
  return (value.length - 2) / 2;
};

export function assertDisputeProofBodyWithinContractLimits(
  proofbody: ProofBodyStruct,
  context: string,
  /** ABI encoding of `proofbody` when the caller already produced it (avoids a second encode). */
  encodedProofBody?: string,
): void {
  if (proofbody.tokenIds.length !== proofbody.offdeltas.length) {
    throw new Error(`J_DISPUTE_PROOFBODY_LENGTH_MISMATCH:${context}`);
  }
  if (proofbody.tokenIds.length > J_BATCH_CONTRACT_LIMITS.maxDisputeProofTokens) {
    throw new Error(`J_DISPUTE_PROOFBODY_TOKEN_LIMIT:${context}:${proofbody.tokenIds.length}`);
  }
  if (proofbody.transformers.length > J_BATCH_CONTRACT_LIMITS.maxDisputeTransformers) {
    throw new Error(`J_DISPUTE_PROOFBODY_TRANSFORMER_LIMIT:${context}:${proofbody.transformers.length}`);
  }
  for (let index = 1; index < proofbody.tokenIds.length; index += 1) {
    if (BigInt(proofbody.tokenIds[index - 1]!) >= BigInt(proofbody.tokenIds[index]!)) {
      throw new Error(`J_DISPUTE_PROOFBODY_TOKEN_ORDER_INVALID:${context}:${index}`);
    }
  }
  const encoded = encodedProofBody ?? ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [proofbody]);
  const size = encodedHexBytes(encoded, `${context}.proofbody`);
  if (size > J_BATCH_CONTRACT_LIMITS.maxDisputeProofBodyBytes) {
    throw new Error(
      `J_DISPUTE_PROOFBODY_BYTES_EXCEEDED:${context}:${size}/${J_BATCH_CONTRACT_LIMITS.maxDisputeProofBodyBytes}`,
    );
  }
}

export function assertDisputeArgumentsWithinContractLimits(
  argumentsHex: readonly string[],
  context: string,
): void {
  const sizes = argumentsHex.map((value, index) => encodedHexBytes(value, `${context}[${index}]`));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes) {
    throw new Error(
      `J_DISPUTE_ARGUMENT_BYTES_EXCEEDED:${context}:${total}/${J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes}`,
    );
  }
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

const estimatedArgumentBytes = (value: unknown): number =>
  typeof value === 'string' && value.startsWith('0x')
    ? Math.max(0, Math.floor((value.length - 2) / 2))
    : 0;

/**
 * DESIGN INVARIANT — dynamic transformer arguments are evidence, never dispute
 * authority. They can change until submission and are deliberately not bound
 * by the owner's Hanko. A malformed/over-budget outer wrapper therefore
 * becomes empty evidence; the signed ProofBody transformer alone decides
 * whether empty evidence is valid. Do not replace this with an outer revert or
 * zero-delta substitution: transformer code/revert/OOG/output remain strict and a
 * failure keeps the dispute active. Regression: dispute-arguments.test.ts.
 */
export function sanitizeOptionalDisputeArgument(
  value: unknown,
  context: string,
): SanitizedOptionalDisputeArgument {
  if (value === '0x') return { value, warnings: [] };
  let size: number;
  try {
    if (typeof value !== 'string') throw new Error('not hex');
    size = encodedHexBytes(value, context);
  } catch {
    return {
      value: '0x',
      warnings: [{
        code: 'DISPUTE_OPTIONAL_ARGUMENT_MALFORMED',
        context,
        originalBytes: estimatedArgumentBytes(value),
        limitBytes: J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
      }],
    };
  }
  if (size > J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes) {
    return {
      value: '0x',
      warnings: [{
        code: 'DISPUTE_OPTIONAL_ARGUMENT_OVERSIZED',
        context,
        originalBytes: size,
        limitBytes: J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
      }],
    };
  }
  try {
    ethers.AbiCoder.defaultAbiCoder().decode(['bytes[]'], value);
  } catch {
    return {
      value: '0x',
      warnings: [{
        code: 'DISPUTE_OPTIONAL_ARGUMENT_MALFORMED',
        context,
        originalBytes: size,
        limitBytes: J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
      }],
    };
  }
  return { value, warnings: [] };
}

export function sanitizeOptionalDisputeStarterArgumentPair(
  initialValue: unknown,
  counterValue: unknown,
  context: string,
): Readonly<{
  initial: string;
  counter: string;
  warnings: readonly OptionalDisputeArgumentWarning[];
}> {
  const initial = sanitizeOptionalDisputeArgument(initialValue, `${context}.initial`);
  const counter = sanitizeOptionalDisputeArgument(counterValue, `${context}.counter`);
  const warnings = [...initial.warnings, ...counter.warnings];
  const total = encodedHexBytes(initial.value, `${context}.initial`) +
    encodedHexBytes(counter.value, `${context}.counter`);
  if (total <= J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes) {
    return { initial: initial.value, counter: counter.value, warnings };
  }
  warnings.push({
    code: 'DISPUTE_OPTIONAL_ARGUMENT_AGGREGATE_OVERSIZED',
    context: `${context}.counter`,
    originalBytes: total,
    limitBytes: J_BATCH_CONTRACT_LIMITS.maxDisputeStarterArgumentsBytes,
  });
  return { initial: initial.value, counter: '0x', warnings };
}

export function encodeJBatch(batch: JBatch): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  // Always encode with full ABI (includes collateralToReserve, even if empty)
  const encoded = abiCoder.encode([DEPOSITORY_BATCH_PARAM], [batch]);
  const size = encodedHexBytes(encoded, 'encodedBatch');
  if (size > J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes) {
    throw new Error(
      `J_BATCH_ENCODED_BYTES_EXCEEDED:${size}/${J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes}`,
    );
  }
  return encoded;
}

/**
 * Decode by the ABI schema instead of Result.toObject().
 *
 * ethers refuses to objectify an unnamed tuple. Solidity permits those tuples
 * inside named structures, so a valid processBatch containing a dispute proof
 * used to fail only after it reached the watcher. The ParamType tree is the
 * authority: every consensus-facing object key comes from the pinned ABI, while
 * positional Result values remain an untrusted transport representation.
 */
const materializeAbiValue = (param: ethers.ParamType, value: unknown, context: string): unknown => {
  if (param.baseType === 'array') {
    const itemParam = param.arrayChildren;
    if (!itemParam || !Array.isArray(value)) {
      throw new Error(`J_BATCH_ABI_ARRAY_INVALID:${context}`);
    }
    return Array.from(value, (item, index) =>
      materializeAbiValue(itemParam, item, `${context}[${index}]`));
  }
  if (param.baseType !== 'tuple') return value;
  if (!param.components || !Array.isArray(value)) {
    throw new Error(`J_BATCH_ABI_TUPLE_INVALID:${context}`);
  }
  return Object.fromEntries(param.components.map((component, index) => {
    if (!component.name) throw new Error(`J_BATCH_ABI_COMPONENT_UNNAMED:${context}[${index}]`);
    return [component.name, materializeAbiValue(component, value[index], `${context}.${component.name}`)];
  }));
};

export function decodeJBatch(encodedBatch: string): JBatch {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const decoded = abiCoder.decode([DEPOSITORY_BATCH_PARAM], encodedBatch);
  const batch = materializeAbiValue(DEPOSITORY_BATCH_PARAM, decoded[0], 'batch');
  validateJBatch(batch, 'J_BATCH_ABI_RESULT');
  return batch;
}

export function summarizeBatch(batch: JBatch): Record<string, unknown> {
  const sample = <T>(arr: T[]) => (arr.length > 0 ? arr[0] : null);
  return {
    flashloans: { count: batch.flashloans.length, sample: sample(batch.flashloans) },
    reserveToReserve: { count: batch.reserveToReserve.length, sample: sample(batch.reserveToReserve) },
    reserveToCollateral: { count: batch.reserveToCollateral.length, sample: sample(batch.reserveToCollateral) },
    settlements: {
      count: batch.settlements.length,
      sample: batch.settlements.length
        ? {
            left: batch.settlements[0]?.leftEntity,
            right: batch.settlements[0]?.rightEntity,
            diffs: batch.settlements[0]?.diffs.length ?? 0,
            forgive: batch.settlements[0]?.forgiveDebtsInTokenIds.length ?? 0,
            sigLen: batch.settlements[0]?.sig?.length ?? 0,
          }
        : null,
    },
    disputeStarts: { count: batch.disputeStarts.length, sample: sample(batch.disputeStarts) },
    counterDisputes: { count: batch.counterDisputes.length, sample: sample(batch.counterDisputes) },
    disputeFinalizations: { count: batch.disputeFinalizations.length, sample: sample(batch.disputeFinalizations) },
    externalTokenToReserve: { count: batch.externalTokenToReserve.length, sample: sample(batch.externalTokenToReserve) },
    reserveToExternalToken: { count: batch.reserveToExternalToken.length, sample: sample(batch.reserveToExternalToken) },
    revealSecrets: { count: batch.revealSecrets.length, sample: sample(batch.revealSecrets) },
    hashLadderRegistrations: { count: batch.hashLadderRegistrations.length, sample: sample(batch.hashLadderRegistrations) },
  };
}

export function preflightBatchForE2(
  entityId: string,
  batch: JBatch,
  _blockTimestampSec?: number
): string[] {
  const issues: string[] = [];
  const normalizedEntityId = normalizeEntityId(entityId);

  const zeroEntity = '0x0000000000000000000000000000000000000000000000000000000000000000';
  for (const op of batch.externalTokenToReserve) {
    const target = op.entity ? normalizeEntityId(op.entity) : zeroEntity;
    if (target !== zeroEntity && target !== normalizedEntityId) {
      issues.push(`externalTokenToReserve entity mismatch: ${target.slice(-4)} != ${normalizedEntityId.slice(-4)}`);
    }
  }

  for (const op of batch.revealSecrets) {
    if (!op.transformer || op.transformer === '0x0000000000000000000000000000000000000000') {
      issues.push(`revealSecrets transformer=0`);
    }
  }

  // NOTE: R2R to self is allowed for minting operations (browservm debugFundReserves)
  // The contract will handle actual validation - no preflight check needed here

  for (const s of batch.settlements) {
    if (compareEntityIds(s.leftEntity, s.rightEntity) >= 0) {
      issues.push(`settlement left>=right: ${s.leftEntity.slice(-4)} >= ${s.rightEntity.slice(-4)}`);
    }
    const hasChanges = s.diffs.length > 0 || s.forgiveDebtsInTokenIds.length > 0;
    if (hasChanges && (!s.sig || s.sig === '0x')) {
      issues.push(`settlement missing sig: ${s.leftEntity.slice(-4)}↔${s.rightEntity.slice(-4)}`);
    }
  }

  for (const f of batch.disputeFinalizations) {
    const finalProofbodyHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [f.finalProofbody]),
    ).toLowerCase();
    const initialProofbodyHash = String(f.initialProofbodyHash || '').toLowerCase();
    if (f.cooperative && (!f.sig || f.sig === '0x')) {
      issues.push(`cooperative dispute finalize missing sig (${f.counterentity.slice(-4)})`);
    }
    if (!f.cooperative && f.sig && f.sig !== '0x') {
      const initialNonce = typeof f.initialNonce === 'bigint' ? f.initialNonce : BigInt(f.initialNonce);
      const finalNonce = typeof f.finalNonce === 'bigint' ? f.finalNonce : BigInt(f.finalNonce);
      if (initialNonce >= finalNonce) {
        issues.push(`dispute finalization nonce order (${f.counterentity.slice(-4)})`);
      }
    }
    if (!f.cooperative && (!f.sig || f.sig === '0x') && finalProofbodyHash !== initialProofbodyHash) {
      issues.push(
        `unilateral dispute finalization proof hash mismatch (${f.counterentity.slice(-4)}): ` +
        `initial=${initialProofbodyHash.slice(0, 10)} final=${finalProofbodyHash.slice(0, 10)}`,
      );
    }
  }

  return issues;
}

/**
 * Compute the net reserve delta already queued in the current draft batch for one entity/token.
 * Earlier incoming ops in the same batch must be spendable by later outgoing ops.
 */
export function getDraftBatchReserveDelta(
  entityId: string,
  batch: JBatch | null | undefined,
  tokenId: number,
): bigint {
  if (!batch) return 0n;

  const normalizedEntityId = normalizeEntityId(entityId);
  let delta = 0n;

  for (const op of batch.externalTokenToReserve) {
    const target = op.entity ? normalizeEntityId(op.entity) : normalizedEntityId;
    if (target === normalizedEntityId && op.internalTokenId === tokenId) {
      delta += op.amount;
    }
  }

  for (const op of batch.collateralToReserve) {
    if (op.tokenId === tokenId) {
      delta += op.amount;
    }
  }

  for (const settlement of batch.settlements) {
    for (const diff of settlement.diffs) {
      if (diff.tokenId !== tokenId) continue;
      if (normalizeEntityId(settlement.leftEntity) === normalizedEntityId) {
        delta += diff.leftDiff;
      } else if (normalizeEntityId(settlement.rightEntity) === normalizedEntityId) {
        delta += diff.rightDiff;
      }
    }
  }

  for (const op of batch.reserveToReserve) {
    if (op.tokenId !== tokenId) continue;
    delta -= op.amount;
    if (normalizeEntityId(op.receivingEntity) === normalizedEntityId) {
      delta += op.amount;
    }
  }

  for (const op of batch.reserveToExternalToken) {
    if (op.tokenId === tokenId) {
      delta -= op.amount;
    }
  }

  for (const op of batch.reserveToCollateral) {
    if (op.tokenId !== tokenId) continue;
    for (const pair of op.pairs) {
      delta -= pair.amount;
    }
  }

  return delta;
}

export {
  getOpenOutgoingDebtTotals,
  simulateDraftBatchReserveAvailability,
} from './reserve-simulation';
export type {
  DraftBatchReserveIssue,
} from './reserve-simulation';

export function computeBatchHankoHash(
  chainId: bigint,
  depositoryAddress: string,
  encodedBatch: string,
  nonce: bigint
): string {
  return hashDepositoryBatchHankoPayload(
    { chainId, depositoryAddress },
    encodedBatch,
    nonce,
  );
}

/**
 * Initialize jBatch state for entity
 */
export function initJBatch(): JBatchState {
  return {
    batch: createEmptyBatch(),
    jurisdiction: null,
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    status: 'empty',
  };
}

/**
 * Check if batch has pending broadcast.
 *
 * Lifecycle model:
 * - `sentBatch` tracks the in-flight on-chain submission.
 * - `batch` remains editable as a draft for next broadcast cycle.
 *
 * We intentionally DO NOT throw when `sentBatch` exists; operators can keep
 * preparing the next batch while waiting for on-chain finalization.
 */
function assertBatchNotPending(jBatchState: JBatchState, operation: string): void {
  if (jBatchState.sentBatch) {
    console.warn(
      `ℹ️ jBatch sentBatch pending (nonce=${jBatchState.sentBatch.entityNonce}) while queueing ${operation} into draft batch`,
    );
  }
}

/**
 * Check whether the batch contains operations.
 */
export function isBatchEmpty(batch: JBatch): boolean {
  return (
    batch.flashloans.length === 0 &&
    batch.reserveToReserve.length === 0 &&
    batch.reserveToCollateral.length === 0 &&
    batch.collateralToReserve.length === 0 &&
    batch.settlements.length === 0 &&
    batch.disputeStarts.length === 0 &&
    batch.counterDisputes.length === 0 &&
    batch.disputeFinalizations.length === 0 &&
    batch.externalTokenToReserve.length === 0 &&
    batch.reserveToExternalToken.length === 0 &&
    batch.revealSecrets.length === 0 &&
    batch.hashLadderRegistrations.length === 0
  );
}

/** Count total operations in a batch */
export function batchOpCount(batch: JBatch): number {
  return (
    batch.flashloans.length +
    batch.reserveToReserve.length +
    batch.reserveToCollateral.length +
    batch.collateralToReserve.length +
    batch.settlements.length +
    batch.disputeStarts.length +
    batch.counterDisputes.length +
    batch.disputeFinalizations.length +
    batch.externalTokenToReserve.length +
    batch.reserveToExternalToken.length +
    batch.revealSecrets.length +
    batch.hashLadderRegistrations.length
  );
}

export function hasJBatchWork(state: JBatchState): boolean {
  return Boolean(state.recoveryBatches?.some(batch => !isBatchEmpty(batch))) || !isBatchEmpty(state.batch);
}

/** Preserve invalidated sent work without ever overflowing the editable draft. */
export function prependRecoveryBatch(state: JBatchState, recovered: JBatch): void {
  if (isBatchEmpty(recovered)) return;
  state.recoveryBatches = [cloneJBatch(recovered), ...(state.recoveryBatches ?? [])];
}

/**
 * Add reserve → collateral operation to batch
 */
export function batchAddReserveToCollateral(
  jBatchState: JBatchState,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  amount: bigint
): void {
  if (amount <= 0n) throw new Error('R2C_AMOUNT_MUST_BE_POSITIVE');
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
    throw new Error('R2C_TOKEN_ID_INVALID');
  }
  if (!entityId || !counterpartyId || entityId === counterpartyId) {
    throw new Error('R2C_ACCOUNT_PARTIES_INVALID');
  }
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'R2C');

  // Check if we already have an R→C entry for this entity+counterparty+token
  // If yes, aggregate amounts
  const existing = jBatchState.batch.reserveToCollateral.find(
    op => op.receivingEntity === entityId && op.tokenId === tokenId
  );

  if (existing) {
    // Find the pair entry
    const pair = existing.pairs.find(p => p.entity === counterpartyId);
    if (pair) {
      pair.amount += amount; // Aggregate
    } else {
      const totalPairs = jBatchState.batch.reserveToCollateral.reduce(
        (count, operation) => count + operation.pairs.length,
        0,
      );
      requireArrayRoom(
        'reserveToCollateral.pairs total',
        totalPairs,
        1,
        J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairsTotal,
      );
      requireArrayRoom(
        'reserveToCollateral.pairs',
        existing.pairs.length,
        1,
        J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairs,
      );
      existing.pairs.push({ entity: counterpartyId, amount });
    }
  } else {
    requireBatchRoom(jBatchState.batch, 'reserveToCollateral');
    const totalPairs = jBatchState.batch.reserveToCollateral.reduce(
      (count, operation) => count + operation.pairs.length,
      0,
    );
    requireArrayRoom(
      'reserveToCollateral.pairs total',
      totalPairs,
      1,
      J_BATCH_CONTRACT_LIMITS.maxReserveToCollateralPairsTotal,
    );
    // Create new entry
    jBatchState.batch.reserveToCollateral.push({
      tokenId,
      receivingEntity: entityId,
      pairs: [{ entity: counterpartyId, amount }],
    });
  }

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('reserve_to_collateral.added', {
    entity: shortId(entityId),
    counterparty: shortId(counterpartyId),
    tokenId,
    amount: amount.toString(),
  });
}



/**
 * Detect if a settlement is a pure C2R (collateral-to-reserve) operation
 * Pure C2R: one side withdraws `amount` from their share of collateral to their reserve
 *
 * Pattern:
 * - Only 1 diff
 * - No forgiveDebtsInTokenIds
 * - One of: leftDiff > 0 XOR rightDiff > 0
 * - collateralDiff = -amount (negative)
 * - ondeltaDiff follows the rule: only left affects ondelta
 *
 * Returns: { isPureC2R: true, withdrawer: 'left'|'right', tokenId, amount } or { isPureC2R: false }
 */
function detectPureC2R(
  diffs: Array<{
    tokenId: number;
    leftDiff: bigint;
    rightDiff: bigint;
    collateralDiff: bigint;
    ondeltaDiff: bigint;
  }>,
  forgiveDebtsInTokenIds: number[]
): { isPureC2R: true; withdrawer: 'left' | 'right'; tokenId: number; amount: bigint } | { isPureC2R: false } {
  // Must have exactly 1 diff
  if (diffs.length !== 1) return { isPureC2R: false };

  // Must have no debt forgiveness
  if (forgiveDebtsInTokenIds.length > 0) return { isPureC2R: false };

  const diff = diffs[0]!; // Safe: we checked length === 1

  // collateralDiff must be negative (withdrawing from collateral)
  if (diff.collateralDiff >= 0n) return { isPureC2R: false };

  const amount = -diff.collateralDiff; // Convert to positive

  // Check LEFT withdraws pattern: leftDiff = +amount, rightDiff = 0, ondeltaDiff = -amount
  if (diff.leftDiff === amount && diff.rightDiff === 0n && diff.ondeltaDiff === -amount) {
    return { isPureC2R: true, withdrawer: 'left', tokenId: diff.tokenId, amount };
  }

  // Check RIGHT withdraws pattern: leftDiff = 0, rightDiff = +amount, ondeltaDiff = 0
  if (diff.leftDiff === 0n && diff.rightDiff === amount && diff.ondeltaDiff === 0n) {
    return { isPureC2R: true, withdrawer: 'right', tokenId: diff.tokenId, amount };
  }

  return { isPureC2R: false };
}

type SettlementBatchOp = JBatch['settlements'][number];

const sameHexBytes = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const sameUnsignedInteger = (left: number | bigint, right: number | bigint): boolean =>
  BigInt(left) === BigInt(right);

/**
 * Signed settlement arrays are hash preimages, so ordering is semantic. An
 * exact transport retry may be ignored, but no field can be merged or replaced
 * after the Hanko has authorized those exact bytes.
 */
const isExactSettlementRetry = (
  existing: SettlementBatchOp,
  candidate: SettlementBatchOp,
): boolean => (
  normalizeEntityId(existing.leftEntity) === normalizeEntityId(candidate.leftEntity)
  && normalizeEntityId(existing.rightEntity) === normalizeEntityId(candidate.rightEntity)
  && existing.diffs.length === candidate.diffs.length
  && existing.diffs.every((diff, index) => {
    const other = candidate.diffs[index];
    return !!other
      && sameUnsignedInteger(diff.tokenId, other.tokenId)
      && diff.leftDiff === other.leftDiff
      && diff.rightDiff === other.rightDiff
      && diff.collateralDiff === other.collateralDiff
      && diff.ondeltaDiff === other.ondeltaDiff;
  })
  && existing.forgiveDebtsInTokenIds.length === candidate.forgiveDebtsInTokenIds.length
  && existing.forgiveDebtsInTokenIds.every((tokenId, index) => {
    const other = candidate.forgiveDebtsInTokenIds[index];
    return other !== undefined && sameUnsignedInteger(tokenId, other);
  })
  && sameHexBytes(existing.sig, candidate.sig)
  && sameUnsignedInteger(existing.nonce, candidate.nonce)
);

/**
 * Add settlement operation to batch
 * Automatically compresses pure C2R settlements into collateralToReserve for calldata savings
 */
export function batchAddSettlement(
  jBatchState: JBatchState,
  leftEntity: string,
  rightEntity: string,
  diffs: Array<{
    tokenId: number;
    leftDiff: bigint;
    rightDiff: bigint;
    collateralDiff: bigint;
    ondeltaDiff: bigint;
  }>,
  forgiveDebtsInTokenIds: number[] = [],
  sig?: string,
  nonce: number = 0,
  initiatorEntity?: string,
  disablePureC2RShortcut: boolean = false,
): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'settlement');
  requireArrayRoom('settlement.diffs', 0, diffs.length, J_BATCH_CONTRACT_LIMITS.maxSettlementDiffs);
  requireArrayRoom(
    'settlement.forgiveDebtsInTokenIds',
    0,
    forgiveDebtsInTokenIds.length,
    J_BATCH_CONTRACT_LIMITS.maxSettlementForgivenessIds,
  );

  // Validate entities are in canonical order
  if (leftEntity >= rightEntity) {
    throw new Error(`Settlement entities must be ordered: ${leftEntity} >= ${rightEntity}`);
  }

  const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0;

  if (hasChanges && (!sig || sig === '0x')) {
    throw new Error(`Settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)} missing hanko signature`);
  }

  const candidate: SettlementBatchOp = {
    leftEntity,
    rightEntity,
    diffs,
    forgiveDebtsInTokenIds,
    sig: sig || '',
    nonce,
  };

  // Check the signed full-settlement lane before any shortcut or mutation.
  const existing = jBatchState.batch.settlements.find(
    settlement => normalizeEntityId(settlement.leftEntity) === normalizeEntityId(leftEntity)
      && normalizeEntityId(settlement.rightEntity) === normalizeEntityId(rightEntity),
  );
  if (existing) {
    if (isExactSettlementRetry(existing, candidate)) return;
    throw new Error(`J_BATCH_SETTLEMENT_CONFLICT:${leftEntity.slice(-4)}:${rightEntity.slice(-4)}`);
  }

  // Compress pure C2R settlements into collateralToReserve (saves calldata)
  const c2rResult = detectPureC2R(diffs, forgiveDebtsInTokenIds);
  const shortcutCounterparty = c2rResult.isPureC2R
    ? (c2rResult.withdrawer === 'left' ? rightEntity : leftEntity)
    : undefined;
  const shortcutWithdrawer = c2rResult.isPureC2R
    ? (c2rResult.withdrawer === 'left' ? leftEntity : rightEntity)
    : undefined;
  const shortcutAllowed = c2rResult.isPureC2R
    && !!sig
    && !disablePureC2RShortcut
    && (!initiatorEntity
      || normalizeEntityId(initiatorEntity) === normalizeEntityId(shortcutWithdrawer!));
  const batchOwner = normalizeEntityId(initiatorEntity ?? leftEntity);
  const pairCounterparty = shortcutAllowed
    ? shortcutCounterparty
    : batchOwner === normalizeEntityId(leftEntity)
      ? rightEntity
      : batchOwner === normalizeEntityId(rightEntity)
        ? leftEntity
        : undefined;
  const existingShortcut = pairCounterparty
    ? jBatchState.batch.collateralToReserve.find(
      operation => normalizeEntityId(operation.counterparty) === normalizeEntityId(pairCounterparty),
    )
    : undefined;
  if (existingShortcut) {
    const exactShortcutRetry = shortcutAllowed
      && sameUnsignedInteger(existingShortcut.tokenId, c2rResult.tokenId)
      && existingShortcut.amount === c2rResult.amount
      && sameUnsignedInteger(existingShortcut.nonce, nonce)
      && sameHexBytes(existingShortcut.sig, sig!);
    if (exactShortcutRetry) return;
    throw new Error(`J_BATCH_SETTLEMENT_CONFLICT:${leftEntity.slice(-4)}:${rightEntity.slice(-4)}`);
  }

  if (c2rResult.isPureC2R && sig && !disablePureC2RShortcut) {
    if (initiatorEntity && normalizeEntityId(initiatorEntity) !== normalizeEntityId(shortcutWithdrawer!)) {
      // Initiator isn't the withdrawer; keep full settlement to avoid C2R signature mismatch.
    } else {
      requireBatchRoom(jBatchState.batch, 'collateralToReserve');
      jBatchState.batch.collateralToReserve.push({
        counterparty: shortcutCounterparty!,
        tokenId: c2rResult.tokenId,
        amount: c2rResult.amount,
        nonce,
        sig,
      });

      if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
      jBatchLog.debug('collateral_to_reserve.shortcut_added', {
        left: shortId(leftEntity),
        right: shortId(rightEntity),
        withdrawer: c2rResult.withdrawer,
        tokenId: c2rResult.tokenId,
        amount: c2rResult.amount.toString(),
      });
      return; // Skip full settlement
    }
  }

  requireArrayRoom(
    'settlements',
    jBatchState.batch.settlements.length,
    1,
    J_BATCH_CONTRACT_LIMITS.maxSettlements,
  );
  requireBatchRoom(jBatchState.batch, 'settlement');
  jBatchState.batch.settlements.push(candidate);

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('settlement.added', {
    left: shortId(leftEntity),
    right: shortId(rightEntity),
    diffs: diffs.length,
  });
}

/**
 * Add reserve → reserve transfer to batch
 */
export function batchAddReserveToReserve(
  jBatchState: JBatchState,
  receivingEntity: string,
  tokenId: number,
  amount: bigint
): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'R2R');
  requireBatchRoom(jBatchState.batch, 'reserveToReserve');

  jBatchState.batch.reserveToReserve.push({
    receivingEntity,
    tokenId,
    amount,
  });

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('reserve_to_reserve.added', {
    receivingEntity: shortId(receivingEntity),
    tokenId,
    amount: amount.toString(),
  });
}

/**
 * Add external token → reserve deposit to batch.
 * Execution still happens on Depository.processBatch, but submission must come from the external EOA.
 */
export function batchAddExternalTokenToReserve(
  jBatchState: JBatchState,
  entityId: string,
  contractAddress: string,
  amount: bigint,
  tokenType: number = 0,
  externalTokenId: bigint = 0n,
  internalTokenId: number = 0,
): void {
  assertBatchNotPending(jBatchState, 'E2R');
  requireBatchRoom(jBatchState.batch, 'externalTokenToReserve');

  jBatchState.batch.externalTokenToReserve.push({
    entity: entityId,
    contractAddress,
    externalTokenId,
    tokenType,
    internalTokenId,
    amount,
  });

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('external_to_reserve.added', {
    entity: shortId(entityId),
    contract: shortHash(contractAddress),
    amount: amount.toString(),
    internalTokenId,
  });
}

/**
 * Add reserve → external withdrawal to batch.
 * receivingEntity must already be the bytes32-encoded destination address.
 */
export function batchAddReserveToExternal(
  jBatchState: JBatchState,
  receivingEntity: string,
  tokenId: number,
  amount: bigint
): void {
  assertBatchNotPending(jBatchState, 'R2E');
  requireBatchRoom(jBatchState.batch, 'reserveToExternalToken');

  jBatchState.batch.reserveToExternalToken.push({
    receivingEntity,
    tokenId,
    amount,
  });

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('reserve_to_external.added', {
    receivingEntity: shortId(receivingEntity),
    tokenId,
    amount: amount.toString(),
  });
}

/**
 * Add HTLC secret reveal to batch (idempotent per transformer+secret)
 */
export function batchAddRevealSecret(
  jBatchState: JBatchState,
  transformer: string,
  secret: string
): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'secret reveal');

  const exists = jBatchState.batch.revealSecrets.find(
    r => r.transformer === transformer && r.secret === secret
  );
  if (exists) {
    return;
  }
  requireBatchRoom(jBatchState.batch, 'revealSecret');
  requireArrayRoom(
    'revealSecrets',
    jBatchState.batch.revealSecrets.length,
    1,
    J_BATCH_CONTRACT_LIMITS.maxSecretReveals,
  );
  jBatchState.batch.revealSecrets.push({ transformer, secret });
  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('secret_reveal.added', {
    secret: shortHash(secret),
    transformer: shortHash(transformer),
  });
}

/**
 * Queue a cross-j hash-ladder reveal registration (idempotent per ladder+ratio).
 *
 * The contract verifies the material against the ladder commitment and records
 * the ratio under the signing entity's key. Registration is the ONLY on-chain
 * settlement evidence a pull ever reads; dispute calldata carries no pull
 * binaries anymore.
 */
export function batchAddHashLadderRegistration(
  jBatchState: JBatchState,
  registration: {
    counterpartyEntity: string;
    targetRole: boolean;
    fullHash: string;
    partialRoot: string;
    witness: {
      fillRatio: number;
      fullSecret: string;
      reveals: [string, string, string, string];
    };
  },
): void {
  assertBatchNotPending(jBatchState, 'hash-ladder reveal');
  const ladderHash = hashLadderRegistrationKey(registration);
  const changed = upsertHashLadderRegistration(
    jBatchState.batch.hashLadderRegistrations,
    registration,
    () => {
      requireBatchRoom(jBatchState.batch, 'hashLadderRegistration');
      requireArrayRoom(
        'hashLadderRegistrations', jBatchState.batch.hashLadderRegistrations.length, 1,
        J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations,
      );
    },
  );
  if (!changed) return;
  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('hash_ladder_reveal.added', {
    counterpartyEntity: shortHash(registration.counterpartyEntity),
    ladderHash: shortHash(ladderHash),
    fillRatio: registration.witness.fillRatio,
    targetRole: registration.targetRole,
  });
}

type HashLadderRegistration = JBatch['hashLadderRegistrations'][number];

const hashLadderRegistrationKey = (
  registration: Pick<HashLadderRegistration, 'counterpartyEntity' | 'fullHash' | 'partialRoot'>,
): string => ethers.keccak256(
  ethers.solidityPacked(
    ['bytes32', 'bytes32', 'bytes32'],
    [registration.counterpartyEntity, registration.fullHash, registration.partialRoot],
  ),
).toLowerCase();

/**
 * Whether one Account-scoped registration can enter this mutable draft.
 * Replacing an existing Target slot consumes no new contract array/total-op
 * capacity; every new slot must satisfy both independent limits.
 */
export const hasHashLadderRegistrationRoom = (
  batch: JBatch,
  registration: HashLadderRegistration,
): boolean => {
  const slotExists = batch.hashLadderRegistrations.some(existing =>
    existing.targetRole === registration.targetRole
    && hashLadderRegistrationKey(existing) === hashLadderRegistrationKey(registration)
  );
  if (slotExists) return true;
  return (
    batch.hashLadderRegistrations.length < J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations
    && batchOpCount(batch) < J_BATCH_CONTRACT_LIMITS.maxTotalOps
  );
};

/** One canonical dedupe/replacement policy for normal queueing and recovery merges. */
function upsertHashLadderRegistration(
  registrations: HashLadderRegistration[],
  registration: HashLadderRegistration,
  beforeAppend: () => void = () => undefined,
): boolean {
  const ladderHash = hashLadderRegistrationKey(registration);
  const normalized = {
    counterpartyEntity: registration.counterpartyEntity.toLowerCase(),
    targetRole: registration.targetRole,
    fullHash: registration.fullHash,
    partialRoot: registration.partialRoot,
    witness: {
      fillRatio: registration.witness.fillRatio,
      fullSecret: registration.witness.fullSecret,
      reveals: [...registration.witness.reveals] as [string, string, string, string],
    },
  };
  const existingIndex = registrations.findIndex(existing =>
    existing.targetRole === registration.targetRole
    && existing.counterpartyEntity.toLowerCase() === registration.counterpartyEntity.toLowerCase()
    && hashLadderRegistrationKey(existing) === ladderHash
  );
  if (existingIndex >= 0) {
    const existing = registrations[existingIndex]!;
    const existingRatio = existing.witness.fillRatio;
    if (existingRatio === registration.witness.fillRatio) return false;
    if (!registration.targetRole || registration.witness.fillRatio < existingRatio) {
      throw new Error(
        `J_HASH_LADDER_REGISTRATION_CONFLICT:${ladderHash}:` +
        `${registration.targetRole ? 'target' : 'source'}:` +
        `${existingRatio}:${registration.witness.fillRatio}`,
      );
    }
    registrations[existingIndex] = normalized;
  } else {
    beforeAppend();
    registrations.push(normalized);
  }
  return true;
}

/** Lock the highest mutually signed counter-proof before the Account deadline. */
export function batchAddCounterDispute(
  jBatchState: JBatchState,
  counterProof: JBatch['counterDisputes'][number],
): void {
  assertBatchNotPending(jBatchState, 'counter-dispute');
  const counterparty = counterProof.counterentity.toLowerCase();
  const initialHash = counterProof.initialProofbodyHash.toLowerCase();
  const bodyHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [counterProof.counterProofbody]),
  ).toLowerCase();
  const existingIndex = jBatchState.batch.counterDisputes.findIndex(
    item => item.counterentity.toLowerCase() === counterparty,
  );
  if (existingIndex >= 0) {
    const existing = jBatchState.batch.counterDisputes[existingIndex]!;
    const existingBodyHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [existing.counterProofbody]),
    ).toLowerCase();
    if (
      existing.initialNonce !== counterProof.initialNonce
      || existing.initialProofbodyHash.toLowerCase() !== initialHash
    ) {
      throw new Error(`J_COUNTER_DISPUTE_INITIAL_BINDING_CONFLICT:${counterparty}`);
    }
    if (counterProof.counterNonce < existing.counterNonce) {
      throw new Error(`J_COUNTER_DISPUTE_NONCE_REGRESSION:${counterparty}`);
    }
    if (counterProof.counterNonce === existing.counterNonce) {
      if (counterProof.proposerIsLeft !== existing.proposerIsLeft) {
        if (!counterProof.proposerIsLeft) {
          throw new Error(`J_COUNTER_DISPUTE_ROLE_REGRESSION:${counterparty}`);
        }
      } else if (bodyHash !== existingBodyHash) {
        throw new Error(`J_COUNTER_DISPUTE_HASH_CONFLICT:${counterparty}:${counterProof.counterNonce}`);
      } else {
        return;
      }
    }
    jBatchState.batch.counterDisputes[existingIndex] = structuredClone(counterProof);
  } else {
    requireBatchRoom(jBatchState.batch, 'counterDispute');
    requireArrayRoom(
      'counterDisputes',
      jBatchState.batch.counterDisputes.length,
      1,
      J_BATCH_CONTRACT_LIMITS.maxCounterDisputes,
    );
    jBatchState.batch.counterDisputes.push(structuredClone(counterProof));
  }
  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('counter_dispute.added', {
    counterparty: shortHash(counterparty),
    counterNonce: counterProof.counterNonce,
    bodyHash: shortHash(bodyHash),
  });
}
