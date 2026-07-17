export type RuntimeFailureKind = 'drop' | 'defer' | 'debug-assert' | 'fatal';

export type RuntimeFailureClassification = {
  kind: RuntimeFailureKind;
  retryable: boolean;
  message: string;
};

const compact = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, 240);

export const runtimeFailureMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const parts = [
      error.name && error.name !== 'Error' ? error.name : '',
      error.message,
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? String((error as Error & { code?: unknown }).code)
        : '',
    ].filter(Boolean);
    return compact(parts.join(': ')) || 'Runtime command failed';
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const parts = [record['name'], record['code'], record['message'], record['error'], record['reason']]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .map(String);
    return compact(parts.join(': ')) || 'Runtime command failed';
  }
  return compact(String(error || 'Runtime command failed')) || 'Runtime command failed';
};

export function classifyRuntimeFailure(error: unknown): RuntimeFailureClassification {
  const message = runtimeFailureMessage(error);
  const lower = message.toLowerCase();
  const explicitlyRetryable = typeof error === 'object' && error !== null
    && (error as { retryable?: unknown }).retryable === true;
  const adapterCode = typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : null;

  if (/\b(assert|assertion|invariant|unreachable|should never|debug[-_ ]?assert|panic)\b/.test(lower)) {
    return { kind: 'debug-assert', retryable: false, message };
  }

  if (adapterCode === 'E_BAD_QUERY' || adapterCode === 'E_BAD_PATH' || adapterCode === 'E_NOT_FOUND') {
    return { kind: 'drop', retryable: false, message };
  }
  if (adapterCode === 'E_COMMAND_PENDING' || adapterCode === 'E_RATE_LIMITED') {
    return { kind: 'defer', retryable: true, message };
  }
  if (adapterCode === 'E_INTERNAL') {
    return explicitlyRetryable
      ? { kind: 'defer', retryable: true, message }
      : { kind: 'fatal', retryable: false, message };
  }
  if (adapterCode === 'E_UNAUTHORIZED') {
    return { kind: 'fatal', retryable: false, message };
  }

  if (/\b(stale|duplicate|already processed|forbidden|unauthorized|bad request|malformed|invalid input|invalid runtime input|rejected)\b/.test(lower)) {
    return { kind: 'drop', retryable: false, message };
  }

  if (explicitlyRetryable || /\b(expired|timeout|timed out|aborterror|econnrefused|econnreset|enotfound|eai_again|network|fetch failed|not ready|busy|locked|retry|rate limit|429|503|504)\b/.test(lower)) {
    return { kind: 'defer', retryable: true, message };
  }

  return { kind: 'fatal', retryable: false, message };
}
