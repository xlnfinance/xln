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

export async function enqueueRuntimeInput(page: Page, input: RuntimeTxEnqueueInput): Promise<void> {
  const result = await page.evaluate(async ({ input }) => {
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
  }, { input });

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
    const replicaCheck = await page.evaluate(({ entityId, signerId }) => {
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
    }, { entityId, signerId });

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
