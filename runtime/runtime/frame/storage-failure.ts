import { clearPendingAuditEvents } from '../env-events';
import { transitionRuntimeLifecycle } from '../lifecycle';
import { ensureRuntimeInfrastructure } from '../runtime-infrastructure';
import type { RuntimeReplica } from '../types';
import type { FrameExecutionState } from './execution-state';
import {
  publishRuntimeFrameTransaction,
} from './transaction';

import type { RuntimeFrameCommitStatus } from '../../storage/commit-status';

export type { RuntimeFrameCommitStatus } from '../../storage/commit-status';

const haltRuntimeForRecovery = (
  runtime: RuntimeReplica,
  message: string,
): void => {
  const state = ensureRuntimeInfrastructure(runtime);
  transitionRuntimeLifecycle(state, 'halted');
  state.fatalDebugPayload = {
    message,
    height: Math.max(0, runtime.state.height),
    timestamp: Math.max(0, runtime.state.timestamp),
  };
  state.stopLoop?.();
};

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
  frame.reliableReceiptStateDurable = status === 'committed';
  if (status === 'committed') {
    haltRuntimeForRecovery(
      publishRuntimeFrameTransaction(frame.transaction),
      error.message,
    );
    return;
  }

  haltRuntimeForRecovery(liveRuntime, error.message);
};
