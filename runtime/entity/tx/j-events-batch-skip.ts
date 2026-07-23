import type { EntityState, JurisdictionEvent } from '../../types';
import type { BatchOperationSkip, BatchOperationType } from '../../jurisdiction/batch';
import { addMessage } from '../../state-helpers';

const OPERATION_TYPES: readonly BatchOperationType[] = [
  'reserveToReserve',
  'collateralToReserve',
  'settlement',
  'reserveToCollateral',
  'reserveToExternalToken',
];

const normalizeHash = (value: unknown): string => String(value ?? '').trim().toLowerCase();

export function applyBatchOperationSkippedEvent(
  state: EntityState,
  event: Extract<JurisdictionEvent, { type: 'BatchOperationSkipped' }>,
): void {
  const { entityId, batchHash, nonce, operationType, operationIndex, reason } = event.data;
  if (normalizeHash(entityId) !== normalizeHash(state.entityId)) return;
  const pending = state.jBatchState?.sentBatch;
  if (
    !pending ||
    pending.entityNonce !== nonce ||
    normalizeHash(pending.batchHash) !== normalizeHash(batchHash)
  ) return;
  const operationName = OPERATION_TYPES[operationType];
  if (!operationName || reason !== 0 || !Number.isSafeInteger(operationIndex) || operationIndex < 0) {
    throw new Error(`J_BATCH_SKIP_INVALID:${operationType}:${operationIndex}:${reason}`);
  }
  const skipped: BatchOperationSkip = {
    operationType: operationName,
    operationIndex,
    reason: 'insufficientBalance',
  };
  const existing = pending.skippedOperations ?? [];
  if (existing.some((item) =>
    item.operationType === skipped.operationType &&
    item.operationIndex === skipped.operationIndex
  )) return;
  pending.skippedOperations = [...existing, skipped];
  addMessage(state, `⏭️ jBatch skipped ${operationName}[${operationIndex}]: insufficient balance`);
}
