import { clearPendingAuditEvents } from '../../observability/env-events';
import { haltRuntimeRequiresOperator } from '../../replica/lifecycle';
import type { RuntimeReplica } from '../../types';
import type { FrameExecutionState } from '../intake/execution-state';
import {
  publishRuntimeFrameTransaction,
} from '../transaction';

import type { RuntimeFrameCommitStatus } from '../../../storage/commit/commit-status';

export type { RuntimeFrameCommitStatus } from '../../../storage/commit/commit-status';

/**
 * Resolve a storage error without guessing whether an unknown WAL append won.
 *
 * A proven commit keeps the in-place State and publishes its next-frame input.
 * Unknown durability leaves the mutated State unreadable; recovery alone
 * decides which WAL frame wins. No branch attempts an in-memory State rollback.
 */
export const handleRuntimeFrameStorageFailure = async (
  status: RuntimeFrameCommitStatus,
  error: Error,
  liveRuntime: RuntimeReplica,
  candidateRuntime: RuntimeReplica,
  frame: FrameExecutionState,
): Promise<void> => {
  clearPendingAuditEvents(candidateRuntime);
  if (status === 'not-committed') return;
  if (!frame.transaction) throw new Error('RUNTIME_FRAME_STORAGE_FAILURE_TRANSACTION_MISSING');

  frame.commitDisposition = status;
  if (status === 'committed') {
    haltRuntimeRequiresOperator(
      publishRuntimeFrameTransaction(frame.transaction),
      error.message,
    );
    return;
  }

  haltRuntimeRequiresOperator(liveRuntime, error);
};
