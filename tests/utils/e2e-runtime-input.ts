import { expect, type Page } from '@playwright/test';

type RuntimeEnv = {
  eReplicas: Map<string, unknown>;
};

type RuntimeModule = {
  enqueueRuntimeInput: (env: RuntimeEnv, input: RuntimeTxEnqueueInput) => void;
};

type EntityTxInput = {
  entityId: string;
  signerId: string;
  entityTxs: unknown[];
};

type RuntimeTxEnqueueInput = {
  runtimeTxs: unknown[];
  entityInputs: EntityTxInput[];
};

type EnqueueEntityTxOptions = {
  requireLocalReplica?: boolean;
};

const isTransientEvaluateError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context|Target page, context or browser has been closed|Navigation/i.test(message);
};

async function waitForRuntimeWindow(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  await page.waitForFunction(() => Boolean((window as typeof window & { isolatedEnv?: unknown }).isolatedEnv), undefined, {
    timeout: 10_000,
  }).catch(() => {});
}

async function evaluateWithRuntimeRetry<TResult, TArg>(
  page: Page,
  pageFunction: (arg: TArg) => TResult | Promise<TResult>,
  arg: TArg,
  label: string,
): Promise<TResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await waitForRuntimeWindow(page);
      return await page.evaluate(pageFunction, arg);
    } catch (error) {
      lastError = error;
      if (!isTransientEvaluateError(error) || attempt === 4) break;
      await page.waitForTimeout(250 * (attempt + 1)).catch(() => {});
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`${label} failed: ${String(lastError)}`);
}

export async function enqueueRuntimeInput(page: Page, input: RuntimeTxEnqueueInput): Promise<void> {
  const result = await evaluateWithRuntimeRetry(page, async ({ input }) => {
    const runtimeWindow = window as typeof window & {
      isolatedEnv?: RuntimeEnv;
    };
    const env = runtimeWindow.isolatedEnv;
    if (!env) return { ok: false, error: 'isolatedEnv missing' };

    const runtimeModule = await import(
      /* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href
    ) as RuntimeModule;
    runtimeModule.enqueueRuntimeInput(env, input);
    return { ok: true };
  }, { input }, 'enqueueRuntimeInput');

  expect(result.ok, result.error || 'enqueueRuntimeInput failed').toBe(true);
}

export async function enqueueEntityTxs(
  page: Page,
  entityId: string,
  signerId: string,
  entityTxs: unknown[],
  options: EnqueueEntityTxOptions = {},
): Promise<void> {
  if (options.requireLocalReplica !== false) {
    const replicaCheck = await evaluateWithRuntimeRetry(page, ({ entityId, signerId }) => {
      const runtimeWindow = window as typeof window & {
        isolatedEnv?: RuntimeEnv;
      };
      const env = runtimeWindow.isolatedEnv;
      if (!env) return { ok: false, error: 'isolatedEnv missing' };
      const expectedKey = `${entityId}:${signerId}`.toLowerCase();
      const replicaKeys = Array.from(env.eReplicas.keys(), (key) => String(key).toLowerCase());
      if (!replicaKeys.includes(expectedKey)) {
        return { ok: false, error: `local replica ${expectedKey} missing` };
      }
      return { ok: true };
    }, { entityId, signerId }, 'replica check');

    expect(replicaCheck.ok, replicaCheck.error || `replica check failed for ${entityId}`).toBe(true);
  }

  await enqueueRuntimeInput(page, {
    runtimeTxs: [],
    entityInputs: [{
      entityId,
      signerId,
      entityTxs,
    }],
  });
}
