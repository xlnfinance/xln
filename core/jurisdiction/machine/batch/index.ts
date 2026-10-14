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
import { normalizeEntityId, compareEntityIds } from '../../../entity/id';
import { createStructuredLogger, shortHash, shortId } from '../../../support/logger';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';
import {
  J_BATCH_CONTRACT_LIMITS,
  batchOpCount,
  requireArrayRoom,
  requireBatchRoom,
} from './limits';
import type {
  HashLadderRegistration,
  JBatch,
  JBatchState,
  SettlementBatchOp,
} from './types';

export type {
  HashLadderRegistration,
  JBatch,
  JBatchState,
  OptionalDisputeArgumentWarning,
  SentJBatch,
} from './types';
export {
  J_BATCH_CONTRACT_LIMITS,
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
  assertJBatchWithinContractLimits,
  batchOpCount,
  getJBatchContractLimitIssue,
  sanitizeOptionalDisputeArgument,
  sanitizeOptionalDisputeStarterArgumentPair,
} from './limits';
export {
  computeBatchHankoHash,
  decodeJBatch,
  encodeJBatch,
  materializeAbiValue,
} from './codec';

const jBatchLog = createStructuredLogger('j.batch');
const PROOF_BODY_PARAM = ethers.ParamType.from(PROOF_BODY_ABI);

/**
 * Create empty batch (2019src.txt line 3368)
 */
export function createEmptyBatch(): JBatch {
  return {
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

export function summarizeBatch(batch: JBatch): Record<string, unknown> {
  const sample = <T>(arr: T[]) => (arr.length > 0 ? arr[0] : null);
  return {
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
    externalTokenToReserve: {
      count: batch.externalTokenToReserve.length,
      sample: sample(batch.externalTokenToReserve),
    },
    reserveToExternalToken: {
      count: batch.reserveToExternalToken.length,
      sample: sample(batch.reserveToExternalToken),
    },
    revealSecrets: { count: batch.revealSecrets.length, sample: sample(batch.revealSecrets) },
    hashLadderRegistrations: {
      count: batch.hashLadderRegistrations.length,
      sample: sample(batch.hashLadderRegistrations),
    },
  };
}

export function preflightBatchForE2(entityId: string, batch: JBatch): string[] {
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
    const finalProofbodyHash = ethers
      .keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [f.finalProofbody]))
      .toLowerCase();
    const initialProofbodyHash = String(f.initialProofbodyHash || '').toLowerCase();
    if (f.sig && f.sig !== '0x') {
      const initialNonce = typeof f.initialNonce === 'bigint' ? f.initialNonce : BigInt(f.initialNonce);
      const finalNonce = typeof f.finalNonce === 'bigint' ? f.finalNonce : BigInt(f.finalNonce);
      if (initialNonce >= finalNonce) {
        issues.push(`dispute finalization nonce order (${f.counterentity.slice(-4)})`);
      }
    }
    if ((!f.sig || f.sig === '0x') && finalProofbodyHash !== initialProofbodyHash) {
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
export function getDraftBatchReserveDelta(entityId: string, batch: JBatch | null | undefined, tokenId: number): bigint {
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

export { getOpenOutgoingDebtTotals, simulateDraftBatchReserveAvailability } from './reserve-simulation';
export type { DraftBatchReserveIssue } from './reserve-simulation';

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
  amount: bigint,
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
    op => op.receivingEntity === entityId && op.tokenId === tokenId,
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
  forgiveDebtsInTokenIds: number[],
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

const sameHexBytes = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const sameUnsignedInteger = (left: number | bigint, right: number | bigint): boolean => BigInt(left) === BigInt(right);

/**
 * Signed settlement arrays are hash preimages, so ordering is semantic. An
 * exact transport retry may be ignored, but no field can be merged or replaced
 * after the Hanko has authorized those exact bytes.
 */
const isExactSettlementRetry = (existing: SettlementBatchOp, candidate: SettlementBatchOp): boolean =>
  normalizeEntityId(existing.leftEntity) === normalizeEntityId(candidate.leftEntity) &&
  normalizeEntityId(existing.rightEntity) === normalizeEntityId(candidate.rightEntity) &&
  existing.diffs.length === candidate.diffs.length &&
  existing.diffs.every((diff, index) => {
    const other = candidate.diffs[index];
    return (
      !!other &&
      sameUnsignedInteger(diff.tokenId, other.tokenId) &&
      diff.leftDiff === other.leftDiff &&
      diff.rightDiff === other.rightDiff &&
      diff.collateralDiff === other.collateralDiff &&
      diff.ondeltaDiff === other.ondeltaDiff
    );
  }) &&
  existing.forgiveDebtsInTokenIds.length === candidate.forgiveDebtsInTokenIds.length &&
  existing.forgiveDebtsInTokenIds.every((tokenId, index) => {
    const other = candidate.forgiveDebtsInTokenIds[index];
    return other !== undefined && sameUnsignedInteger(tokenId, other);
  }) &&
  sameHexBytes(existing.sig, candidate.sig) &&
  sameUnsignedInteger(existing.nonce, candidate.nonce);

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
  if (compareEntityIds(leftEntity, rightEntity) >= 0) {
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
    settlement =>
      normalizeEntityId(settlement.leftEntity) === normalizeEntityId(leftEntity) &&
      normalizeEntityId(settlement.rightEntity) === normalizeEntityId(rightEntity),
  );
  if (existing) {
    if (isExactSettlementRetry(existing, candidate)) return;
    throw new Error(`J_BATCH_SETTLEMENT_CONFLICT:${leftEntity.slice(-4)}:${rightEntity.slice(-4)}`);
  }

  // Compress pure C2R settlements into collateralToReserve (saves calldata)
  const c2rResult = detectPureC2R(diffs, forgiveDebtsInTokenIds);
  const shortcutCounterparty = c2rResult.isPureC2R
    ? c2rResult.withdrawer === 'left'
      ? rightEntity
      : leftEntity
    : undefined;
  const shortcutWithdrawer = c2rResult.isPureC2R
    ? c2rResult.withdrawer === 'left'
      ? leftEntity
      : rightEntity
    : undefined;
  const shortcutAllowed =
    c2rResult.isPureC2R &&
    !!sig &&
    !disablePureC2RShortcut &&
    (!initiatorEntity || normalizeEntityId(initiatorEntity) === normalizeEntityId(shortcutWithdrawer!));
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
    const exactShortcutRetry =
      shortcutAllowed &&
      sameUnsignedInteger(existingShortcut.tokenId, c2rResult.tokenId) &&
      existingShortcut.amount === c2rResult.amount &&
      sameUnsignedInteger(existingShortcut.nonce, nonce) &&
      sameHexBytes(existingShortcut.sig, sig!);
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

  requireArrayRoom('settlements', jBatchState.batch.settlements.length, 1, J_BATCH_CONTRACT_LIMITS.maxSettlements);
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
  amount: bigint,
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
  amount: bigint,
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
export function batchAddRevealSecret(jBatchState: JBatchState, transformer: string, secret: string): void {
  // Block if batch has pending broadcast
  assertBatchNotPending(jBatchState, 'secret reveal');

  const exists = jBatchState.batch.revealSecrets.find(r => r.transformer === transformer && r.secret === secret);
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
  const changed = upsertHashLadderRegistration(jBatchState.batch.hashLadderRegistrations, registration, () => {
    requireBatchRoom(jBatchState.batch, 'hashLadderRegistration');
    requireArrayRoom(
      'hashLadderRegistrations',
      jBatchState.batch.hashLadderRegistrations.length,
      1,
      J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations,
    );
  });
  if (!changed) return;
  if (jBatchState.status === 'empty') jBatchState.status = 'accumulating';
  jBatchLog.debug('hash_ladder_reveal.added', {
    counterpartyEntity: shortHash(registration.counterpartyEntity),
    ladderHash: shortHash(ladderHash),
    fillRatio: registration.witness.fillRatio,
    targetRole: registration.targetRole,
  });
}

const hashLadderRegistrationKey = (
  registration: Pick<HashLadderRegistration, 'counterpartyEntity' | 'fullHash' | 'partialRoot'>,
): string =>
  ethers
    .keccak256(
      ethers.solidityPacked(
        ['bytes32', 'bytes32', 'bytes32'],
        [registration.counterpartyEntity, registration.fullHash, registration.partialRoot],
      ),
    )
    .toLowerCase();

/**
 * Whether one Account-scoped registration can enter this mutable draft.
 * Replacing an existing Target slot consumes no new contract array/total-op
 * capacity; every new slot must satisfy both independent limits.
 */
export const hasHashLadderRegistrationRoom = (batch: JBatch, registration: HashLadderRegistration): boolean => {
  const slotExists = batch.hashLadderRegistrations.some(
    existing =>
      existing.targetRole === registration.targetRole &&
      hashLadderRegistrationKey(existing) === hashLadderRegistrationKey(registration),
  );
  if (slotExists) return true;
  return (
    batch.hashLadderRegistrations.length < J_BATCH_CONTRACT_LIMITS.maxHashLadderRegistrations &&
    batchOpCount(batch) < J_BATCH_CONTRACT_LIMITS.maxTotalOps
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
  const existingIndex = registrations.findIndex(
    existing =>
      existing.targetRole === registration.targetRole &&
      existing.counterpartyEntity.toLowerCase() === registration.counterpartyEntity.toLowerCase() &&
      hashLadderRegistrationKey(existing) === ladderHash,
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
  const bodyHash = ethers
    .keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [counterProof.counterProofbody]))
    .toLowerCase();
  const existingIndex = jBatchState.batch.counterDisputes.findIndex(
    item => item.counterentity.toLowerCase() === counterparty,
  );
  if (existingIndex >= 0) {
    const existing = jBatchState.batch.counterDisputes[existingIndex]!;
    const existingBodyHash = ethers
      .keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_PARAM], [existing.counterProofbody]))
      .toLowerCase();
    if (
      existing.initialNonce !== counterProof.initialNonce ||
      existing.initialProofbodyHash.toLowerCase() !== initialHash
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
