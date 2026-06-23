import { expect, test, type Page } from './global-setup';
import { Wallet } from 'ethers';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline } from './utils/e2e-baseline';
import { createRuntimeIdentity, gotoApp } from './utils/e2e-demo-users';

const TEST_TIMEOUT_MS = process.env.E2E_LONG === '1' ? 180_000 : 120_000;

function randomMnemonic(): string {
  const mnemonic = Wallet.createRandom().mnemonic?.phrase;
  if (!mnemonic) throw new Error('failed to generate mnemonic');
  return mnemonic;
}

function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enqueueBadEntityInput(
  page: Page,
  input: 'stale-signer' | 'missing-signer',
  identity: { entityId: string },
): Promise<void> {
  const result = await page.evaluate(async ({ input, entityId }) => {
    const view = window as typeof window & {
      isolatedEnv?: unknown;
    };
    const env = view.isolatedEnv;
    if (!env) return { ok: false, error: 'isolatedEnv missing' };
    const runtimeModule = await import(
      /* @vite-ignore */ new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href
    ) as {
      enqueueRuntimeInput?: (env: unknown, runtimeInput: unknown) => void;
      startRuntimeLoop?: (env: unknown) => void;
    };
    if (typeof runtimeModule.enqueueRuntimeInput !== 'function') {
      return { ok: false, error: 'enqueueRuntimeInput unavailable' };
    }
    const signerId = input === 'missing-signer'
      ? ' '
      : `0x${'ef'.repeat(20)}`;
    const targetEntityId = input === 'missing-signer'
      ? `0x${'ac'.repeat(32)}`
      : `0x${'ab'.repeat(32)}`;
    runtimeModule.enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId,
            tokenId: 1,
            creditAmount: 1n,
          },
        }],
      }],
    });
    runtimeModule.startRuntimeLoop?.(env);
    return { ok: true };
  }, { input, entityId: identity.entityId });

  expect(result.ok, result.error || `failed to enqueue ${input}`).toBe(true);
}

async function readRuntimeIngressDiagnostics(page: Page): Promise<{
  loopActive: boolean;
  halted: boolean;
  queuedEntityInputs: number;
  rejectReplicaEvents: number;
  quarantinedEvents: number;
  loopErrorEvents: number;
  loopHaltedEvents: number;
  quarantineRecords: number;
}> {
  return await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          loopActive?: boolean;
          halted?: boolean;
          quarantinedRuntimeInputs?: unknown[];
        };
        runtimeMempool?: {
          entityInputs?: unknown[];
        };
        frameLogs?: Array<{ message?: string }>;
      };
    }).isolatedEnv;
    const logs = Array.isArray(env?.frameLogs) ? env.frameLogs : [];
    const countMessage = (message: string) => logs.filter((entry) => String(entry?.message || '') === message).length;
    return {
      loopActive: Boolean(env?.runtimeState?.loopActive),
      halted: Boolean(env?.runtimeState?.halted),
      queuedEntityInputs: Array.isArray(env?.runtimeMempool?.entityInputs) ? env.runtimeMempool.entityInputs.length : 0,
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

async function readRelayDebugRuntimeIngress(page: Page, runtimeId: string, since: number): Promise<{
  rejectReplicaEvents: number;
  quarantinedEvents: number;
  loopErrorEvents: number;
  loopHaltedEvents: number;
  messages: string[];
}> {
  const response = await page.request.get(
    `${API_BASE_URL}/api/debug/events?last=1000&runtimeId=${encodeURIComponent(runtimeId)}&since=${since}`,
  );
  expect(response.ok(), 'debug events endpoint must be reachable').toBe(true);
  const body = await response.json() as {
    events?: Array<{
      event?: string;
      details?: {
        payload?: {
          message?: string;
        };
      };
    }>;
  };
  const messages = (Array.isArray(body.events) ? body.events : [])
    .filter((event) => event.event === 'debug_event')
    .map((event) => String(event.details?.payload?.message || ''))
    .filter(Boolean);
  const count = (message: string) => messages.filter((entry) => entry === message).length;
  return {
    rejectReplicaEvents: count('REJECT_ENTITY_INPUT_REPLICA_NOT_FOUND'),
    quarantinedEvents: count('RUNTIME_INPUT_QUARANTINED'),
    loopErrorEvents: count('RUNTIME_LOOP_ERROR'),
    loopHaltedEvents: count('RUNTIME_LOOP_HALTED'),
    messages,
  };
}

function runtimeIngressGuardSatisfied(snapshot: {
  rejectReplicaEvents: number;
  quarantinedEvents: number;
  quarantineRecords?: number;
  queuedEntityInputs?: number;
  halted?: boolean;
  loopErrorEvents: number;
  loopHaltedEvents: number;
}): boolean {
  const loopCountsAreBounded =
    (snapshot.halted !== false && snapshot.loopErrorEvents === 1 && snapshot.loopHaltedEvents === 1) ||
    (snapshot.halted !== true && snapshot.loopErrorEvents === 0 && snapshot.loopHaltedEvents === 0);
  return snapshot.rejectReplicaEvents === 1 &&
    snapshot.quarantinedEvents === 1 &&
    (snapshot.quarantineRecords === undefined || snapshot.quarantineRecords === 1) &&
    (snapshot.queuedEntityInputs === undefined || snapshot.queuedEntityInputs === 0) &&
    loopCountsAreBounded;
}

test.describe('runtime ingress debug loop guards', () => {
  test.setTimeout(TEST_TIMEOUT_MS);

  test('bad entity inputs produce one debug event and do not requeue into a runtime error loop', async ({ page }) => {
    await ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireHubMesh: false,
      requireMarketMaker: false,
      minHubCount: 0,
      timeoutMs: 60_000,
    });
    await gotoApp(page, { appBaseUrl: APP_BASE_URL, settleMs: 500 });

    const identity = await createRuntimeIdentity(page, randomLabel('ingress-guard'), randomMnemonic(), {
      requireOnline: true,
    });
    const since = Date.now() - 1_000;

    await enqueueBadEntityInput(page, 'stale-signer', identity);
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
      });

    const stableLocal = await readRuntimeIngressDiagnostics(page);
    await page.waitForTimeout(2_000);
    await expect(readRuntimeIngressDiagnostics(page)).resolves.toMatchObject(stableLocal);

    const relayDiagnostics = await readRelayDebugRuntimeIngress(page, identity.runtimeId, since);
    expect(relayDiagnostics.rejectReplicaEvents, 'relay must not duplicate reject events').toBeLessThanOrEqual(1);
    expect(relayDiagnostics.quarantinedEvents, 'relay must not duplicate quarantine events').toBeLessThanOrEqual(1);
    expect(relayDiagnostics.loopErrorEvents, 'relay must not duplicate loop error events').toBeLessThanOrEqual(1);
    expect(relayDiagnostics.loopHaltedEvents, 'relay must not duplicate loop halted events').toBeLessThanOrEqual(1);
    const relaySawRuntimeIngress =
      relayDiagnostics.rejectReplicaEvents > 0 ||
      relayDiagnostics.quarantinedEvents > 0 ||
      relayDiagnostics.loopErrorEvents > 0 ||
      relayDiagnostics.loopHaltedEvents > 0;
    if (relaySawRuntimeIngress) {
      expect(runtimeIngressGuardSatisfied(relayDiagnostics), 'relay diagnostics must be bounded when present').toBe(true);
    }
  });
});
