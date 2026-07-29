import type { RuntimeState, RuntimeInput } from '../types';
import { requireRuntimeMempool } from '../input-queue';
import { ensureRuntimeState } from '../runtime-state';
import type { FrameExecutionState } from './execution-state';
import {
  cloneRuntimeFrameMempool,
  prependOlderRuntimeInput,
} from './transaction';

export type UndurableRuntimeInputContext = {
  frame: FrameExecutionState;
  liveEnv: RuntimeState;
  attemptedEnv: RuntimeState;
  runtimeInput: RuntimeInput;
  mempoolQueuedAt: number | undefined;
  frameTimestampBeforeTick: number;
  quietRuntimeLogs: boolean;
  discardMalformedRemoteInput(
    input: RuntimeInput,
    error: Error,
    quiet: boolean,
  ): RuntimeInput | null;
  discardedError(error: Error): Error;
};

export type UndurableRuntimeInputResult = {
  env: RuntimeState;
  state: NonNullable<RuntimeState['runtimeState']>;
  error: Error;
};

const restoreFailedInput = (
  context: UndurableRuntimeInputContext,
  workingMempool: RuntimeInput,
  retainedInput?: RuntimeInput,
): void => {
  const { frame, liveEnv } = context;
  const retry = frame.inputDrained || retainedInput
    ? (() => {
        const attempted =
          retainedInput ??
          frame.inputForRequeue ??
          cloneRuntimeFrameMempool(context.runtimeInput);
        attempted.queuedAt ??= context.mempoolQueuedAt ?? context.frameTimestampBeforeTick;
        return prependOlderRuntimeInput(attempted, workingMempool);
      })()
    : workingMempool;
  const restored = prependOlderRuntimeInput(retry, requireRuntimeMempool(liveEnv));
  liveEnv.runtimeMempool = restored;
};

export const restoreUndurableRuntimeInput = async (
  context: UndurableRuntimeInputContext,
  cause: unknown,
  options: { discardMalformedRemoteInput?: boolean; requeue?: boolean } = {},
): Promise<UndurableRuntimeInputResult> => {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  const { frame, liveEnv } = context;
  const workingMempool = frame.transaction
    ? frame.transaction.frameMempool
    : requireRuntimeMempool(context.attemptedEnv);
  frame.reliableIngressCommits = [];
  frame.reliableReceiptSenderCheckpoint = undefined;

  const attemptedInput = frame.inputForRequeue ?? context.runtimeInput;
  const retainedInput =
    options.discardMalformedRemoteInput === false
      ? null
      : context.discardMalformedRemoteInput(
          attemptedInput,
          originalError,
          context.quietRuntimeLogs,
        );
  const discarded = retainedInput !== null;
  const retainedWorkingMempool = discarded
    ? context.discardMalformedRemoteInput(workingMempool, originalError, true) ?? workingMempool
    : workingMempool;
  if (options.requeue !== false) {
    restoreFailedInput(context, retainedWorkingMempool, retainedInput ?? undefined);
  }

  const error = discarded
    ? context.discardedError(originalError)
    : originalError;
  return { env: liveEnv, state: ensureRuntimeState(liveEnv), error };
};
