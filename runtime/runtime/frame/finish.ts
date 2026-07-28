import type { Env } from '../../types';
import {
  rollbackReliableDeliveryReceipts,
  rollbackReliableIngressCommit,
} from '../reliable-delivery';
import { requireRuntimeMempool } from '../input-queue';
import {
  abortRuntimeFrameTransaction,
  prependOlderRuntimeInput,
} from './transaction';
import type { FrameExecutionState } from './execution-state';
import type { RuntimeProcessProfile } from './process-profile';

type RuntimeState = NonNullable<Env['runtimeState']>;

export type RuntimeFrameFailureDeps = {
  isStorageError(error: unknown): boolean;
  isQuarantinedError(error: unknown): boolean;
};

export type RuntimeFrameFailure = {
  env: Env;
  error: unknown;
  inputDropped: boolean;
};

export const handleRuntimeFrameFailure = async (
  error: unknown,
  liveEnv: Env,
  frame: FrameExecutionState,
  deps: RuntimeFrameFailureDeps,
): Promise<RuntimeFrameFailure> => {
  if (
    frame.commitDisposition === 'undurable' &&
    !frame.rollbackHandled &&
    frame.rollbackUndurable
  ) {
    frame.rollbackHandled = true;
    const rollbackError = await frame.rollbackUndurable(error, {
      quarantine: !deps.isStorageError(error),
    });
    return {
      env: liveEnv,
      error: rollbackError,
      inputDropped: deps.isQuarantinedError(rollbackError),
    };
  }

  if (
    frame.commitDisposition === 'undurable' &&
    !frame.rollbackHandled &&
    frame.transaction &&
    !frame.transaction.published
  ) {
    frame.rollbackHandled = true;
    const workingMempool = requireRuntimeMempool(frame.transaction.workingEnv);
    const cleanupErrors = await abortRuntimeFrameTransaction(frame.transaction);
    const restored = prependOlderRuntimeInput(
      workingMempool,
      requireRuntimeMempool(liveEnv),
    );
    liveEnv.runtimeMempool = restored;
    if (cleanupErrors.length > 0) {
      const original = error instanceof Error ? error : new Error(String(error));
      return {
        env: liveEnv,
        error: new AggregateError(
          [original, ...cleanupErrors],
          'RUNTIME_FRAME_TRANSACTION_ABORT_FAILED',
        ),
        inputDropped: false,
      };
    }
  }
  return { env: liveEnv, error, inputDropped: false };
};

export const finishRuntimeFrame = (
  env: Env,
  liveEnv: Env,
  state: RuntimeState,
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
