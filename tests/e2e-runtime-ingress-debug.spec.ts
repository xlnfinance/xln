import { allowBrowserIssue, expect, test, type Page } from './global-setup.mts';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline } from './utils/e2e-baseline';
import { gotoApp } from './utils/e2e-demo-users';

const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 180_000 : 120_000;

async function enqueueBadEntityInput(
  page: Page,
): Promise<void> {
  const result = await page.evaluate(async () => {
    const view = window as typeof window & {
      __e2eRuntimeIngressEnv?: unknown;
    };
    const runtimeModule = await import(
      /* @vite-ignore */ new URL('/runtime.js?e2e-runtime-ingress-debug', window.location.origin).href
    ) as {
      createEmptyEnv?: (seed: string) => unknown;
      enqueueRuntimeInput?: (env: unknown, runtimeInput: unknown) => void;
      startRuntimeLoop?: (env: unknown) => void;
    };
    if (
      typeof runtimeModule.createEmptyEnv !== 'function' ||
      typeof runtimeModule.enqueueRuntimeInput !== 'function' ||
      typeof runtimeModule.startRuntimeLoop !== 'function'
    ) {
      return { ok: false, error: 'runtime ingress surface unavailable' };
    }
    const env = runtimeModule.createEmptyEnv('e2e-runtime-ingress-debug');
    view.__e2eRuntimeIngressEnv = env;
    runtimeModule.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: `0x${'ab'.repeat(32)}`,
        signerId: `0x${'ef'.repeat(20)}`,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: `0x${'ac'.repeat(32)}`,
            tokenId: 1,
            creditAmount: 1n,
          },
        }],
      }],
    });
    runtimeModule.startRuntimeLoop(env);
    return { ok: true };
  });

  expect(result.ok, result.error || 'failed to enqueue stale-signer input').toBe(true);
}

async function readRuntimeIngressDiagnostics(page: Page): Promise<{
  loopActive: boolean;
  halted: boolean;
  queuedRejectedInputs: number;
  rejectReplicaEvents: number;
  quarantinedEvents: number;
  loopErrorEvents: number;
  loopHaltedEvents: number;
  quarantineRecords: number;
}> {
  return await page.evaluate(() => {
    const env = (window as typeof window & {
      __e2eRuntimeIngressEnv?: {
        runtimeState?: {
          loopActive?: boolean;
          halted?: boolean;
          quarantinedRuntimeInputs?: unknown[];
        };
        runtimeMempool?: {
          entityInputs?: Array<{ signerId?: string }>;
        };
        frameLogs?: Array<{ message?: string }>;
      };
    }).__e2eRuntimeIngressEnv;
    const logs = Array.isArray(env?.frameLogs) ? env.frameLogs : [];
    const countMessage = (message: string) => logs.filter((entry) => String(entry?.message || '') === message).length;
    return {
      loopActive: Boolean(env?.runtimeState?.loopActive),
      halted: Boolean(env?.runtimeState?.halted),
      queuedRejectedInputs: Array.isArray(env?.runtimeMempool?.entityInputs)
        ? env.runtimeMempool.entityInputs.filter((input) => String(input?.signerId || '').toLowerCase() === `0x${'ef'.repeat(20)}`).length
        : 0,
      rejectReplicaEvents: countMessage('REJECT_ENTITY_INPUT_REPLICA_NOT_FOUND'),
      quarantinedEvents: countMessage('RUNTIME_INPUT_QUARANTINED'),
      loopErrorEvents: countMessage('RUNTIME_LOOP_ERROR'),
      loopHaltedEvents: countMessage('RUNTIME_LOOP_HALTED'),
      quarantineRecords: Array.isArray(env?.runtimeState?.quarantinedRuntimeInputs)
        ? env.runtimeState.quarantinedRuntimeInputs.length
        : 0,
    };
  });
}

function runtimeIngressGuardSatisfied(snapshot: {
  rejectReplicaEvents: number;
  quarantinedEvents: number;
  quarantineRecords?: number;
  queuedRejectedInputs?: number;
  halted?: boolean;
  loopErrorEvents: number;
  loopHaltedEvents: number;
}): boolean {
  return snapshot.rejectReplicaEvents <= 1 &&
    snapshot.quarantinedEvents === 1 &&
    (snapshot.quarantineRecords === undefined || snapshot.quarantineRecords === 1) &&
    (snapshot.queuedRejectedInputs === undefined || snapshot.queuedRejectedInputs === 0) &&
    snapshot.halted !== true &&
    snapshot.loopErrorEvents === 0 &&
    snapshot.loopHaltedEvents === 0;
}

test.describe('runtime ingress debug loop guards', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('bad entity inputs are quarantined once while the runtime remains live', { tag: '@resilience' }, async ({ page }) => {
    for (const message of [
      /REJECT_ENTITY_INPUT_UNKNOWN_ENTITY/,
      /apply_input\.failed .*RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET/,
      /RUNTIME_INPUT_QUARANTINED .*RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET/,
      /input\.quarantined .*RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET/,
    ]) {
      allowBrowserIssue({ type: 'console', severity: 'error', message });
    }
    await ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireHubMesh: false,
      requireMarketMaker: false,
      minHubCount: 0,
      timeoutMs: 60_000,
    });
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, settleMs: 500 });

    await enqueueBadEntityInput(page);
    await expect
      .poll(async () => {
        const diagnostics = await readRuntimeIngressDiagnostics(page);
        return {
          ...diagnostics,
          guardSatisfied: runtimeIngressGuardSatisfied(diagnostics),
        };
      }, {
        timeout: 20_000,
        intervals: [100, 250, 500],
        message: 'stale signer input must be quarantined once without a runtime error loop',
      })
      .toMatchObject({
        guardSatisfied: true,
        loopActive: true,
        halted: false,
        queuedRejectedInputs: 0,
        quarantinedEvents: 1,
        loopErrorEvents: 0,
        loopHaltedEvents: 0,
        quarantineRecords: 1,
      });

    const stableLocal = await readRuntimeIngressDiagnostics(page);
    await page.waitForTimeout(2_000);
    await expect(readRuntimeIngressDiagnostics(page)).resolves.toMatchObject(stableLocal);

  });
});
