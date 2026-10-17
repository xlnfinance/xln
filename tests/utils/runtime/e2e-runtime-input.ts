import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { RuntimeReplica, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapterInspection } from '../../../ui/src/runtime/adapter';
import { decodeLocalRuntimeInput } from '../../../core/runtime/decode';

type RuntimeTxEnqueueInput = {
  runtimeTxs: unknown[];
  entityInputs: { entityId: string; signerId: string; entityTxs: unknown[] }[];
};
type EnqueueEntityTxOptions = { requireLocalReplica?: boolean };
type RuntimeWindow = Window & {
  __xln?: { env(): RuntimeReplica | null; adapter(): RuntimeAdapterInspection | null; xln(): Promise<XLNModule> };
};

/** Submit once through current owner admission, then observe the real Runtime drain. */
export async function enqueueRuntimeInput(page: Page, input: RuntimeTxEnqueueInput): Promise<void> {
  const validated = decodeLocalRuntimeInput(input, 'E2E_RUNTIME_INPUT');
  const storageKey = `xln:e2e:enqueue:${randomUUID()}`;
  await page.evaluate(
    async ({ input, storageKey }) => {
      const debug = (window as RuntimeWindow).__xln;
      const env = debug?.env();
      const adapter = debug?.adapter();
      if (!debug || !env || !adapter) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      if (sessionStorage.getItem(storageKey)) throw new Error('E2E_INPUT_ALREADY_SUBMITTED');
      // A lost browser context after send must never cause an automatic duplicate.
      sessionStorage.setItem(storageKey, 'started');
      const xln = await debug.xln();
      // The same owner-admission class targets the existing Runtime; no connect,
      // bootstrap, alternate queue or bypass of readiness/admission validation.
      const owner = new xln.EmbeddedRuntimeAdapter({
        getEnv: () => env,
        enqueueRuntimeInput: xln.enqueueRuntimeInput,
        validateRuntimeInputAdmission: xln.validateRuntimeInputAdmission,
        registerRuntimePublishedCallback: xln.registerRuntimePublishedCallback,
        submitCrossJurisdictionIntent: async (target, route) => {
          await xln.submitCrossJurisdictionIntent(target, route);
          return { delivered: true };
        },
      });
      await owner.send(input);
      sessionStorage.setItem(storageKey, 'accepted');
      const drained = await xln.waitForRuntimeWorkDrained(env, 10_000, 0);
      if (!drained) throw new Error('E2E_RUNTIME_INPUT_DRAIN_TIMEOUT');
      sessionStorage.setItem(storageKey, 'drained');
    },
    { input: validated, storageKey },
  );
}

export async function enqueueEntityTxs(
  page: Page,
  entityId: string,
  signerId: string,
  entityTxs: unknown[],
  options: EnqueueEntityTxOptions = {},
): Promise<void> {
  if (options.requireLocalReplica !== false) {
    const present = await page.evaluate(
      ({ entityId, signerId }) => {
        const env = (window as RuntimeWindow).__xln?.env();
        if (!env) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
        return env.state.eReplicas.has(`${entityId}:${signerId}`.toLowerCase());
      },
      { entityId, signerId },
    );
    expect(present, `local replica ${entityId}:${signerId} must exist before owner admission`).toBe(true);
  }
  await enqueueRuntimeInput(page, { runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs }] });
}
