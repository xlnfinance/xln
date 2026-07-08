import { classifyRuntimeFaucetFailure, type RuntimeFailureSignal } from '../failure-taxonomy';

export const faucetFailureBody = (input: {
  code: string;
  error: string;
  success?: false;
  extra?: Record<string, unknown>;
}): Record<string, unknown> & { failure: RuntimeFailureSignal } => {
  const failure = classifyRuntimeFaucetFailure(input.code, input.error);
  return {
    ...(input.success === false ? { success: false } : {}),
    ...(input.extra ?? {}),
    error: input.error,
    code: failure.code,
    category: failure.category,
    retryable: failure.retryable,
    fatal: failure.fatal,
    failure,
  };
};
