import type { EntityOutput } from '../types';

const isPureSelfJBroadcast = (output: EntityOutput, selfEntityId: string): boolean =>
  output.entityId.toLowerCase() === selfEntityId.toLowerCase()
  && output.entityTxs?.length === 1
  && output.entityTxs[0]?.type === 'j_broadcast';

/**
 * Reduce handler-local broadcast requests to one durable continuation.
 *
 * Financial operations are accumulated in one jBatch, so multiple self
 * broadcasts from the same Entity frame are never independent work. The
 * first continuation submits the whole eligible draft; another would collide
 * with its immutable sentBatch. An enclosing manual broadcast owns the same
 * submission, while an existing sentBatch delegates the next attempt solely
 * to its exact HankoBatchProcessed acknowledgement.
 */
export const filterEntityFrameBroadcastContinuations = (
  accumulated: readonly EntityOutput[],
  candidates: readonly EntityOutput[],
  selfEntityId: string,
  manualBroadcastInInput: boolean,
  sentBatchPending: boolean,
): EntityOutput[] => {
  let continuationOwned = accumulated.some(output =>
    isPureSelfJBroadcast(output, selfEntityId));
  return candidates.filter((output) => {
    if (!isPureSelfJBroadcast(output, selfEntityId)) return true;
    if (manualBroadcastInInput || sentBatchPending || continuationOwned) return false;
    continuationOwned = true;
    return true;
  });
};
