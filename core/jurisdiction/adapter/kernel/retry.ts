import type { JAdapter, JAdapterConfig } from '../types';
import { createJAdapter } from './factory';
import { classifyJAdapterFailure } from './failure';
import { resolveJurisdictionTransport } from './jurisdiction-loader';
import { sleep } from '../../../support/boundary-guards';

type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  context?: string;
  factory?: (config: JAdapterConfig) => Promise<JAdapter>;
  onRetry?: (attempt: number, attempts: number, error: unknown) => void;
};

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
  classifyJAdapterFailure(error).category === 'transient';

/** Resolve operator I/O once, before retries; no transport metadata enters committed state. */
const resolveAdapterTransport = async (config: JAdapterConfig): Promise<JAdapterConfig> => {
  if (config.mode === 'browservm') return config;
  const depository = config.fromReplica?.contracts?.depository;
  if (!depository) return config;
  const transport = await resolveJurisdictionTransport(config.chainId, depository);
  if (!transport?.mode) return config;
  if (config.mode === 'tron' && transport.mode !== 'tron') throw new Error('JADAPTER_CONFIGURED_MODE_CONFLICT');
  if (transport.mode === 'tron') {
    for (const field of ['tronFullHost', 'tronSolidityHost'] as const) {
      const configured = transport[field] ?? transport.tronFullHost;
      if (config[field] !== undefined && config[field] !== configured) {
        throw new Error(`JADAPTER_CONFIGURED_ENDPOINT_CONFLICT:${field}`);
      }
    }
  }
  return { ...config, ...transport };
};

export async function createJAdapterWithRetry(
  config: JAdapterConfig,
  options: RetryOptions = {},
): Promise<JAdapter> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 5));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 150));
  const factory = options.factory ?? createJAdapter;
  const effectiveConfig = await resolveAdapterTransport(config);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await factory(effectiveConfig);
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
