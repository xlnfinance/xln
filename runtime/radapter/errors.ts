import type { RuntimeAdapterErrorCode, RuntimeAdapterErrorPayload } from './types';

export class RuntimeAdapterError extends Error {
  readonly code: RuntimeAdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: RuntimeAdapterErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'RuntimeAdapterError';
    this.code = code;
    this.retryable = retryable;
  }

  toPayload(): RuntimeAdapterErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const toRuntimeAdapterErrorPayload = (error: unknown): RuntimeAdapterErrorPayload => {
  if (error instanceof RuntimeAdapterError) return error.toPayload();
  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : String(error || 'Runtime adapter error'),
    retryable: false,
  };
};
