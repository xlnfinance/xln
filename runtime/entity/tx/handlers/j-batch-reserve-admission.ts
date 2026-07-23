import type { EntityState } from '../../../types';
import {
  cloneJBatch,
  createEmptyBatch,
  getOpenOutgoingDebtTotals,
  simulateDraftBatchReserveAvailability,
  type DraftBatchReserveIssue,
  type JBatch,
} from '../../../jurisdiction/batch';

type ReserveCandidate =
  | {
      type: 'reserveToReserve';
      receivingEntity: string;
      tokenId: number;
      amount: bigint;
    }
  | {
      type: 'reserveToCollateral';
      receivingEntity: string;
      counterparty: string;
      tokenId: number;
      amount: bigint;
    }
  | {
      type: 'reserveToExternalToken';
      receivingEntity: string;
      tokenId: number;
      amount: bigint;
    };

function appendReserveToCollateral(
  batch: JBatch,
  candidate: Extract<ReserveCandidate, { type: 'reserveToCollateral' }>,
): number {
  const existingIndex = batch.reserveToCollateral.findIndex((op) =>
    op.receivingEntity === candidate.receivingEntity && op.tokenId === candidate.tokenId
  );
  if (existingIndex < 0) {
    batch.reserveToCollateral.push({
      tokenId: candidate.tokenId,
      receivingEntity: candidate.receivingEntity,
      pairs: [{ entity: candidate.counterparty, amount: candidate.amount }],
    });
    return batch.reserveToCollateral.length - 1;
  }
  const existing = batch.reserveToCollateral[existingIndex]!;
  const pair = existing.pairs.find((item) => item.entity === candidate.counterparty);
  if (pair) pair.amount += candidate.amount;
  else existing.pairs.push({ entity: candidate.counterparty, amount: candidate.amount });
  return existingIndex;
}

function appendCandidate(batch: JBatch, candidate: ReserveCandidate): number {
  if (candidate.type === 'reserveToCollateral') {
    return appendReserveToCollateral(batch, candidate);
  }
  const operations = batch[candidate.type];
  operations.push({
    receivingEntity: candidate.receivingEntity,
    tokenId: candidate.tokenId,
    amount: candidate.amount,
  });
  return operations.length - 1;
}

export function getReserveCandidateIssue(
  state: EntityState,
  candidate: ReserveCandidate,
): DraftBatchReserveIssue | null {
  const batch = cloneJBatch(state.jBatchState?.batch ?? createEmptyBatch());
  const operationIndex = appendCandidate(batch, candidate);
  const simulation = simulateDraftBatchReserveAvailability(
    state.entityId,
    state.reserves,
    batch,
    getOpenOutgoingDebtTotals(state.outDebtsByToken),
  );
  const candidateIssue = simulation.issues.find((issue) =>
    issue.opType === candidate.type && issue.opIndex === operationIndex
  );
  return candidateIssue ?? simulation.issues.find((issue) => issue.failureMode === 'batchRevert') ?? null;
}
