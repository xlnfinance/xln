import type { RuntimeReplica } from '../types';
import {
  rollbackReliableDeliveryReceipts,
  rollbackReliableIngressCommit,
} from '../reliable-delivery';
import { requireRuntimeMempool } from '../input-queue';
import { transitionRuntimeLifecycle } from '../lifecycle';
import { ensureRuntimeState } from '../runtime-state';
import {
  prependOlderRuntimeInput,
} from './transaction';
import type { FrameExecutionState } from './execution-state';
import type { RuntimeProcessProfile } from './process-profile';

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;

export type RuntimeFrameFailureDeps = {
  isStorageError(error: unknown): boolean;
  isDiscardedInputError(error: unknown): boolean;
};

export type RuntimeFrameFailure = {
  env: RuntimeReplica;
  error: unknown;
  inputDropped: boolean;
};

const haltMutatedRuntime = (
  env: RuntimeReplica,
  error: unknown,
): void => {
  const state = ensureRuntimeState(env);
  const cause = error instanceof Error ? error : new Error(String(error));
  transitionRuntimeLifecycle(state, 'halted');
  state.fatalDebugPayload = {
    message: `RUNTIME_MUTATION_FAILED_RELOAD_REQUIRED:${cause.message}`,
    height: Math.max(0, env.state.height),
    timestamp: Math.max(0, env.state.timestamp),
  };
  state.stopLoop?.();
};

export const handleRuntimeFrameFailure = async (
  error: unknown,
  liveEnv: RuntimeReplica,
  frame: FrameExecutionState,
  deps: RuntimeFrameFailureDeps,
): Promise<RuntimeFrameFailure> => {
  if (
    frame.commitDisposition === 'undurable' &&
    frame.mutationStarted &&
    !frame.failureHandled &&
    frame.restoreUndurableInput
  ) {
    frame.failureHandled = true;
    const retainedError = await frame.restoreUndurableInput(error, {
      discardMalformedRemoteInput: false,
    });
    haltMutatedRuntime(liveEnv, retainedError);
    return { env: liveEnv, error: retainedError, inputDropped: false };
  }

  if (
    frame.commitDisposition === 'undurable' &&
    !frame.failureHandled &&
    frame.restoreUndurableInput
  ) {
    frame.failureHandled = true;
    const rollbackError = await frame.restoreUndurableInput(error, {
      discardMalformedRemoteInput: !deps.isStorageError(error),
    });
    return {
      env: liveEnv,
      error: rollbackError,
      inputDropped: deps.isDiscardedInputError(rollbackError),
    };
  }

  if (
    frame.commitDisposition === 'undurable' &&
    !frame.failureHandled &&
    frame.transaction &&
    !frame.transaction.published
  ) {
    frame.failureHandled = true;
    const workingMempool = frame.transaction.frameMempool;
    const restored = prependOlderRuntimeInput(
      workingMempool,
      requireRuntimeMempool(liveEnv),
    );
    liveEnv.runtimeMempool = restored;
  }
  return { env: liveEnv, error, inputDropped: false };
};

export const finishRuntimeFrame = (
  env: RuntimeReplica,
  liveEnv: RuntimeReplica,
  state: RuntimeLifecycleState,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
  releaseWriter: () => void,
): void => {
  if (!frame.reliableReceiptStateDurable) {
    rollbackReliableIngressCommit(env, frame.reliableIngressCommits);
    if (frame.reliableReceiptSenderCheckpoint) {
      rollbackReliableDeliveryReceipts(env, frame.reliableReceiptSenderCheckpoint);
    }
  }
  if (profile.outcome === 'unknown') profile.outcome = 'thrown';
  profile.finish(env);
  state.inFlightEntityInputs = 0;
  delete liveEnv.activeProcessProgressAt;
  delete liveEnv.activeProcessProgressStep;
  releaseWriter();
};
