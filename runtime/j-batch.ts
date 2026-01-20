/**
 * J-Batch Aggregator System
 *
 * Accumulates entity operations into batches for atomic on-chain submission.
 * Pattern from 2019src.txt lines 3309-3399 (sharedState.batch + broadcastBatch)
 *
 * Design:
 * - Each entity accumulates operations in their jBatch
 * - Server periodically broadcasts batches (every 5s or when full)
 * - Batch is cleared after successful submission
 * - Failed batches are retried (with exponential backoff)
 */

import { ethers } from 'ethers';
import { isLeftEntity, normalizeEntityId, compareEntityIds } from './entity-id-utils';
import type { JurisdictionConfig } from './types';
import { safeStringify } from './serialization-utils';

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
    packedToken: string;
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
    insuranceRegs: Array<{
      insured: string;
      insurer: string;
      tokenId: number;
      limit: bigint;
      expiresAt: bigint;
    }>;
    sig: string; // Hanko signature (required when there are changes)
    entityProvider: string; // EntityProvider address
    hankoData: string; // Hanko signature data
    nonce: number; // Settlement nonce
  }>;

  // Dispute proofs (active in Depository.sol)
  cooperativeUpdate: never[];  // Legacy - not used
  cooperativeDisputeProof: never[];  // Legacy - not used
  disputeStarts: Array<{
    counterentity: string;
    cooperativeNonce: number;
    disputeNonce: number;
    proofbodyHash: string;
    sig: string;
    initialArguments: string;
  }>;
  disputeFinalizations: Array<{
    counterentity: string;
    initialCooperativeNonce: number;
    finalCooperativeNonce: number;
    initialDisputeNonce: number;
    finalDisputeNonce: number;
    initialProofbodyHash: string;
    finalProofbody: any;  // ProofBody struct
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

/**
 * JBatch state for an entity
 */
export interface JBatchState {
  batch: JBatch;
  jurisdiction: JurisdictionConfig | null; // Cached jurisdiction for this entity
  lastBroadcast: number; // Timestamp of last broadcast
  broadcastCount: number; // Total broadcasts
  failedAttempts: number; // Failed broadcast attempts (for exponential backoff)
  // PENDING BROADCAST: Set true on j_broadcast, cleared on HankoBatchProcessed or j_clear_batch
  // When true, new operations CANNOT be added to the batch (must wait for finalization or clear)
  pendingBroadcast: boolean;
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
    cooperativeUpdate: [],
    cooperativeDisputeProof: [],
    disputeStarts: [], // Match Solidity: InitialDisputeProof[]
    disputeFinalizations: [], // Match Solidity: FinalDisputeProof[]
    externalTokenToReserve: [],
    reserveToExternalToken: [],
    revealSecrets: [],
    hub_id: 0,
  };
}

const cloneProofbody = (proofbody: any): any => {
  if (!proofbody) return proofbody;
  try {
    return structuredClone(proofbody);
  } catch {
    return proofbody;
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
        insuranceRegs: settlement.insuranceRegs.map(reg => ({ ...reg })),
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
      cooperativeUpdate: [],  // Legacy - not used
      cooperativeDisputeProof: [],  // Legacy - not used
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
    'tuple(bytes32 counterparty, uint256 tokenId, uint256 amount, bytes sig)[] collateralToReserve,' +
    'tuple(bytes32 leftEntity, bytes32 rightEntity, tuple(uint256 tokenId, int256 leftDiff, int256 rightDiff, int256 collateralDiff, int256 ondeltaDiff)[] diffs, uint256[] forgiveDebtsInTokenIds, tuple(bytes32 insured, bytes32 insurer, uint256 tokenId, uint256 limit, uint64 expiresAt)[] insuranceRegs, bytes sig, address entityProvider, bytes hankoData, uint256 nonce)[] settlements,' +
    'tuple(bytes32 counterentity, uint256 cooperativeNonce, uint256 disputeNonce, bytes32 proofbodyHash, bytes sig, bytes initialArguments)[] disputeStarts,' +
    'tuple(bytes32 counterentity, uint256 initialCooperativeNonce, uint256 finalCooperativeNonce, uint256 initialDisputeNonce, uint256 finalDisputeNonce, bytes32 initialProofbodyHash, tuple(int256[] offdeltas, uint256[] tokenIds, tuple(address transformerAddress, bytes encodedBatch, tuple(uint256 deltaIndex, uint256 rightAllowance, uint256 leftAllowance)[] allowances)[] transformers) finalProofbody, bytes finalArguments, bytes initialArguments, bytes sig, bool startedByLeft, uint256 disputeUntilBlock, bool cooperative)[] disputeFinalizations,' +
    'tuple(bytes32 entity, bytes32 packedToken, uint256 internalTokenId, uint256 amount)[] externalTokenToReserve,' +
    'tuple(bytes32 receivingEntity, uint256 tokenId, uint256 amount)[] reserveToExternalToken,' +
    'tuple(address transformer, bytes32 secret)[] revealSecrets,' +
    'uint256 hub_id' +
  ')';

const BATCH_DOMAIN_SEPARATOR = ethers.keccak256(ethers.toUtf8Bytes('XLN_DEPOSITORY_HANKO_V1'));

export function encodeJBatch(batch: JBatch): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  // Always encode with full ABI (includes collateralToReserve, even if empty)
  return abiCoder.encode([DEPOSITORY_BATCH_ABI as any], [batch]);
}

export function decodeJBatch(encodedBatch: string): JBatch {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const decoded = abiCoder.decode([DEPOSITORY_BATCH_ABI as any], encodedBatch);
  return decoded[0] as JBatch;
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
            insurance: batch.settlements[0]?.insuranceRegs.length ?? 0,
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

  for (const op of batch.reserveToReserve) {
    const receiving = normalizeEntityId(op.receivingEntity);
    if (receiving === normalizedEntityId) {
      issues.push(`reserveToReserve to self (${op.receivingEntity.slice(-4)})`);
    }
  }

  for (const s of batch.settlements) {
    if (compareEntityIds(s.leftEntity, s.rightEntity) >= 0) {
      issues.push(`settlement left>=right: ${s.leftEntity.slice(-4)} >= ${s.rightEntity.slice(-4)}`);
    }
    const hasChanges = s.diffs.length > 0 || s.forgiveDebtsInTokenIds.length > 0 || s.insuranceRegs.length > 0;
    if (hasChanges && (!s.sig || s.sig === '0x')) {
      issues.push(`settlement missing sig: ${s.leftEntity.slice(-4)}↔${s.rightEntity.slice(-4)}`);
    }
    for (const reg of s.insuranceRegs) {
      if (normalizeEntityId(reg.insured) === normalizeEntityId(reg.insurer)) {
        issues.push(`insuranceReg insured==insurer (${reg.insured.slice(-4)})`);
      }
      if (reg.limit <= 0n) {
        issues.push(`insuranceReg limit=0 (${reg.insured.slice(-4)})`);
      }
      if (nowSec > 0 && reg.expiresAt <= BigInt(nowSec)) {
        issues.push(`insuranceReg expired (${reg.insured.slice(-4)})`);
      }
    }
  }

  for (const f of batch.disputeFinalizations) {
    if (f.cooperative && (!f.sig || f.sig === '0x')) {
      issues.push(`cooperative dispute finalize missing sig (${f.counterentity.slice(-4)})`);
    }
    if (!f.cooperative && f.sig && f.sig !== '0x') {
      const initialNonce = typeof f.initialDisputeNonce === 'bigint' ? f.initialDisputeNonce : BigInt(f.initialDisputeNonce);
      const finalNonce = typeof f.finalDisputeNonce === 'bigint' ? f.finalDisputeNonce : BigInt(f.finalDisputeNonce);
      if (initialNonce >= finalNonce) {
        issues.push(`counterdispute nonce order (${f.counterentity.slice(-4)})`);
      }
    }
  }

  return issues;
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
    jurisdiction: null, // Will be set when first operation is added
    lastBroadcast: 0,
    broadcastCount: 0,
    failedAttempts: 0,
    pendingBroadcast: false,
  };
}

/**
 * Check if batch has pending broadcast (block new operations until finalized)
 * @throws Error if batch is pending broadcast
 */
export function assertBatchNotPending(jBatchState: JBatchState, operation: string): void {
  if (jBatchState.pendingBroadcast) {
    throw new Error(
      `❌ Cannot add ${operation}: jBatch has pending broadcast. ` +
      `Wait for HankoBatchProcessed or use j_clear_batch to abort.`
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

  console.log(`📦 jBatch: Added R→C ${amount} token ${tokenId} for ${entityId.slice(-4)}→${counterpartyId.slice(-4)}`);
}

/**
 * Insurance registration for settlement
 */
export interface InsuranceReg {
  insured: string;
  insurer: string;
  tokenId: number;
  limit: bigint;
  expiresAt: bigint;
}


/**
 * Detect if a settlement is a pure C2R (collateral-to-reserve) operation
 * Pure C2R: one side withdraws `amount` from their share of collateral to their reserve
 *
 * Pattern:
 * - Only 1 diff
 * - No forgiveDebtsInTokenIds or insuranceRegs
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
  forgiveDebtsInTokenIds: number[],
  insuranceRegs: InsuranceReg[]
): { isPureC2R: true; withdrawer: 'left' | 'right'; tokenId: number; amount: bigint } | { isPureC2R: false } {
  // Must have exactly 1 diff
  if (diffs.length !== 1) return { isPureC2R: false };

  // Must have no debt forgiveness or insurance
  if (forgiveDebtsInTokenIds.length > 0 || insuranceRegs.length > 0) return { isPureC2R: false };

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
  insuranceRegs: InsuranceReg[] = [],
  sig?: string,
  entityProvider: string = '0x0000000000000000000000000000000000000000',
  hankoData: string = '0x',
  nonce: number = 0,
  initiatorEntity?: string
): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'settlement');

  // Validate entities are in canonical order
  if (leftEntity >= rightEntity) {
    throw new Error(`Settlement entities must be ordered: ${leftEntity} >= ${rightEntity}`);
  }

  const hasChanges = diffs.length > 0 ||
    forgiveDebtsInTokenIds.length > 0 ||
    insuranceRegs.length > 0;

  if (hasChanges && (!sig || sig === '0x')) {
    throw new Error(`Settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)} missing hanko signature`);
  }

  // Compress pure C2R settlements into collateralToReserve (saves calldata)
  const c2rResult = detectPureC2R(diffs, forgiveDebtsInTokenIds, insuranceRegs);
  if (c2rResult.isPureC2R && sig) {
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
        sig,
      });

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
    // Append new insurance registrations
    existing.insuranceRegs.push(...insuranceRegs);
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
      insuranceRegs,
      sig: sig || '',
      entityProvider,
      hankoData,
      nonce,
    });
  }

  const insuranceMsg = insuranceRegs.length > 0 ? `, ${insuranceRegs.length} insurance regs` : '';
  console.log(`📦 jBatch: Added settlement ${leftEntity.slice(-4)}↔${rightEntity.slice(-4)}, ${diffs.length} tokens${insuranceMsg}`);
}

/**
 * Add insurance registration to existing settlement (or create new settlement)
 */
export function batchAddInsurance(
  jBatchState: JBatchState,
  leftEntity: string,
  rightEntity: string,
  insuranceReg: InsuranceReg
): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'insurance');

  // Validate entities are in canonical order
  const [left, right] = isLeftEntity(leftEntity, rightEntity) ? [leftEntity, rightEntity] : [rightEntity, leftEntity];

  // Find or create settlement
  let existing = jBatchState.batch.settlements.find(
    s => s.leftEntity === left && s.rightEntity === right
  );

  if (!existing) {
    // Create empty settlement just for insurance
    existing = {
      leftEntity: left,
      rightEntity: right,
      diffs: [],
      forgiveDebtsInTokenIds: [],
      insuranceRegs: [],
      sig: '',
      entityProvider: '0x0000000000000000000000000000000000000000',
      hankoData: '0x',
      nonce: 0,
    };
    jBatchState.batch.settlements.push(existing);
  }

  if (!existing) {
    throw new Error('Failed to create settlement for insurance registration');
  }

  existing.insuranceRegs.push(insuranceReg);
  console.log(`📦 jBatch: Added insurance ${insuranceReg.insurer.slice(-4)}→${insuranceReg.insured.slice(-4)}, ${insuranceReg.limit} limit`);
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

  console.log(`📦 jBatch: Added R→R ${amount} token ${tokenId} to ${receivingEntity.slice(-4)}`);
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
 * BrowserVM interface for batch processing
 * Matches frontend/src/lib/view/utils/browserVMProvider.ts
 */
export interface BrowserVMBatchProcessor {
  processBatch(encodedBatch: string, entityProvider: string, hankoData: string, nonce: bigint): Promise<any[]>;
  setBlockTimestamp?: (timestamp: number) => void;
  signSettlement?: (
    initiatorEntityId: string,
    counterpartyEntityId: string,
    diffs: Array<{
      tokenId: number;
      leftDiff: bigint;
      rightDiff: bigint;
      collateralDiff: bigint;
      ondeltaDiff: bigint;
    }>,
    forgiveDebtsInTokenIds?: number[],
    insuranceRegs?: Array<{
      insured: string;
      insurer: string;
      tokenId: number;
      limit: bigint;
      expiresAt: bigint;
    }>
  ) => Promise<string>;
  getEntityProviderAddress?: () => string;
  getDepositoryAddress?: () => string;
  getEntityNonce?: (entityId: string) => Promise<bigint>;
  getChainId?: () => bigint;
}

/**
 * Broadcast batch to Depository contract (ethers or BrowserVM)
 * Reference: 2019src.txt lines 3384-3399
 */
export async function broadcastBatch(
  env: any,
  entityId: string,
  jBatchState: JBatchState,
  jurisdiction: any, // JurisdictionConfig
  browserVM: BrowserVMBatchProcessor | undefined,
  timestamp: number,
  signerId?: string
): Promise<{ success: boolean; txHash?: string; events?: any[]; error?: string }> {
  if (isBatchEmpty(jBatchState.batch)) {
    console.log('📦 jBatch: Empty batch, skipping broadcast');
    return { success: true };
  }

  const batchSize = getBatchSize(jBatchState.batch);
  const b = jBatchState.batch;
  console.log(`📤 BATCH: ${entityId.slice(-4)} | ${batchSize} ops | R→C=${b.reserveToCollateral.length} C→R=${b.collateralToReserve.length} S=${b.settlements.length} R→R=${b.reserveToReserve.length}`);
  const entityProviderAddress =
    (browserVM as any)?.getEntityProviderAddress?.() ||
    jurisdiction?.entityProviderAddress ||
    '0x0000000000000000000000000000000000000000';
  const depositoryAddress =
    (browserVM as any)?.getDepositoryAddress?.() ||
    jurisdiction?.depositoryAddress ||
    '0x0000000000000000000000000000000000000000';
  const chainId =
    (browserVM as any)?.getChainId?.() ??
    (jurisdiction?.chainId !== undefined ? BigInt(jurisdiction.chainId) : 0n);

  try {
    if (!signerId) {
      throw new Error(`Missing signerId for batch broadcast from ${entityId.slice(-4)}`);
    }

    // BrowserVM path - direct in-browser execution
    if (browserVM) {
      browserVM.setBlockTimestamp?.(timestamp);

      for (const settlement of jBatchState.batch.settlements) {
        const hasChanges = settlement.diffs.length > 0 ||
          settlement.forgiveDebtsInTokenIds.length > 0 ||
          settlement.insuranceRegs.length > 0;

        if (hasChanges) {
          if (entityProviderAddress === '0x0000000000000000000000000000000000000000') {
            console.warn(`⚠️ Settlement missing EntityProvider address (required for Hanko verification)`);
          }
          settlement.entityProvider = entityProviderAddress;
          if (!settlement.sig || settlement.sig === '0x') {
            throw new Error(`Settlement ${settlement.leftEntity.slice(-4)}↔${settlement.rightEntity.slice(-4)} missing hanko signature`);
          }
        } else if (!settlement.sig) {
          settlement.sig = '0x';
        }
      }

      if (depositoryAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('Missing depository address for batch broadcast');
      }
      if (entityProviderAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('Missing entity provider address for batch broadcast');
      }
      if (!browserVM.getEntityNonce) {
        throw new Error('BrowserVM missing getEntityNonce for hanko batch signing');
      }
      if (!chainId) {
        throw new Error('Missing chainId for batch hanko signing');
      }

      const encodedBatch = encodeJBatch(jBatchState.batch);
      const normalizedEntityId = normalizeEntityId(entityId);
      const currentNonce = await browserVM.getEntityNonce(normalizedEntityId);
      const nextNonce = currentNonce + 1n;
      const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);

      const { signHashesAsSingleEntity } = await import('./hanko-signing');
      const hankos = await signHashesAsSingleEntity(env, normalizedEntityId, signerId, [batchHash]);
      const hankoData = hankos[0];
      if (!hankoData) {
        throw new Error('Failed to build batch hanko signature');
      }

      const debugSummary = {
        entityId: normalizedEntityId,
        currentNonce: currentNonce.toString(),
        nextNonce: nextNonce.toString(),
        chainId: chainId.toString(),
        depository: depositoryAddress,
        entityProvider: entityProviderAddress,
        hankoBytes: Math.max(hankoData.length - 2, 0) / 2,
        batchSize: getBatchSize(jBatchState.batch),
        r2r: jBatchState.batch.reserveToReserve.length,
        r2c: jBatchState.batch.reserveToCollateral.length,
        settlements: jBatchState.batch.settlements.length,
        disputes: jBatchState.batch.disputeStarts.length,
        finals: jBatchState.batch.disputeFinalizations.length,
      };
      console.log(`🔐 BATCH-HANKO: ${safeStringify(debugSummary)}`);
      const preflightIssues = preflightBatchForE2(normalizedEntityId, jBatchState.batch, Math.floor(timestamp / 1000));
      if (preflightIssues.length > 0) {
        throw new Error(`Batch preflight failed: ${preflightIssues.join('; ')}`);
      }

      // Pass batch to contract with hanko authorization
      console.log(`📦 Calling Depository.processBatch() with full batch (${getBatchSize(jBatchState.batch)} ops)...`);
      const events = await browserVM.processBatch(encodedBatch, entityProviderAddress, hankoData, nextNonce);
      console.log(`   ✅ BrowserVM: ${events.length} events`);

      // NOTE: j-events are queued in env.runtimeInput.entityInputs by j-watcher
      // Caller must process them (prepopulate calls processJEvents, browser needs interval)

      // DO NOT clear batch - wait for HankoBatchProcessed event to confirm
      // Set pendingBroadcast to block new operations until finalized
      jBatchState.pendingBroadcast = true;
      jBatchState.lastBroadcast = timestamp;
      jBatchState.broadcastCount++;
      jBatchState.failedAttempts = 0;

      return { success: true, events };
    }

    // Ethers path - real blockchain RPC
    const { connectToEthereum } = await import('./evm');
    const { depository, provider } = await connectToEthereum(jurisdiction);

    for (const settlement of jBatchState.batch.settlements) {
      const hasChanges = settlement.diffs.length > 0 ||
        settlement.forgiveDebtsInTokenIds.length > 0 ||
        settlement.insuranceRegs.length > 0;
      if (hasChanges) {
        if (entityProviderAddress === '0x0000000000000000000000000000000000000000') {
          console.warn(`⚠️ Settlement missing EntityProvider address (required for Hanko verification)`);
        }
        settlement.entityProvider = entityProviderAddress;
        if (!settlement.sig || settlement.sig === '0x') {
          throw new Error(`Settlement ${settlement.leftEntity.slice(-4)}↔${settlement.rightEntity.slice(-4)} missing hanko signature`);
        }
      } else if (!settlement.sig) {
        settlement.sig = '0x';
      }
    }

    if (!chainId) {
      const net = await provider.getNetwork();
      if (!net.chainId) {
        throw new Error('Missing chainId for batch hanko signing');
      }
    }
    const resolvedChainId = chainId || BigInt((await provider.getNetwork()).chainId);

    const encodedBatch = encodeJBatch(jBatchState.batch);
    const normalizedEntityId = normalizeEntityId(entityId);
    const entityAddress = ethers.getAddress(`0x${normalizedEntityId.slice(-40)}`);
    const currentNonce = await depository['entityNonces']?.(entityAddress);
    const nextNonce = BigInt(currentNonce ?? 0) + 1n;
    const batchHash = computeBatchHankoHash(resolvedChainId, depositoryAddress, encodedBatch, nextNonce);

    const { signHashesAsSingleEntity } = await import('./hanko-signing');
    const hankos = await signHashesAsSingleEntity(env, entityId, signerId, [batchHash]);
    const hankoData = hankos[0];
    if (!hankoData) {
      throw new Error('Failed to build batch hanko signature');
    }

    // Submit to Depository.processBatch (Hanko)
    const tx = await depository['processBatch']!(encodedBatch, entityProviderAddress, hankoData, nextNonce, {
      gasLimit: 5000000, // High limit for complex batches
    });

    const receipt = await tx.wait();
    console.log(`   ✅ Ethers: block=${receipt.blockNumber} gas=${receipt.gasUsed}`);

    // DO NOT clear batch - wait for HankoBatchProcessed event to confirm
    // Set pendingBroadcast to block new operations until finalized
    jBatchState.pendingBroadcast = true;
    jBatchState.lastBroadcast = timestamp;
    jBatchState.broadcastCount++;
    jBatchState.failedAttempts = 0;

    return {
      success: true,
      txHash: receipt.transactionHash,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ BATCH FAIL: ${entityId.slice(-4)} | ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      console.error(`   ❌ BATCH FAIL STACK: ${error.stack}`);
    }
    jBatchState.failedAttempts++;

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Check if batch should be broadcast
 * Triggers: batch full, timeout, or manual flush
 */
export function shouldBroadcastBatch(
  jBatchState: JBatchState,
  currentTimestamp: number
): boolean {
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
