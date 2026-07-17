import type { JAdapterFailure, JAdapterFailureCategory } from '../types/jurisdiction-runtime';

const TRANSIENT_CODES = new Set([
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
  'NONCE_EXPIRED',
  'REPLACEMENT_UNDERPRICED',
  'TRANSACTION_REPLACED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
]);

const TERMINAL_CODES = new Set([
  'CALL_EXCEPTION',
  'INVALID_ARGUMENT',
  'ACTION_REJECTED',
  'INSUFFICIENT_FUNDS',
  'UNSUPPORTED_OPERATION',
]);

const errorRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;

const nestedErrorValues = (error: unknown): unknown[] => {
  const root = errorRecord(error);
  const info = errorRecord(root?.['info']);
  return [error, root?.['cause'], root?.['error'], info?.['error']].filter((value) => value !== undefined);
};

const errorCode = (error: unknown): string => {
  for (const value of nestedErrorValues(error)) {
    const code = errorRecord(value)?.['code'];
    if (typeof code === 'string' || typeof code === 'number') {
      const normalized = String(code).trim().toUpperCase();
      if (normalized) return normalized;
    }
  }
  return '';
};

export const jAdapterFailureMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  const message = errorRecord(error)?.['message'];
  return typeof message === 'string' && message ? message : String(error);
};

const failureSearchText = (error: unknown, message: string): string => {
  const messages = nestedErrorValues(error).flatMap((value) => {
    if (value instanceof Error && value.message) return [value.message];
    const nestedMessage = errorRecord(value)?.['message'];
    return typeof nestedMessage === 'string' ? [nestedMessage] : [];
  });
  return [message, ...messages].join(' ');
};

const classifyCategory = (code: string, message: string): JAdapterFailureCategory => {
  if (TERMINAL_CODES.has(code)) return 'terminal';
  // Revert evidence wins over transport-looking words in the same message.
  if (/staticCall revert|execution reverted|\brevert(?:ed)?\b|panic\b/i.test(message)) return 'terminal';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|Failed to fetch|NetworkError|Load failed/i.test(message) ||
    /transaction was not mined|timeout exceeded|request timeout|gateway timeout|\b503\b|\b504\b|rate limit/i.test(message) ||
    /nonce (?:has already been used|too (?:low|high)|expired)|replacement (?:fee too low|transaction underpriced)|replacement underpriced|already known|known transaction/i.test(message)
  ) return 'transient';
  return 'terminal';
};

export const classifyJAdapterFailure = (
  error: unknown,
  override: { message?: string; category?: JAdapterFailureCategory; code?: string } = {},
): JAdapterFailure => {
  const message = String(override.message ?? jAdapterFailureMessage(error));
  const extractedCode = errorCode(error);
  const category = override.category ?? classifyCategory(extractedCode, failureSearchText(error, message));
  const code = String(
    override.code || extractedCode || (category === 'transient' ? 'J_ADAPTER_TRANSIENT' : 'J_ADAPTER_TERMINAL'),
  ).trim().toUpperCase();
  return { category, code, message };
};

export const makeJAdapterFailureResult = (
  error: unknown,
  override: { message?: string; category?: JAdapterFailureCategory; code?: string } = {},
): { success: false; error: string; failure: JAdapterFailure } => {
  const failure = classifyJAdapterFailure(error, override);
  return { success: false, error: failure.message, failure };
};
