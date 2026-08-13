import { createStructuredLogger } from '../../infra/logger.ts';
import { normalizeRuntimeFailureCode } from '../../protocol/errors/failure-taxonomy';
import type { RuntimeReplica } from '../types.ts';
import { haltRuntimeRequiresOperator } from '../lifecycle.ts';

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
  env: RuntimeReplica,
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
  env: RuntimeReplica,
  config: FatalLoopConfig | undefined,
  error: unknown,
): Promise<string> => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  haltRuntimeRequiresOperator(env, error);
  if (config?.onFatal) {
    try {
      await config.onFatal({
        code: normalizeRuntimeFailureCode(message),
        message,
        height: Math.max(0, env.state.height ?? 0),
        timestamp: Math.max(0, env.state.timestamp ?? 0),
      });
    } catch (reportError) {
      failureLog.error('fatal_report_failed', {
        error: reportError instanceof Error ? reportError.message : String(reportError),
      });
    }
  }
  failureLog.error('error', { message, ...(stack ? { stack } : {}) });
  emitRuntimeLoopError(env, 'RUNTIME_LOOP_ERROR', { message, ...(stack ? { stack } : {}) });
  return message;
};
