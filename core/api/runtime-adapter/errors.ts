import type { RuntimeAdapterErrorCode, RuntimeAdapterErrorPayload } from './types';

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
  if (message === 'RUNTIME_COMMITTED_STATE_UNAVAILABLE_RELOAD_REQUIRED') {
    return { code: 'E_INTERNAL', message, retryable: true, retryAfterMs: 50 };
  }
  return {
    code: 'E_INTERNAL',
    message,
    retryable: false,
  };
};
