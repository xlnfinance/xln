import { clearPendingAuditEvents } from '../env-events';
import { transitionRuntimeLifecycle } from '../lifecycle';
import { ensureRuntimeState } from '../runtime-state';
import type { RuntimeState } from '../../types';
import type { FrameExecutionState } from './execution-state';
import {
  abortRuntimeFrameTransaction,
  publishRuntimeFrameTransaction,
} from './transaction';

import type { RuntimeFrameCommitStatus } from '../../storage/commit-status';

export type { RuntimeFrameCommitStatus } from '../../storage/commit-status';

const haltRuntimeAtProvenState = (
  runtime: RuntimeState,
  message: string,
): void => {
  const state = ensureRuntimeState(runtime);
  transitionRuntimeLifecycle(state, 'halted');
  state.fatalDebugPayload = {
    message,
    height: Math.max(0, runtime.height),
    timestamp: Math.max(0, runtime.timestamp),
  };
  state.stopLoop?.();
};

/**
 * Resolve a storage error without guessing whether an unknown WAL append won.
 *
 * A proven commit may be installed before halting. Unknown durability must
 * leave live RAM on its previous frame; recovery alone decides which durable
 * frame wins after restart.
 */
export const handleRuntimeFrameStorageFailure = async (
  status: RuntimeFrameCommitStatus,
  error: Error,
  liveRuntime: RuntimeState,
  candidateRuntime: RuntimeState,
  frame: FrameExecutionState,
): Promise<void> => {
  clearPendingAuditEvents(candidateRuntime);
  if (status === 'not-committed') return;
  if (!frame.transaction) throw new Error('RUNTIME_FRAME_STORAGE_FAILURE_TRANSACTION_MISSING');

  frame.commitDisposition = status;
  frame.reliableReceiptStateDurable = status === 'committed';
  if (status === 'committed') {
    haltRuntimeAtProvenState(
      publishRuntimeFrameTransaction(frame.transaction),
      error.message,
    );
    return;
  }

  const cleanupErrors = await abortRuntimeFrameTransaction(frame.transaction);
  haltRuntimeAtProvenState(liveRuntime, error.message);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [error, ...cleanupErrors],
      'RUNTIME_FRAME_UNKNOWN_STORAGE_CANDIDATE_ABORT_FAILED',
    );
  }
};
