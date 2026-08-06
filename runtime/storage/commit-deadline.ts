import type { RuntimeReplica } from '../runtime/types';
import { getPerfMs } from '../infra/time';
import { evaluateStorageProgressDeadline } from './progress-deadline';
import type { RuntimeStorageApiDeps } from './runtime-storage-deps';

export type RuntimeProcessGlobal = {
  env?: Record<string, string | undefined>;
  exit?: (code?: number) => never;
};

export class RuntimeStorageWriteTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly frameHeight: number,
    readonly runtimeId: string,
    readonly step: string,
  ) {
    super(
      `STORAGE_WRITE_TIMEOUT:frame=${frameHeight}:runtime=${runtimeId}:` +
      `timeoutMs=${timeoutMs}:step=${step}`,
    );
    this.name = 'RuntimeStorageWriteTimeoutError';
  }
}

export const getRuntimeProcessGlobal = (): RuntimeProcessGlobal | null => {
  const candidate = (
    globalThis as typeof globalThis & { process?: RuntimeProcessGlobal }
  ).process;
  return candidate && typeof candidate === 'object' ? candidate : null;
};

export const shouldRequireCanonicalStorageAudit = (
  runtimeProcess = getRuntimeProcessGlobal(),
): boolean => {
  const raw = String(
    runtimeProcess?.env?.['XLN_STORAGE_VERIFY_CANONICAL'] || '',
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const resolveStorageWriteTimeoutMs = (): number => {
  const raw = String(
    getRuntimeProcessGlobal()?.env?.['XLN_STORAGE_WRITE_TIMEOUT_MS'] || '',
  ).trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/** Storage stall deadlines measure process latency, never adjustable wall time. */
export const readStorageProgressClockMs = (): number =>
  Math.max(0, Math.floor(getPerfMs()));

export const waitForRuntimeProcessingIdle = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const startedAt = Date.now();
  while (true) {
    const pending = env.infrastructure?.processingPromise;
    if (!pending) return true;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return false;
    const completed = await deps.waitForPromiseBeforeTimeout(
      pending,
      remaining,
    );
    if (!completed) return false;
  }
};

export const withStorageWriteDeadline = async <T>(
  env: RuntimeReplica,
  operation: (markProgress: (step: string) => void) => Promise<T>,
): Promise<T> => {
  const timeoutMs = resolveStorageWriteTimeoutMs();
  const markRuntimeProgress = (step: string): void => {
    env.activeProcessProgressAt = Date.now();
    env.activeProcessProgressStep = `storage:${step}`;
  };
  if (timeoutMs <= 0) return await operation(markRuntimeProgress);

  return await new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let lastProgressAtMs = readStorageProgressClockMs();
    let lastProgressStep = 'start';

    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delayMs: number): void => {
      clearTimer();
      timer = setTimeout(() => {
        if (settled) return;
        let deadline: ReturnType<typeof evaluateStorageProgressDeadline>;
        try {
          deadline = evaluateStorageProgressDeadline(
            lastProgressAtMs,
            readStorageProgressClockMs(),
            timeoutMs,
          );
        } catch (error) {
          settled = true;
          reject(error);
          return;
        }
        if (!deadline.stalled) {
          schedule(deadline.remainingMs);
          return;
        }
        settled = true;
        reject(
          new RuntimeStorageWriteTimeoutError(
            timeoutMs,
            env.state.height,
            String(env.runtimeId || ''),
            lastProgressStep,
          ),
        );
      }, delayMs);
    };
    const markProgress = (step: string): void => {
      if (settled) return;
      markRuntimeProgress(step);
      lastProgressAtMs = readStorageProgressClockMs();
      lastProgressStep = step;
      schedule(timeoutMs);
    };

    schedule(timeoutMs);
    Promise.resolve()
      .then(() => operation(markProgress))
      .then(
        value => {
          if (settled) return;
          settled = true;
          clearTimer();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimer();
          reject(error);
        },
      );
  });
};
