import { expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { requireAppBaseUrl } from './e2e-base-url';

export const APP_BASE_URL = requireAppBaseUrl();
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

const runtimeIdsByLabel = new Map<string, string>();

const normalizeMnemonic = (mnemonic: string): string => mnemonic.trim().split(/\s+/).join(' ');

const deriveRuntimeIdFromMnemonic = (mnemonic: string): string =>
  Wallet.fromPhrase(normalizeMnemonic(mnemonic)).address.toLowerCase();

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openRuntimeDropdown(page: Page): Promise<void> {
  const trigger = page.locator('.context-switcher .dropdown-trigger, .context-switcher .pill-trigger').first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  await expect(page.locator('.context-switcher .dropdown-menu').first()).toBeVisible({ timeout: 10_000 });
}

async function ensureRuntimeCreationView(page: Page, label: string): Promise<void> {
  const mnemonicTab = page.getByRole('button', { name: 'Mnemonic', exact: true });
  const quickLoginButton = page.getByRole('button', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') });

  if (await mnemonicTab.isVisible().catch(() => false) || await quickLoginButton.isVisible().catch(() => false)) {
    return;
  }

  const creationBackButton = page.getByRole('button', { name: /Back/i }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await mnemonicTab.isVisible().catch(() => false) || await quickLoginButton.isVisible().catch(() => false)) {
      return;
    }
    if (await creationBackButton.isVisible().catch(() => false)) {
      await creationBackButton.click();
      await page.waitForTimeout(200);
      continue;
    }
    break;
  }

  if (await mnemonicTab.isVisible().catch(() => false) || await quickLoginButton.isVisible().catch(() => false)) {
    return;
  }

  await openRuntimeDropdown(page);
  const addRuntimeItem = page.locator('.switcher-menu .add-runtime-btn').filter({ hasText: /Add Runtime/i }).first();
  await expect(addRuntimeItem).toBeVisible({ timeout: 10_000 });
  await addRuntimeItem.click();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await mnemonicTab.isVisible().catch(() => false) || await quickLoginButton.isVisible().catch(() => false)) {
      return;
    }
    if (await creationBackButton.isVisible().catch(() => false)) {
      await creationBackButton.click();
      await page.waitForTimeout(200);
    }
  }

  await expect
    .poll(
      async () =>
        await mnemonicTab.isVisible().catch(() => false) ||
        await quickLoginButton.isVisible().catch(() => false),
      { timeout: 15_000, intervals: [200, 400, 600] },
    )
    .toBe(true);
}

async function waitForRuntimeReady(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ targetRuntimeId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase()
      && Number(env?.eReplicas?.size || 0) > 0;
  }, { targetRuntimeId: runtimeId }, { timeout: 30_000 });
}

async function waitForActiveRuntimeId(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ targetRuntimeId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
      };
    }).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase();
  }, { targetRuntimeId: runtimeId }, { timeout: 15_000 });
}

async function waitForAnyRuntimeReady(page: Page): Promise<string> {
  return await page.waitForFunction(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.runtimeId || Number(env?.eReplicas?.size || 0) <= 0) return null;
    return String(env.runtimeId).toLowerCase();
  }, { timeout: 30_000 }).then(async (handle) => {
    const value = await handle.jsonValue();
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('runtimeId missing after runtime creation');
    }
    return value;
  });
}

async function waitForNextRuntimeReady(page: Page, previousRuntimeId: string | null): Promise<string> {
  return await page.waitForFunction(({ priorRuntimeId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    const runtimeId = String(env?.runtimeId || '').toLowerCase();
    if (!runtimeId || Number(env?.eReplicas?.size || 0) <= 0) return null;
    const previous = String(priorRuntimeId || '').toLowerCase();
    if (previous && runtimeId === previous) return null;
    return runtimeId;
  }, { priorRuntimeId: previousRuntimeId }, { timeout: 30_000 }).then(async (handle) => {
    const value = await handle.jsonValue();
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('next runtimeId missing after quick login');
    }
    return value;
  });
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const checkbox = page.getByRole('checkbox', {
    name: /I understand.*testnet software|I understand and accept the risks/i,
  }).first();
  if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    const checked = await checkbox.isChecked().catch(() => false);
    if (!checked) await checkbox.check();
    const startBtn = page.getByRole('button', { name: /Start( using xln)?|Continue/i }).first();
    if (await startBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await startBtn.click();
    }
  }
}

async function completeProfileOnboardingIfVisible(page: Page, label: string): Promise<void> {
  const profileHeading = page.getByRole('heading', { name: 'Public profile', exact: true });
  if (!await profileHeading.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  const displayNameInput = page.getByRole('textbox', { name: /Display name/i }).first();
  await expect(displayNameInput).toBeVisible({ timeout: 15_000 });
  const currentValue = (await displayNameInput.inputValue()).trim();
  if (currentValue.length === 0) {
    await displayNameInput.fill(label);
  }

  const finishButton = page.getByRole('button', { name: /Start( using xln)?/i }).first();
  await expect(finishButton).toBeVisible({ timeout: 15_000 });
  await expect(finishButton).toBeEnabled({ timeout: 15_000 });
  await finishButton.click();

  await expect(profileHeading).not.toBeVisible({ timeout: 20_000 });
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
  // Browser flows must stay same-origin in E2E and go through the preview /api proxy.
  // Directly injecting the raw shard API URL into the page makes browser-only paths
  // diverge from production and can bypass normal origin/proxy behavior.
  const apiBaseUrl = appBaseUrl;
  await page.addInitScript((configuredApiBaseUrl: string) => {
    try {
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = configuredApiBaseUrl;
      localStorage.setItem('xln-api-base-url', configuredApiBaseUrl);
    } catch {
      // no-op
    }
  }, apiBaseUrl);

  const waitForAppReady = async (): Promise<boolean> => {
    const unlock = page.locator('button:has-text("Unlock")');
    if (await unlock.isVisible({ timeout: 1500 }).catch(() => false)) {
      await page.locator('input').first().fill('mml');
      await unlock.click();
      await page.waitForURL('**/app', { timeout: 10_000 });
    }
    try {
      await page.waitForFunction(() => {
        const loadingVisible = Boolean(document.querySelector('.loading-screen'));
        const errorVisible = Boolean(document.querySelector('.error-screen'));
        const viewVisible = Boolean(document.querySelector('.view-wrapper'));
        return !loadingVisible &&
          !errorVisible &&
          viewVisible;
      }, { timeout: initTimeoutMs });
      return true;
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`${appBaseUrl}/app`, { waitUntil: 'domcontentloaded' });
    if (await waitForAppReady()) {
      if (settleMs > 0) await page.waitForTimeout(settleMs);
      return;
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  const appDiagnostics = await page.evaluate(() => ({
    href: window.location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 400),
    hasLoading: Boolean(document.querySelector('.loading-screen')),
    hasError: Boolean(document.querySelector('.error-screen')),
    hasView: Boolean(document.querySelector('.view-wrapper')),
  })).catch(() => null);
  throw new Error(`gotoApp failed to reach ready view: ${JSON.stringify(appDiagnostics)}`);
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
  const quickLoginLabel = label.toLowerCase();
  const isQuickLoginDemo =
    (quickLoginLabel === 'alice' || quickLoginLabel === 'bob' || quickLoginLabel === 'carol' || quickLoginLabel === 'dave')
    && normalizeMnemonic(mnemonic) === normalizeMnemonic(selectDemoMnemonic(quickLoginLabel as DemoUserName));
  let runtimeId = deriveRuntimeIdFromMnemonic(mnemonic);
  const previousRuntimeId = await getActiveEntity(page).then((entity) => entity?.runtimeId ?? null);

  await ensureRuntimeCreationView(page, label);

  if (isQuickLoginDemo) {
    const quickLoginButton = page.getByRole('button', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') });
    await expect(quickLoginButton).toBeVisible({ timeout: 15_000 });
    await quickLoginButton.click();
    runtimeId = await waitForNextRuntimeReady(page, previousRuntimeId);
  } else {
    const mnemonicTab = page.getByRole('button', { name: 'Mnemonic', exact: true });
    await expect(mnemonicTab).toBeVisible({ timeout: 15_000 });
    await mnemonicTab.click();
    const mnemonicInput = page.locator('#mnemonic');
    await expect(mnemonicInput).toBeVisible({ timeout: 15_000 });
    await mnemonicInput.fill(normalizeMnemonic(mnemonic));
    const openVaultButton = page.getByRole('button', { name: /Open (Wallet|Vault)/, exact: false });
    await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
    await openVaultButton.click();
    await waitForRuntimeReady(page, runtimeId);
  }
  runtimeIdsByLabel.set(label.toLowerCase(), runtimeId);
  await dismissOnboardingIfVisible(page);
  await completeProfileOnboardingIfVisible(page, label);
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
  const runtimeId = runtimeIdsByLabel.get(label.toLowerCase()) ?? '';
  expect(runtimeId, `switchToRuntime(${label}) requires a known runtimeId`).not.toBe('');
  await switchToRuntimeId(page, runtimeId);
}

export async function switchToRuntimeId(page: Page, runtimeId: string): Promise<void> {
  const normalizedRuntimeId = runtimeId.toLowerCase();
  const currentRuntimeId = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
      };
    }).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase();
  });
  if (currentRuntimeId === normalizedRuntimeId) {
    await waitForRuntimeReady(page, normalizedRuntimeId);
    await dismissOnboardingIfVisible(page);
    await completeProfileOnboardingIfVisible(page, `Runtime ${normalizedRuntimeId.slice(2, 6)}`);
    await ensureRuntimeOnline(page, `switch-id-${runtimeId.slice(0, 8)}`);
    return;
  }
  const targetRuntimeLabel = await page.evaluate((targetRuntimeId) => {
    const raw = window.localStorage.getItem('xln-vaults');
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      const runtimes = parsed?.runtimes;
      if (!runtimes || typeof runtimes !== 'object') return '';
      for (const [key, value] of Object.entries(runtimes as Record<string, { id?: string; label?: string }>)) {
        const runtime = value || {};
        if (String(key || '').toLowerCase() === targetRuntimeId || String(runtime.id || '').toLowerCase() === targetRuntimeId) {
          return String(runtime.label || '').trim();
        }
      }
    } catch {
      return '';
    }
    return '';
  }, normalizedRuntimeId);
  const shortAddress = `${normalizedRuntimeId.slice(0, 6)}...${normalizedRuntimeId.slice(-4)}`;
  const runtimeCardText = targetRuntimeLabel || shortAddress;
  let switched = false;
  for (let attempt = 0; attempt < 3 && !switched; attempt += 1) {
    await openRuntimeDropdown(page);
    const targetItem = page.locator('.switcher-menu .runtime-main').filter({ hasText: runtimeCardText }).first();
    await expect(targetItem, `runtime dropdown must contain ${runtimeCardText}`).toBeVisible({ timeout: 15_000 });
    await targetItem.scrollIntoViewIfNeeded();
    await targetItem.click();
    try {
      await waitForActiveRuntimeId(page, normalizedRuntimeId);
      switched = true;
    } catch {
      // Retry through the real UI instead of falling back to storage mutation.
    }
  }
  expect(switched, `runtime switcher must activate ${runtimeCardText}`).toBe(true);
  await waitForRuntimeReady(page, normalizedRuntimeId);
  await dismissOnboardingIfVisible(page);
  await completeProfileOnboardingIfVisible(page, `Runtime ${normalizedRuntimeId.slice(2, 6)}`);
  await ensureRuntimeOnline(page, `switch-id-${runtimeId.slice(0, 8)}`);
}
