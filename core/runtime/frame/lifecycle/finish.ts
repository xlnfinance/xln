import type { RuntimeReplica } from '../../types';
import { requireRuntimeMempool } from '../../mempool/input-queue';
import { haltRuntimeRequiresOperator } from '../../replica/lifecycle';
import {
  prependOlderRuntimeInput,
} from '../transaction';
import type { FrameExecutionState } from '../intake/execution-state';
import type { RuntimeProcessProfile } from '../process-profile';

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
  const cause = error instanceof Error ? error : new Error(String(error));
  haltRuntimeRequiresOperator(
    env,
    new Error(`RUNTIME_MUTATION_FAILED_RELOAD_REQUIRED:${cause.message}`, { cause }),
  );
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
  profile: RuntimeProcessProfile,
  releaseWriter: () => void,
): void => {
  if (profile.outcome === 'unknown') profile.outcome = 'thrown';
  profile.finish(env);
  state.inFlightEntityInputs = 0;
  delete liveEnv.activeProcessProgressAt;
  delete liveEnv.activeProcessProgressStep;
  releaseWriter();
};
