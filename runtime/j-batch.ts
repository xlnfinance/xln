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
import type { ProofBodyStruct } from './typechain/Depository.js';
import { isLeftEntity, normalizeEntityId, compareEntityIds } from './entity-id-utils';

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
    entityProvider: string; // EntityProvider address
    hankoData: string; // Hanko signature data
    nonce: number; // Settlement nonce
  }>;

  // Dispute proofs (active in Depository.sol) - unified nonce model
  disputeStarts: Array<{
    counterentity: string;
    nonce: number; // unified nonce (must be > stored account nonce)
    proofbodyHash: string;
    sig: string;
    initialArguments: string;
  }>;
  disputeFinalizations: Array<{
    counterentity: string;
    initialNonce: number; // nonce when dispute was started
    finalNonce: number; // signed finalize nonce; unilateral timeout path may keep equal to initialNonce
    initialProofbodyHash: string;
    finalProofbody: ProofBodyStruct;
    finalArguments: string;
    initialArguments: string;
    sig: string;
    startedByLeft: boolean;
    disputeUntilBlock: number;
    cooperative: boolean;
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

  // Hub ID (for gas tracking)
  hub_id: number;
}

/** Batch lifecycle: current accumulates, sentBatch tracks one in-flight submission */
export type JBatchStatus = 'empty' | 'accumulating' | 'sent' | 'failed';

/** In-flight batch snapshot (authoritative until HankoBatchProcessed arrives). */
export interface SentJBatch {
  batch: JBatch;
  batchHash: string;
  encodedBatch: string;
  entityNonce: number;
  firstSubmittedAt: number;
  lastSubmittedAt: number;
  submitAttempts: number;
  txHash?: string;
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
  entityNonce?: number; // Entity nonce used for this batch (for replay prevention)
}

export interface BatchOpBreakdown {
  flashloans: number;
  reserveToReserve: number;
  reserveToCollateral: number;
  collateralToReserve: number;
  settlements: number;
  disputeStarts: number;
  disputeFinalizations: number;
  externalTokenToReserve: number;
  reserveToExternalToken: number;
  revealSecrets: number;
}

/** Completed batch record (stored in entity state history) */
export interface CompletedBatch {
  batchHash: string;
  txHash: string;
  status: 'confirmed' | 'failed';
  broadcastedAt: number;
  confirmedAt: number;
  opCount: number; // Total operations in batch
  entityNonce: number;
  jBlockNumber?: number; // Finalized J-block that emitted HankoBatchProcessed
  batch?: JBatch; // Optional full batch snapshot for rich UI history
  operations?: BatchOpBreakdown; // Optional per-op breakdown for UI history
  source?: 'self-batch' | 'counterparty-event';
  eventType?: 'DisputeStarted' | 'DisputeFinalized';
  note?: string;
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
    disputeFinalizations: [], // Match Solidity: FinalDisputeProof[]
    externalTokenToReserve: [],
    reserveToExternalToken: [],
    revealSecrets: [],
    hub_id: 0,
  };
}

const cloneProofbody = (proofbody: ProofBodyStruct): ProofBodyStruct => {
  try {
    return structuredClone(proofbody);
  } catch {
    return {
      offdeltas: [...proofbody.offdeltas],
      tokenIds: [...proofbody.tokenIds],
      transformers: proofbody.transformers.map((transformer) => ({
        transformerAddress: transformer.transformerAddress,
        encodedBatch: transformer.encodedBatch,
        allowances: transformer.allowances.map((allowance) => ({
          deltaIndex: allowance.deltaIndex,
          rightAllowance: allowance.rightAllowance,
          leftAllowance: allowance.leftAllowance,
        })),
      })),
    };
  }
};

export function cloneJBatch(batch: JBatch): JBatch {
  try {
    return structuredClone(batch);
  } catch {
    return {
      flashloans: batch.flashloans.map(op => ({ ...op })),
      reserveToReserve: batch.reserveToReserve.map(op => ({ ...op })),
      reserveToCollateral: batch.reserveToCollateral.map(op => ({
        tokenId: op.tokenId,
        receivingEntity: op.receivingEntity,
        pairs: op.pairs.map(pair => ({ ...pair })),
      })),
      collateralToReserve: batch.collateralToReserve.map(op => ({ ...op })),
      settlements: batch.settlements.map(settlement => ({
        ...settlement,
        diffs: settlement.diffs.map(diff => ({ ...diff })),
        forgiveDebtsInTokenIds: [...settlement.forgiveDebtsInTokenIds],
      })),
      disputeStarts: batch.disputeStarts.map(op => ({ ...op })),
      disputeFinalizations: batch.disputeFinalizations.map(op => ({
        ...op,
        finalProofbody: cloneProofbody(op.finalProofbody),
      })),
      externalTokenToReserve: batch.externalTokenToReserve.map(op => ({ ...op })),
      reserveToExternalToken: batch.reserveToExternalToken.map(op => ({ ...op })),
      revealSecrets: batch.revealSecrets.map(op => ({ ...op })),
      hub_id: batch.hub_id,
    };
  }
}

// ABI with C2R shortcut - matches Types.sol Batch struct
// NOTE: Always use this ABI now that contracts have been recompiled with collateralToReserve
const DEPOSITORY_BATCH_ABI =
  'tuple(' +
    'tuple(uint256 tokenId, uint256 amount)[] flashloans,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToReserve,' +
    'tuple(uint256 tokenId, bytes32 receivingEntity, tuple(bytes32 entity, uint256 amount)[] pairs)[] reserveToCollateral,' +
    'tuple(bytes32 counterparty, uint256 tokenId, uint256 amount, uint256 nonce, bytes sig)[] collateralToReserve,' +
    'tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, bytes sig, address entityProvider, bytes hankoData, uint256 nonce)[] settlements,' +
    'tuple(bytes32 counterentity, uint256 nonce, bytes32 proofbodyHash, bytes sig, bytes initialArguments)[] disputeStarts,' +
    'tuple(bytes32 counterentity, uint256 initialNonce, uint256 finalNonce, bytes32 initialProofbodyHash, tuple(int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes finalArguments, bytes initialArguments, bytes sig, bool startedByLeft, uint256 disputeUntilBlock, bool cooperative)[] disputeFinalizations,' +
    'tuple(bytes32 entity, address contractAddress, uint96 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken,' +
    'tuple(address transformer, bytes32 secret)[] revealSecrets,' +
    'uint256 hub_id' +
  ')';
const DEPOSITORY_BATCH_PARAM = ethers.ParamType.from(DEPOSITORY_BATCH_ABI);

const BATCH_DOMAIN_SEPARATOR = ethers.keccak256(ethers.toUtf8Bytes('XLN_DEPOSITORY_HANKO_V1'));

export function encodeJBatch(batch: JBatch): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  // Always encode with full ABI (includes collateralToReserve, even if empty)
  return abiCoder.encode([DEPOSITORY_BATCH_PARAM], [batch]);
}

export function decodeJBatch(encodedBatch: string): JBatch {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const decoded = abiCoder.decode([DEPOSITORY_BATCH_PARAM], encodedBatch);
  return decoded[0] as unknown as JBatch;
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
    disputeFinalizations: { count: batch.disputeFinalizations.length, sample: sample(batch.disputeFinalizations) },
    externalTokenToReserve: { count: batch.externalTokenToReserve.length, sample: sample(batch.externalTokenToReserve) },
    reserveToExternalToken: { count: batch.reserveToExternalToken.length, sample: sample(batch.reserveToExternalToken) },
    revealSecrets: { count: batch.revealSecrets.length, sample: sample(batch.revealSecrets) },
    hub_id: batch.hub_id,
  };
}

export function preflightBatchForE2(
  entityId: string,
  batch: JBatch,
  blockTimestampSec?: number
): string[] {
  const issues: string[] = [];
  const normalizedEntityId = normalizeEntityId(entityId);
  const nowSec = blockTimestampSec ?? 0;

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

export function getEffectiveDraftReserveBalance(
  entityId: string,
  currentReserve: bigint,
  batch: JBatch | null | undefined,
  tokenId: number,
): bigint {
  return currentReserve + getDraftBatchReserveDelta(entityId, batch, tokenId);
}

export interface DraftBatchReserveIssue {
  tokenId: number;
  opType: 'reserveToReserve' | 'reserveToCollateral' | 'reserveToExternalToken';
  opIndex: number;
  requiredAmount: bigint;
  availableAfterDebt: bigint;
  debtClaimPaid: bigint;
  remainingDebtAfterSweep: bigint;
}

export interface DraftBatchReserveSimulation {
  issues: DraftBatchReserveIssue[];
  reservesByToken: Map<number, bigint>;
  outgoingDebtByToken: Map<number, bigint>;
}

function readBigIntMapAmount(source: Map<number, bigint> | null | undefined, tokenId: number): bigint {
  if (!source) return 0n;
  return source.get(tokenId) ?? 0n;
}

function writeBigIntMapAmount(target: Map<number, bigint>, tokenId: number, amount: bigint): void {
  if (amount === 0n) {
    target.delete(tokenId);
    return;
  }
  target.set(tokenId, amount);
}

function sweepOutgoingDebtOnce(
  reservesByToken: Map<number, bigint>,
  outgoingDebtByToken: Map<number, bigint>,
  tokenId: number,
): { availableAfterDebt: bigint; debtClaimPaid: bigint; remainingDebtAfterSweep: bigint } {
  const reserve = readBigIntMapAmount(reservesByToken, tokenId);
  const outgoingDebt = readBigIntMapAmount(outgoingDebtByToken, tokenId);
  if (reserve <= 0n || outgoingDebt <= 0n) {
    return {
      availableAfterDebt: reserve,
      debtClaimPaid: 0n,
      remainingDebtAfterSweep: outgoingDebt,
    };
  }

  const debtClaimPaid = reserve < outgoingDebt ? reserve : outgoingDebt;
  const availableAfterDebt = reserve - debtClaimPaid;
  const remainingDebtAfterSweep = outgoingDebt - debtClaimPaid;
  writeBigIntMapAmount(reservesByToken, tokenId, availableAfterDebt);
  writeBigIntMapAmount(outgoingDebtByToken, tokenId, remainingDebtAfterSweep);
  return { availableAfterDebt, debtClaimPaid, remainingDebtAfterSweep };
}

export function simulateDraftBatchReserveAvailability(
  entityId: string,
  currentReserves: Map<number, bigint> | null | undefined,
  batch: JBatch | null | undefined,
  outgoingDebtByTokenInput: Map<number, bigint> | null | undefined,
): DraftBatchReserveSimulation {
  const reservesByToken = new Map<number, bigint>(currentReserves ? Array.from(currentReserves.entries()) : []);
  const outgoingDebtByToken = new Map<number, bigint>(outgoingDebtByTokenInput ? Array.from(outgoingDebtByTokenInput.entries()) : []);
  const issues: DraftBatchReserveIssue[] = [];
  if (!batch) return { issues, reservesByToken, outgoingDebtByToken };

  const normalizedEntityId = normalizeEntityId(entityId);

  const addReserve = (tokenId: number, amount: bigint): void => {
    writeBigIntMapAmount(reservesByToken, tokenId, readBigIntMapAmount(reservesByToken, tokenId) + amount);
  };

  const spendReserve = (
    tokenId: number,
    amount: bigint,
    opType: DraftBatchReserveIssue['opType'],
    opIndex: number,
  ): boolean => {
    const swept = sweepOutgoingDebtOnce(reservesByToken, outgoingDebtByToken, tokenId);
    if (swept.availableAfterDebt < amount) {
      issues.push({
        tokenId,
        opType,
        opIndex,
        requiredAmount: amount,
        availableAfterDebt: swept.availableAfterDebt,
        debtClaimPaid: swept.debtClaimPaid,
        remainingDebtAfterSweep: swept.remainingDebtAfterSweep,
      });
      return false;
    }
    writeBigIntMapAmount(reservesByToken, tokenId, swept.availableAfterDebt - amount);
    return true;
  };

  for (const op of batch.flashloans) {
    addReserve(op.tokenId, op.amount);
  }

  for (const op of batch.externalTokenToReserve) {
    const target = op.entity ? normalizeEntityId(op.entity) : normalizedEntityId;
    if (target === normalizedEntityId) addReserve(op.internalTokenId, op.amount);
  }

  for (const [index, op] of batch.reserveToReserve.entries()) {
    if (!spendReserve(op.tokenId, op.amount, 'reserveToReserve', index)) {
      return { issues, reservesByToken, outgoingDebtByToken };
    }
    if (normalizeEntityId(op.receivingEntity) === normalizedEntityId) {
      addReserve(op.tokenId, op.amount);
    }
  }

  for (const op of batch.collateralToReserve) {
    addReserve(op.tokenId, op.amount);
  }

  for (const settlement of batch.settlements) {
    for (const diff of settlement.diffs) {
      if (normalizeEntityId(settlement.leftEntity) === normalizedEntityId) {
        addReserve(diff.tokenId, diff.leftDiff);
      } else if (normalizeEntityId(settlement.rightEntity) === normalizedEntityId) {
        addReserve(diff.tokenId, diff.rightDiff);
      }
    }
  }

  for (const [index, op] of batch.reserveToCollateral.entries()) {
    const totalAmount = op.pairs.reduce((sum, pair) => sum + pair.amount, 0n);
    if (!spendReserve(op.tokenId, totalAmount, 'reserveToCollateral', index)) {
      return { issues, reservesByToken, outgoingDebtByToken };
    }
  }

  for (const [index, op] of batch.reserveToExternalToken.entries()) {
    if (!spendReserve(op.tokenId, op.amount, 'reserveToExternalToken', index)) {
      return { issues, reservesByToken, outgoingDebtByToken };
    }
  }

  return { issues, reservesByToken, outgoingDebtByToken };
}

export function computeBatchHankoHash(
  chainId: bigint,
  depositoryAddress: string,
  encodedBatch: string,
  nonce: bigint
): string {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes32', 'uint256', 'address', 'bytes', 'uint256'],
    [BATCH_DOMAIN_SEPARATOR, chainId, depositoryAddress, encodedBatch, nonce]
  ));
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
export function assertBatchNotPending(jBatchState: JBatchState, operation: string): void {
  if (jBatchState.sentBatch) {
    console.warn(
      `ℹ️ jBatch sentBatch pending (nonce=${jBatchState.sentBatch.entityNonce}) while queueing ${operation} into draft batch`,
    );
  }
}

/**
 * Check if batch has any operations
 */
export function isBatchEmpty(batch: JBatch): boolean {
  return (
    batch.flashloans.length === 0 &&
    batch.reserveToReserve.length === 0 &&
    batch.reserveToCollateral.length === 0 &&
    batch.collateralToReserve.length === 0 &&
    batch.settlements.length === 0 &&
    batch.disputeStarts.length === 0 &&
    batch.disputeFinalizations.length === 0 &&
    batch.externalTokenToReserve.length === 0 &&
    batch.reserveToExternalToken.length === 0 &&
    batch.revealSecrets.length === 0
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
    batch.disputeFinalizations.length +
    batch.externalTokenToReserve.length +
    batch.reserveToExternalToken.length +
    batch.revealSecrets.length
  );
}

/** Per-operation counters for history/debug UI. */
export function batchOpBreakdown(batch: JBatch): BatchOpBreakdown {
  return {
    flashloans: batch.flashloans.length,
    reserveToReserve: batch.reserveToReserve.length,
    reserveToCollateral: batch.reserveToCollateral.length,
    collateralToReserve: batch.collateralToReserve.length,
    settlements: batch.settlements.length,
    disputeStarts: batch.disputeStarts.length,
    disputeFinalizations: batch.disputeFinalizations.length,
    externalTokenToReserve: batch.externalTokenToReserve.length,
    reserveToExternalToken: batch.reserveToExternalToken.length,
    revealSecrets: batch.revealSecrets.length,
  };
}

/**
 * Merge all operations from source batch into target batch (append semantics).
 * Used by failure/abort recovery flows when moving sentBatch ops back to current.
 */
export function mergeBatchOps(target: JBatch, source: JBatch): void {
  target.flashloans.push(...source.flashloans);
  target.reserveToReserve.push(...source.reserveToReserve);
  target.reserveToCollateral.push(...source.reserveToCollateral);
  target.collateralToReserve.push(...source.collateralToReserve);
  target.settlements.push(...source.settlements);
  target.disputeStarts.push(...source.disputeStarts);
  target.disputeFinalizations.push(...source.disputeFinalizations);
  target.externalTokenToReserve.push(...source.externalTokenToReserve);
  target.reserveToExternalToken.push(...source.reserveToExternalToken);
  target.revealSecrets.push(...source.revealSecrets);
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
      existing.pairs.push({ entity: counterpartyId, amount });
    }
  } else {
    // Create new entry
    jBatchState.batch.reserveToCollateral.push({
      tokenId,
      receivingEntity: entityId,
      pairs: [{ entity: counterpartyId, amount }],
    });
  }

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  console.log(`📦 jBatch: Added R→C ${amount} token ${tokenId} for ${entityId.slice(-4)}→${counterpartyId.slice(-4)}`);
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
export function detectPureC2R(
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
  entityProvider: string = '0x0000000000000000000000000000000000000000',
  hankoData: string = '0x',
  nonce: number = 0,
  initiatorEntity?: string,
  disablePureC2RShortcut: boolean = false,
): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'settlement');

  // Validate entities are in canonical order
  if (leftEntity >= rightEntity) {
    throw new Error(`Settlement entities must be ordered: ${leftEntity} >= ${rightEntity}`);
  }

  const hasChanges = diffs.length > 0 || forgiveDebtsInTokenIds.length > 0;

  if (hasChanges && (!sig || sig === '0x')) {
    throw new Error(`Settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)} missing hanko signature`);
  }

  // Compress pure C2R settlements into collateralToReserve (saves calldata)
  const c2rResult = detectPureC2R(diffs, forgiveDebtsInTokenIds);
  if (c2rResult.isPureC2R && sig && !disablePureC2RShortcut) {
    // Determine counterparty based on who is withdrawing
    const counterparty = c2rResult.withdrawer === 'left' ? rightEntity : leftEntity;
    const withdrawerEntity = c2rResult.withdrawer === 'left' ? leftEntity : rightEntity;
    if (initiatorEntity && normalizeEntityId(initiatorEntity) !== normalizeEntityId(withdrawerEntity)) {
      // Initiator isn't the withdrawer; keep full settlement to avoid C2R signature mismatch.
    } else {
      jBatchState.batch.collateralToReserve.push({
        counterparty,
        tokenId: c2rResult.tokenId,
        amount: c2rResult.amount,
        nonce,
        sig,
      });

      if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
      console.log(`📦 jBatch: Added C2R shortcut ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)}, ${c2rResult.withdrawer} withdraws ${c2rResult.amount} token ${c2rResult.tokenId}`);
      return; // Skip full settlement
    }
  }

  // Check if we already have a settlement for this pair
  const existing = jBatchState.batch.settlements.find(
    s => s.leftEntity === leftEntity && s.rightEntity === rightEntity
  );

  if (existing) {
    if (existing.diffs.length > 0 && hasChanges) {
      throw new Error(`Settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)} already queued - refuse to merge diffs without a fresh signature`);
    }
    // Aggregate diffs by token
    for (const newDiff of diffs) {
      const existingDiff = existing.diffs.find(d => d.tokenId === newDiff.tokenId);
      if (existingDiff) {
        existingDiff.leftDiff += newDiff.leftDiff;
        existingDiff.rightDiff += newDiff.rightDiff;
        existingDiff.collateralDiff += newDiff.collateralDiff;
        existingDiff.ondeltaDiff += newDiff.ondeltaDiff;
      } else {
        existing.diffs.push(newDiff);
      }
    }
    // Append debt forgiveness (dedup)
    for (const tokenId of forgiveDebtsInTokenIds) {
      if (!existing.forgiveDebtsInTokenIds.includes(tokenId)) {
        existing.forgiveDebtsInTokenIds.push(tokenId);
      }
    }
    if (hasChanges) {
      existing.sig = sig || existing.sig;
      existing.entityProvider = entityProvider;
      existing.hankoData = hankoData;
      existing.nonce = nonce;
    }
  } else {
    jBatchState.batch.settlements.push({
      leftEntity,
      rightEntity,
      diffs,
      forgiveDebtsInTokenIds,
      sig: sig || '',
      entityProvider,
      hankoData,
      nonce,
    });
  }

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  console.log(`📦 jBatch: Added settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)}, ${diffs.length} tokens`);
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

  jBatchState.batch.reserveToReserve.push({
    receivingEntity,
    tokenId,
    amount,
  });

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  console.log(`📦 jBatch: Added R→R ${amount} token ${tokenId} to ${receivingEntity.slice(-4)}`);
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

  jBatchState.batch.externalTokenToReserve.push({
    entity: entityId,
    contractAddress,
    externalTokenId,
    tokenType,
    internalTokenId,
    amount,
  });

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  console.log(`📦 jBatch: Added E→R ${amount} via ${contractAddress.slice(0, 10)}... for ${entityId.slice(-4)}`);
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

  jBatchState.batch.reserveToExternalToken.push({
    receivingEntity,
    tokenId,
    amount,
  });

  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  console.log(`📦 jBatch: Added R→E ${amount} token ${tokenId} to ${receivingEntity.slice(-4)}`);
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
  jBatchState.batch.revealSecrets.push({ transformer, secret });
  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  console.log(`📦 jBatch: Added secret reveal ${secret.slice(0, 10)}... via ${transformer.slice(0, 10)}...`);
}

/**
 * Get batch size (total operations)
 */
export function getBatchSize(batch: JBatch): number {
  return (
    batch.flashloans.length +
    batch.reserveToReserve.length +
    batch.reserveToCollateral.length +
    batch.collateralToReserve.length +
    batch.settlements.length +
    batch.disputeStarts.length +
    batch.disputeFinalizations.length +
    batch.externalTokenToReserve.length +
    batch.reserveToExternalToken.length +
    batch.revealSecrets.length
  );
}

/**
 * Check if batch should be broadcast
 * Triggers: batch full, timeout, or manual flush
 */
export function shouldBroadcastBatch(
  jBatchState: JBatchState,
  currentTimestamp: number
): boolean {
  if (jBatchState.sentBatch) {
    return false;
  }

  if (isBatchEmpty(jBatchState.batch)) {
    return false;
  }

  const batchSize = getBatchSize(jBatchState.batch);
  const MAX_BATCH_SIZE = 50; // Max operations per batch
  const BATCH_TIMEOUT_MS = 5000; // Broadcast every 5s even if not full

  // Trigger 1: Batch is full
  if (batchSize >= MAX_BATCH_SIZE) {
    console.log(`📦 jBatch: Full (${batchSize}/${MAX_BATCH_SIZE}) - triggering broadcast`);
    return true;
  }

  // Trigger 2: Timeout since last broadcast
  const timeSinceLastBroadcast = currentTimestamp - jBatchState.lastBroadcast;
  if (timeSinceLastBroadcast >= BATCH_TIMEOUT_MS) {
    console.log(`📦 jBatch: Timeout (${timeSinceLastBroadcast}ms) - triggering broadcast`);
    return true;
  }

  return false;
}
