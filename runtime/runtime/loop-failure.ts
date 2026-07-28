import { createStructuredLogger } from '../infra/logger';
import { normalizeRuntimeFailureCode } from '../protocol/failure-taxonomy';
import type { RuntimeState } from '../types';
import { transitionRuntimeLifecycle } from './lifecycle';

type RuntimeLifecycleState = NonNullable<RuntimeState['runtimeState']>;

type FatalLoopDeps = {
  getRuntimeProcessGlobal(): { exit?: (code: number) => unknown } | null;
};

type FatalLoopConfig = {
  onFatal?: (payload: {
    code: string;
    message: string;
    height: number;
    timestamp: number;
  }) => void | Promise<void>;
};

const failureLog = createStructuredLogger('runtime.loop');

export const emitRuntimeLoopError = (
  env: RuntimeState,
  code: 'RUNTIME_LOOP_ERROR' | 'RUNTIME_LOOP_HALTED',
  payload: Record<string, unknown>,
): void => {
  try {
    env.error?.('system', code, payload, env.runtimeId);
  } catch (error) {
    failureLog.error('report_failed', {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const reportFatalLoopError = async (
  env: RuntimeState,
  state: RuntimeLifecycleState,
  config: FatalLoopConfig | undefined,
  deps: FatalLoopDeps,
  error: unknown,
): Promise<string> => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  transitionRuntimeLifecycle(state, 'halted');
  state.fatalDebugPayload = {
    message,
    ...(stack ? { stack } : {}),
    height: Math.max(0, env.height ?? 0),
    timestamp: Math.max(0, env.timestamp ?? 0),
  };
  if (config?.onFatal) {
    try {
      await config.onFatal({
        code: normalizeRuntimeFailureCode(message),
        message,
        height: Math.max(0, env.height ?? 0),
        timestamp: Math.max(0, env.timestamp ?? 0),
      });
    } catch (reportError) {
      failureLog.error('fatal_report_failed', {
        error: reportError instanceof Error ? reportError.message : String(reportError),
      });
    }
  }
  failureLog.error('error', { message, ...(stack ? { stack } : {}) });
  emitRuntimeLoopError(env, 'RUNTIME_LOOP_ERROR', { message, ...(stack ? { stack } : {}) });
  deps.getRuntimeProcessGlobal()?.exit?.(1);
  return message;
};
