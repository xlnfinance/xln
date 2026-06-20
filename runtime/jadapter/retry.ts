import type { JAdapter, JAdapterConfig } from './types';
import { createJAdapter } from './index';

type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  context?: string;
  factory?: (config: JAdapterConfig) => Promise<JAdapter>;
  onRetry?: (attempt: number, attempts: number, error: unknown) => void;
};

const TRANSIENT_JADAPTER_STARTUP_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|Failed to fetch|NetworkError|Load failed/i;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const code = 'code' in error ? String((error as Error & { code?: unknown }).code || '') : '';
    const cause = 'cause' in error && (error as Error & { cause?: unknown }).cause instanceof Error
      ? ` cause=${((error as Error & { cause?: Error }).cause as Error).message}`
      : '';
    return `${error.name}: ${error.message}${code ? ` code=${code}` : ''}${cause}`;
  }
  return String(error);
};

export const isTransientJAdapterStartupError = (error: unknown): boolean =>
  TRANSIENT_JADAPTER_STARTUP_RE.test(errorText(error));

export async function createJAdapterWithRetry(
  config: JAdapterConfig,
  options: RetryOptions = {},
): Promise<JAdapter> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 5));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 150));
  const factory = options.factory ?? createJAdapter;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await factory(config);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientJAdapterStartupError(error)) {
        throw error;
      }
      options.onRetry?.(attempt, attempts, error);
      await sleep(Math.min(2_000, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  throw new Error(
    `JADAPTER_RETRY_EXHAUSTED${options.context ? ` context=${options.context}` : ''}: ${errorText(lastError)}`,
  );
}
