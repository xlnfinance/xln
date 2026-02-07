export class FailFastError extends Error {
  code: string;
  context: Record<string, unknown> | undefined;

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'FailFastError';
    this.code = code;
    this.context = context;
  }
}

export const failfastAssert = (
  condition: unknown,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): void => {
  if (!condition) {
    throw new FailFastError(code, message, context);
  }
};

export const asFailFastPayload = (error: unknown) => {
  if (error instanceof FailFastError) {
    return {
      code: error.code,
      message: error.message,
      context: error.context ?? {},
    };
  }
  const err = error as Error;
  return {
    code: 'UNEXPECTED_ERROR',
    message: err?.message || String(error),
    context: {},
  };
};
