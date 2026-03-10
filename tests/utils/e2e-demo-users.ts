import { expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';

export const APP_BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8080';
export const DEFAULT_INIT_TIMEOUT = 30_000;

export type DemoUserName = 'alice' | 'bob' | 'carol' | 'dave';

export type DemoUserIdentity = {
  label: DemoUserName;
  mnemonic: string;
  entityId: string;
  signerId: string;
  runtimeId: string;
};

const DEFAULT_DEMO_MNEMONICS: Record<DemoUserName, string> = {
  alice: 'test test test test test test test test test test test junk',
  bob: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  carol: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  dave: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
};

const DEMO_MNEMONIC_ENV: Record<DemoUserName, string> = {
  alice: 'E2E_ALICE_MNEMONIC',
  bob: 'E2E_BOB_MNEMONIC',
  carol: 'E2E_CAROL_MNEMONIC',
  dave: 'E2E_DAVE_MNEMONIC',
};

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const checkbox = page.locator('text=I understand and accept the risks of using this software').first();
  if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await checkbox.click();
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
    }
  }
}

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  const ok = await page.evaluate(async () => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            isConnected?: () => boolean;
            connect?: () => void;
            reconnect?: () => void;
          };
        };
      };
    }).isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    if (!env || !p2p) return false;

    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try { p2p.connect(); } catch {}
      } else if (typeof p2p.reconnect === 'function') {
        try { p2p.reconnect(); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return typeof p2p.isConnected === 'function' && p2p.isConnected();
  });

  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

export async function gotoApp(
  page: Page,
  options: {
    appBaseUrl?: string;
    initTimeoutMs?: number;
    settleMs?: number;
  } = {},
): Promise<void> {
  const appBaseUrl = options.appBaseUrl ?? APP_BASE_URL;
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT;
  const settleMs = options.settleMs ?? 500;
  const apiBaseUrl = process.env.E2E_API_BASE_URL ?? appBaseUrl;
  await page.addInitScript((configuredApiBaseUrl: string) => {
    try {
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = configuredApiBaseUrl;
      localStorage.setItem('xln-api-base-url', configuredApiBaseUrl);
    } catch {
      // no-op
    }
  }, apiBaseUrl);
  await page.goto(`${appBaseUrl}/app`);
  const unlock = page.locator('button:has-text("Unlock")');
  if (await unlock.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.locator('input').first().fill('mml');
    await unlock.click();
    await page.waitForURL('**/app', { timeout: 10_000 });
  }
  await page.waitForFunction(() => {
    const loadingVisible = Boolean(document.querySelector('.loading-screen'));
    const errorVisible = Boolean(document.querySelector('.error-screen'));
    const viewVisible = Boolean(document.querySelector('.view-wrapper'));
    return !loadingVisible &&
      !errorVisible &&
      viewVisible;
  }, { timeout: initTimeoutMs });
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

export function selectDemoMnemonic(label: DemoUserName): string {
  const envKey = DEMO_MNEMONIC_ENV[label];
  const override = process.env[envKey];
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  if (process.env.E2E_RANDOM_MNEMONICS === '1') {
    return Wallet.createRandom().mnemonic!.phrase;
  }
  return DEFAULT_DEMO_MNEMONICS[label];
}

export async function createRuntime(page: Page, label: string, mnemonic: string): Promise<void> {
  await page.waitForFunction(() => {
    const view = window as typeof window & {
      vaultOperations?: { createRuntime?: unknown };
    };
    return typeof view.vaultOperations?.createRuntime === 'function';
  }, { timeout: 30_000 });

  const result = await page.evaluate(
    async ({ label, mnemonic }) => {
      try {
        const vaultOperations = (window as any).vaultOperations;
        if (!vaultOperations?.createRuntime) {
          return { ok: false, error: 'window.vaultOperations.createRuntime missing' };
        }
        await vaultOperations.createRuntime(label, mnemonic, {
          loginType: 'demo',
          requiresOnboarding: false,
        });
        const env = (window as any).isolatedEnv;
        if (env && !env._debugId) env._debugId = `${label}-${Date.now()}`;
        return { ok: true, debugId: env?._debugId ?? null };
      } catch (error: any) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
    { label, mnemonic },
  );

  expect(result.ok, `createRuntime(${label}) failed: ${result.error ?? 'unknown'}`).toBe(true);
  await page.waitForFunction(() => {
    const env = (window as any).isolatedEnv;
    return !!env?.runtimeId && Number(env?.eReplicas?.size || 0) > 0;
  }, { timeout: 30_000 });
  await dismissOnboardingIfVisible(page);
  await ensureRuntimeOnline(page, `create-${label}`);
}

export async function createRuntimeIdentity(
  page: Page,
  label: string,
  mnemonic: string,
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  await createRuntime(page, label, mnemonic);
  const entity = await getActiveEntity(page);
  expect(entity, `${label} runtime must expose a local entity`).not.toBeNull();
  return entity!;
}

export async function getActiveEntity(page: Page): Promise<{ entityId: string; signerId: string; runtimeId: string } | null> {
  return page.evaluate(() => {
    const env = (window as any).isolatedEnv;
    if (!env?.eReplicas) return null;
    const runtimeId = String(env.runtimeId || '').toLowerCase();
    for (const replicaKey of env.eReplicas.keys()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      const normalizedSignerId = String(signerId || '').toLowerCase();
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (runtimeId && normalizedSignerId !== runtimeId) continue;
      if (entityId && signerId) {
        return { entityId, signerId, runtimeId: String(env.runtimeId || '') };
      }
    }
    return null;
  });
}

export async function createDemoUsers(
  page: Page,
  labels: readonly DemoUserName[],
): Promise<Record<DemoUserName, DemoUserIdentity | undefined>> {
  const result: Record<DemoUserName, DemoUserIdentity | undefined> = {
    alice: undefined,
    bob: undefined,
    carol: undefined,
    dave: undefined,
  };

  for (const label of labels) {
    const mnemonic = selectDemoMnemonic(label);
    await createRuntime(page, label, mnemonic);
    const entity = await getActiveEntity(page);
    expect(entity, `${label} runtime must expose a local entity`).not.toBeNull();
    result[label] = {
      label,
      mnemonic,
      entityId: entity!.entityId,
      signerId: entity!.signerId,
      runtimeId: entity!.runtimeId,
    };
  }

  return result;
}

export async function switchToRuntime(page: Page, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let result: { ok: boolean; id?: string; error?: string } = { ok: false, error: 'not-started' };

  while (Date.now() < deadline) {
    try {
      result = await page.evaluate(async (runtimeLabel) => {
        try {
          const runtimesState = (window as any).runtimesState;
          const vaultOperations = (window as any).vaultOperations;
          if (!runtimesState || !vaultOperations?.selectRuntime) {
            return { ok: false, error: 'window.runtimesState/window.vaultOperations.selectRuntime missing' };
          }

          let state: any;
          const unsubscribe = runtimesState.subscribe((value: any) => { state = value; });
          unsubscribe();

          for (const [id, runtime] of Object.entries(state.runtimes) as Array<[string, { label?: string }]>) {
            if (runtime.label?.toLowerCase() === runtimeLabel.toLowerCase()) {
              await vaultOperations.selectRuntime(id);
              return { ok: true, id };
            }
          }

          return {
            ok: false,
            error: `Runtime "${runtimeLabel}" not found`,
          };
        } catch (error: any) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }, label);
    } catch (error: any) {
      result = { ok: false, error: error?.message ?? String(error) };
    }

    if (result.ok) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  expect(result.ok, `switchToRuntime(${label}) failed: ${result.error ?? 'unknown'}`).toBe(true);
  await page.waitForFunction(({ runtimeId }) => {
    const env = (window as any).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase() === String(runtimeId || '').toLowerCase()
      && Number(env?.eReplicas?.size || 0) > 0;
  }, { runtimeId: result.id }, { timeout: 30_000 });
  await dismissOnboardingIfVisible(page);
  await ensureRuntimeOnline(page, `switch-${label}`);
}

export async function switchToRuntimeId(page: Page, runtimeId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let result: { ok: boolean; error?: string } = { ok: false, error: 'not-started' };

  while (Date.now() < deadline) {
    try {
      result = await page.evaluate(async (nextRuntimeId) => {
        try {
          const vaultOperations = (window as any).vaultOperations;
          if (!vaultOperations?.selectRuntime) {
            return { ok: false, error: 'window.vaultOperations.selectRuntime missing' };
          }
          await vaultOperations.selectRuntime(nextRuntimeId);
          return { ok: true };
        } catch (error: any) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }, runtimeId);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (!/Execution context was destroyed|Cannot find context|Target closed/i.test(message)) {
        throw error;
      }
      result = { ok: false, error: message };
    }

    if (result.ok) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  expect(result.ok, `switchToRuntimeId(${runtimeId.slice(0, 10)}) failed: ${result.error ?? 'unknown'}`).toBe(true);
  await page.waitForFunction(({ targetRuntimeId }) => {
    const env = (window as any).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase()
      && Number(env?.eReplicas?.size || 0) > 0;
  }, { targetRuntimeId: runtimeId }, { timeout: 30_000 });
  await dismissOnboardingIfVisible(page);
  await ensureRuntimeOnline(page, `switch-id-${runtimeId.slice(0, 8)}`);
}
