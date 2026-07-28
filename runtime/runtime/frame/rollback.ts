import type { Env, RuntimeInput } from '../../types';
import { ensureRuntimeMempool } from '../input-queue';
import { ensureRuntimeState } from '../runtime-state';
import type { FrameExecutionState } from './execution-state';
import {
  abortRuntimeFrameTransaction,
  cloneRuntimeFrameMempool,
  prependOlderRuntimeInput,
} from './transaction';

export type RuntimeFrameRollbackContext = {
  frame: FrameExecutionState;
  liveEnv: Env;
  attemptedEnv: Env;
  runtimeInput: RuntimeInput;
  mempoolQueuedAt: number | undefined;
  frameTimestampBeforeTick: number;
  quietRuntimeLogs: boolean;
  quarantine(input: RuntimeInput, error: Error, quiet: boolean): boolean;
  quarantinedError(error: Error): Error;
};

export type RuntimeFrameRollbackResult = {
  env: Env;
  state: NonNullable<Env['runtimeState']>;
  error: Error;
};

const restoreFailedInput = (
  context: RuntimeFrameRollbackContext,
  workingMempool: RuntimeInput,
): void => {
  const { frame, liveEnv } = context;
  const retry = frame.inputDrained
    ? (() => {
        const attempted = frame.inputForRequeue ?? cloneRuntimeFrameMempool(context.runtimeInput);
        attempted.queuedAt ??= context.mempoolQueuedAt ?? context.frameTimestampBeforeTick;
        return prependOlderRuntimeInput(attempted, workingMempool);
      })()
    : workingMempool;
  const restored = prependOlderRuntimeInput(retry, ensureRuntimeMempool(liveEnv));
  liveEnv.runtimeMempool = restored;
  liveEnv.runtimeInput = restored;
};

export const rollbackUndurableRuntimeFrame = async (
  context: RuntimeFrameRollbackContext,
  cause: unknown,
  options: { quarantine?: boolean; requeue?: boolean } = {},
): Promise<RuntimeFrameRollbackResult> => {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  const { frame, liveEnv } = context;
  const workingMempool = frame.transaction
    ? ensureRuntimeMempool(frame.transaction.workingEnv)
    : ensureRuntimeMempool(context.attemptedEnv);
  const cleanupErrors = frame.transaction
    ? await abortRuntimeFrameTransaction(frame.transaction)
    : [];
  frame.reliableIngressCommits = [];
  frame.reliableReceiptSenderCheckpoint = undefined;

  const quarantined =
    options.quarantine === false
      ? false
      : context.quarantine(context.runtimeInput, originalError, context.quietRuntimeLogs);
  if (!quarantined && options.requeue !== false) restoreFailedInput(context, workingMempool);

  const error = cleanupErrors.length
    ? new AggregateError([originalError, ...cleanupErrors], 'RUNTIME_APPLY_ROLLBACK_FAILED')
    : quarantined
      ? context.quarantinedError(originalError)
      : originalError;
  return { env: liveEnv, state: ensureRuntimeState(liveEnv), error };
};
