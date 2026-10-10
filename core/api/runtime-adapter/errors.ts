import type { RuntimeAdapterErrorCode, RuntimeAdapterErrorPayload } from './types';
import type { RuntimeReplica } from '../../runtime/types';
import { getRuntimeCommandReadiness } from '../../runtime/replica/lifecycle';
import { RuntimeCommittedStateUnavailableError } from '../../runtime/frame/lifecycle/writer-lock';

export class RuntimeAdapterError extends Error {
  readonly code: RuntimeAdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: RuntimeAdapterErrorCode, message: string, retryable = false, retryAfterMs?: number) {
    super(message);
    this.name = 'RuntimeAdapterError';
    this.code = code;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  toPayload(): RuntimeAdapterErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

export const toRuntimeAdapterErrorPayload = (error: unknown): RuntimeAdapterErrorPayload => {
  if (error instanceof RuntimeAdapterError) return error.toPayload();
  const message = error instanceof Error ? error.message : String(error || 'Runtime adapter error');
  // A committed-state read that races an in-flight frame writer is contention,
  // not corruption: the very next read succeeds once the writer publishes.
  if (error instanceof RuntimeCommittedStateUnavailableError) {
    return { code: 'E_INTERNAL', message, retryable: true, retryAfterMs: 50 };
  }
  return {
    code: 'E_INTERNAL',
    message,
    retryable: false,
  };
};

const TERMINAL_COMMAND_READINESS = new Set(['HALTED_REQUIRES_OPERATOR', 'phase=halted']);

/**
 * Catch-up and persistence fences clear by themselves; a halted Runtime needs
 * an operator. Reporting a halt as retryable made clients poll it every 250 ms
 * forever.
 */
export const requireRuntimeAdapterCommandReady = (env: RuntimeReplica): void => {
  const readiness = getRuntimeCommandReadiness(env);
  if (readiness.ready) return;
  const message = `RUNTIME_COMMAND_NOT_READY:${readiness.reason}`;
  if (TERMINAL_COMMAND_READINESS.has(readiness.reason)) {
    throw new RuntimeAdapterError('E_INTERNAL', message, false);
  }
  throw new RuntimeAdapterError('E_COMMAND_PENDING', message, true, 250);
};
