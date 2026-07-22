import { expect, type Locator, type Page } from '@playwright/test';
import { getIndexedAccountPath, HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import { requireAppBaseUrl } from './e2e-base-url';
import {
  quiesceRuntimePage,
  resetRuntimePageQuiescence,
} from './e2e-runtime-shutdown.mts';

export const APP_BASE_URL = requireAppBaseUrl();
export const DEFAULT_INIT_TIMEOUT = 30_000;
const RUNTIME_READY_TIMEOUT = process.env.E2E_LONG === '1' ? 150_000 : 120_000;

export type DemoUserName = 'alice' | 'bob' | 'carol' | 'dave';

const DEMO_USER_NAMES = ['alice', 'bob', 'carol', 'dave'] as const;
const DEFAULT_ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const ANVIL_INFRASTRUCTURE_SIGNER_COUNT = 3;

export type DemoUserIdentity = {
  label: DemoUserName;
  mnemonic: string;
  entityId: string;
  signerId: string;
  runtimeId: string;
};

type CreateRuntimeOptions = {
  requireOnline?: boolean;
  requiresOnboarding?: boolean;
  workFactor?: number;
  fresh?: boolean;
  jurisdiction?: string;
};

const DEFAULT_DEMO_MNEMONICS: Record<DemoUserName, string> = {
  alice: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
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

const normalizeJurisdictionName = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const deriveSignerAddressFromMnemonic = (mnemonic: string, index = 0): string => {
  const normalized = normalizeMnemonic(mnemonic);
  const hdNode = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(normalized), getIndexedAccountPath(index));
  return hdNode.address.toLowerCase();
};

const deriveRuntimeIdFromMnemonic = (mnemonic: string): string =>
  deriveSignerAddressFromMnemonic(mnemonic, 0);

const resolveConfiguredDemoMnemonics = (): Record<DemoUserName, string> => {
  const configured = { ...DEFAULT_DEMO_MNEMONICS };
  for (const label of DEMO_USER_NAMES) {
    const override = process.env[DEMO_MNEMONIC_ENV[label]];
    if (typeof override === 'string' && override.trim().length > 0) {
      configured[label] = override.trim();
    }
  }
  return configured;
};

export function assertDemoSignerIdentities(mnemonics: Readonly<Record<DemoUserName, string>>): void {
  const infrastructureMnemonic = process.env.ANVIL_MNEMONIC?.trim() || DEFAULT_ANVIL_MNEMONIC;
  const reservedSigners = new Set(
    Array.from({ length: ANVIL_INFRASTRUCTURE_SIGNER_COUNT }, (_, index) =>
      deriveSignerAddressFromMnemonic(infrastructureMnemonic, index),
    ),
  );
  const ownerBySigner = new Map<string, DemoUserName>();
  for (const label of DEMO_USER_NAMES) {
    const signer = deriveSignerAddressFromMnemonic(mnemonics[label]);
    if (reservedSigners.has(signer)) {
      throw new Error(`DEMO_SIGNER_RESERVED:${label}:${signer}`);
    }
    const owner = ownerBySigner.get(signer);
    if (owner) throw new Error(`DEMO_SIGNER_DUPLICATE:${owner}:${label}:${signer}`);
    ownerBySigner.set(signer, label);
  }
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function selectBrainvaultWorkFactor(page: Page, factor = 1): Promise<void> {
  let factorButton = page.getByRole('button', { name: new RegExp(`^${factor}\\s+`, 'i') }).first();
  if (!await factorButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    // Factor presets are collapsed under the "Advanced" (Security work factor) toggle now.
    const advancedToggle = page.getByRole('button', { name: /Security work factor/i }).first();
    if (await advancedToggle.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await advancedToggle.click();
      factorButton = page.getByRole('button', { name: new RegExp(`^${factor}\\s+`, 'i') }).first();
    }
  }
  if (!await factorButton.isVisible({ timeout: 1_000 }).catch(() => false)) return;
  await factorButton.click();
}

async function firstVisibleLocator(
  locators: Locator[],
  timeoutMs = 1_000,
): Promise<Locator | null> {
  for (const locator of locators) {
    if (await locator.isVisible({ timeout: timeoutMs }).catch(() => false)) return locator;
  }
  return null;
}

async function firstVisibleOnboardingButtonByText(
  page: Page,
  pattern: RegExp,
  timeoutMs = 1_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const buttons = page.locator('.onboarding button');
    const count = Math.min(await buttons.count().catch(() => 0), 40);
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible({ timeout: 100 }).catch(() => false)) continue;
      const label = String(await button.textContent({ timeout: 100 }).catch(() => '') || '').trim();
      if (!pattern.test(label)) continue;
      return button;
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return null;
}

async function acceptOnboardingTermsIfVisible(page: Page): Promise<void> {
  const checkboxes = page.locator('input[type="checkbox"]');
  const count = Math.min(await checkboxes.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!await checkbox.isVisible({ timeout: 100 }).catch(() => false)) continue;
    const label = String(await checkbox.evaluate((input) => input.closest('label')?.textContent || '').catch(() => ''));
    if (!/testnet software|accept the risks/i.test(label)) continue;
    if (!await checkbox.isChecked().catch(() => false)) {
      try {
        await checkbox.check({ force: true, timeout: 2_000 });
      } catch (error) {
        const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
        throw new Error(
          `PROFILE_ONBOARDING_TERMS_ACCEPT_FAILED:${JSON.stringify(diagnostics)}`,
          { cause: error },
        );
      }
    }
    return;
  }
}

async function collectProfileOnboardingSurfaceDiagnostics(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const visible = (element: Element): boolean => (element as HTMLElement).offsetParent !== null;
    const entityIds = Array.from(document.querySelectorAll('code'))
      .map((node) => String(node.textContent || '').trim())
      .filter((text) => /^0x[a-fA-F0-9]{64}$/.test(text));
    const env = (window as typeof window & { isolatedEnv?: Record<string, any> }).isolatedEnv;
    return {
      href: window.location.href,
      displayName: String((document.querySelector('#display-name') as HTMLInputElement | null)?.value || ''),
      hubJoinPreference: String((document.querySelector('#hub-join-select') as HTMLSelectElement | null)?.value || ''),
      entityIds,
      buttons: Array.from(document.querySelectorAll('button')).filter(visible).map((button) => ({
        label: String(button.textContent || '').trim(),
        disabled: (button as HTMLButtonElement).disabled,
      })),
      checkboxes: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter(visible).map((checkbox) => ({
        label: String(checkbox.closest('label')?.textContent || '').trim(),
        checked: checkbox.checked,
        disabled: checkbox.disabled,
      })),
      visibleErrors: Array.from(document.querySelectorAll<HTMLElement>('.error-msg, .toast.error .message, [role="alert"]'))
        .filter(visible)
        .map((element) => String(element.textContent || '').trim()),
      runtimeId: String(env?.runtimeId || ''),
      runtimeHeight: Number(env?.height || 0),
      replicaCount: Number(env?.eReplicas?.size || 0),
      bodyText: String(document.body?.innerText || '').slice(0, 1_200),
    };
  }).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
}

async function ensureVisibleInputValue(
  resolveLocator: () => Promise<Locator | null>,
  expectedValue: string,
): Promise<void> {
  const target = String(expectedValue || '');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const locator = await resolveLocator();
    if (!locator) break;
    const currentValue = await locator.inputValue().catch(() => '');
    if (currentValue === target) return;
    await locator.fill(target);
    await expect
      .poll(async () => {
        const current = await locator.inputValue().catch(() => '');
        return current;
      }, {
        timeout: 5_000,
        intervals: [150, 300, 500],
      })
      .toBe(target);
    await locator.page().waitForTimeout(250);
  }
}

async function openRuntimeDropdown(page: Page): Promise<void> {
  const trigger = page.locator('button:has([data-testid="context-current"]), .context-switcher .dropdown-trigger').first();
  const menu = page.locator('.dropdown-menu').first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  if (await menu.isVisible().catch(() => false)) {
    return;
  }
  await trigger.click({ force: true });
  await expect(menu).toBeVisible({ timeout: 10_000 });
}

async function selectContextEntityIfAvailable(
  page: Page,
  entityId: string,
): Promise<void> {
  const normalizedEntityId = String(entityId || '').trim().toLowerCase();
  if (!normalizedEntityId) return;

  const current = await getActiveEntity(page).catch(() => null);
  if (String(current?.entityId || '').trim().toLowerCase() === normalizedEntityId) return;

  await openRuntimeDropdown(page);
  const row = page
    .locator(`[data-testid="context-entity-row"][data-entity-id="${normalizedEntityId}"]`)
    .first();
  await expect(row, `context switcher must expose entity ${normalizedEntityId}`).toBeVisible({ timeout: 10_000 });
  await row.click({ force: true });
  await expect
    .poll(async () => {
      const active = await getActiveEntity(page).catch(() => null);
      return String(active?.entityId || '').trim().toLowerCase();
    }, {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: `context switcher must select entity ${normalizedEntityId}`,
    })
    .toBe(normalizedEntityId);
}

async function ensureRuntimeCreationView(page: Page, label: string): Promise<void> {
  const mnemonicTab = page.getByRole('button', { name: 'Mnemonic', exact: true });
  const quickLoginButton = page.getByRole('button', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') });
  const createWalletHeading = page.getByRole('heading', { name: /Create XLN wallet/i }).first();

  if (
    await mnemonicTab.isVisible().catch(() => false) ||
    await quickLoginButton.isVisible().catch(() => false) ||
    await createWalletHeading.isVisible().catch(() => false)
  ) {
    return;
  }

  const creationBackButton = page.getByRole('button', { name: /Back/i }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      await mnemonicTab.isVisible().catch(() => false) ||
      await quickLoginButton.isVisible().catch(() => false) ||
      await createWalletHeading.isVisible().catch(() => false)
    ) {
      return;
    }
    if (await creationBackButton.isVisible().catch(() => false)) {
      await creationBackButton.click();
      await page.waitForTimeout(200);
      continue;
    }
    break;
  }

  if (
    await mnemonicTab.isVisible().catch(() => false) ||
    await quickLoginButton.isVisible().catch(() => false) ||
    await createWalletHeading.isVisible().catch(() => false)
  ) {
    return;
  }

  await openRuntimeDropdown(page);
  const addRuntimeItem = page.locator('.switcher-menu .add-runtime-btn').filter({ hasText: /Add Runtime/i }).first();
  await expect(addRuntimeItem).toBeVisible({ timeout: 10_000 });
  await addRuntimeItem.click();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      await mnemonicTab.isVisible().catch(() => false) ||
      await quickLoginButton.isVisible().catch(() => false) ||
      await createWalletHeading.isVisible().catch(() => false)
    ) {
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
        await quickLoginButton.isVisible().catch(() => false) ||
        await createWalletHeading.isVisible().catch(() => false),
      { timeout: 15_000, intervals: [200, 400, 600] },
    )
    .toBe(true);
}

async function waitForRuntimeReady(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ targetRuntimeId }) => {
    const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
    const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').toLowerCase();
    const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '');
    const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '');
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env) {
      return selectedRuntimeId === String(targetRuntimeId || '').toLowerCase()
        && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
        && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId);
    }
    const envRuntimeId = String(env?.runtimeId || '').toLowerCase();
    const envReady = envRuntimeId === String(targetRuntimeId || '').toLowerCase()
      && Number(env?.eReplicas?.size || 0) > 0;
    if (!envReady) return false;

    // Runtime creation can surface the profile onboarding screen before the
    // context switcher finishes filling entity/signer metadata. The hydrated
    // env is the real readiness signal here; requiring the extra UI metadata
    // creates a false dependency and can deadlock E2E on the onboarding step.
    return !selectedRuntimeId || selectedRuntimeId === String(targetRuntimeId || '').toLowerCase();
  }, { targetRuntimeId: runtimeId }, { timeout: RUNTIME_READY_TIMEOUT });
}

async function waitForRuntimeBootstrap(
  page: Page,
  expectedRuntimeId: string,
  previousRuntimeId: string | null,
): Promise<string> {
  const expected = String(expectedRuntimeId || '').toLowerCase();
  const previous = String(previousRuntimeId || '').toLowerCase();

  await expect
    .poll(async () => {
      return await page.evaluate(({ expectedRuntimeId, previousRuntimeId }) => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            runtimeId?: string;
            eReplicas?: Map<string, unknown>;
          };
        }).isolatedEnv;
        const runtimeId = String(env?.runtimeId || '').toLowerCase();
        const replicaCount = Number(env?.eReplicas?.size || 0);

        const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
        const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').toLowerCase();
        const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '');
        const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '');
        const selectedReady =
          selectedRuntimeId
          && selectedRuntimeId === runtimeId
          && selectedRuntimeId !== String(previousRuntimeId || '').toLowerCase()
          && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
          && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId);
        if (runtimeId && replicaCount > 0 && selectedReady) {
          return runtimeId;
        }
        if (
          !runtimeId
          && selectedRuntimeId
          && selectedRuntimeId !== String(previousRuntimeId || '').toLowerCase()
          && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
          && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
        ) {
          return selectedRuntimeId;
        }

        const onboardingVisible =
          Boolean(document.querySelector('#display-name'))
          || Array.from(document.querySelectorAll('button')).some((button) => {
            const label = String(button.textContent || '').trim().toLowerCase();
            return label === 'start' || label === 'start using xln' || label === 'continue';
          });

        if (onboardingVisible) {
          return runtimeId || String(expectedRuntimeId || '').toLowerCase() || 'onboarding-visible';
        }
        return '';
      }, { expectedRuntimeId: expected, previousRuntimeId: previous }).catch(() => '');
    }, {
      timeout: RUNTIME_READY_TIMEOUT,
      intervals: [250, 500, 1000],
    })
    .not.toBe('');

  const activeRuntimeId = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
      };
    }).isolatedEnv;
    const envRuntimeId = String(env?.runtimeId || '').toLowerCase();
    if (envRuntimeId) return envRuntimeId;
    const selectedRuntimeId = document.querySelector<HTMLElement>('[data-testid="context-current"]')?.dataset?.runtimeId;
    return String(selectedRuntimeId || '').toLowerCase();
  }).catch(() => '');

  return activeRuntimeId || expected;
}

async function waitForActiveRuntimeId(page: Page, runtimeId: string): Promise<void> {
  await page.waitForFunction(({ targetRuntimeId }) => {
    const selectedRuntimeId = document.querySelector<HTMLElement>('[data-testid="context-current"]')?.dataset?.runtimeId;
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    const envRuntimeId = String(env?.runtimeId || '').toLowerCase();
    if (envRuntimeId) {
      return envRuntimeId === String(targetRuntimeId || '').toLowerCase()
        && Number(env?.eReplicas?.size || 0) > 0
        && (!selectedRuntimeId || String(selectedRuntimeId || '').toLowerCase() === envRuntimeId);
    }
    return String(selectedRuntimeId || '').toLowerCase() === String(targetRuntimeId || '').toLowerCase();
  }, { targetRuntimeId: runtimeId }, { timeout: 15_000 });
}

async function waitForAnyRuntimeReady(page: Page): Promise<string> {
  return await page.waitForFunction(() => {
    const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
    const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').toLowerCase();
    const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '');
    const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '');
    if (
      selectedRuntimeId
      && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
      && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
    ) {
      return selectedRuntimeId;
    }

    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.runtimeId || Number(env?.eReplicas?.size || 0) <= 0) return null;
    return String(env.runtimeId).toLowerCase();
  }, { timeout: RUNTIME_READY_TIMEOUT }).then(async (handle) => {
    const value = await handle.jsonValue();
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('runtimeId missing after runtime creation');
    }
    return value;
  });
}

async function waitForNextRuntimeReady(page: Page, previousRuntimeId: string | null): Promise<string> {
  try {
    return await page.waitForFunction(({ priorRuntimeId }) => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, unknown>;
        };
      }).isolatedEnv;
      const runtimeId = String(env?.runtimeId || '').toLowerCase();
      const previous = String(priorRuntimeId || '').toLowerCase();

      const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
      const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').toLowerCase();
      const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '');
      const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '');
      if (
        runtimeId
        && selectedRuntimeId === runtimeId
        && selectedRuntimeId !== previous
        && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
        && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
        && Number(env?.eReplicas?.size || 0) > 0
      ) {
        return runtimeId;
      }
      if (
        !runtimeId
        && selectedRuntimeId
        && selectedRuntimeId !== previous
        && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
        && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
      ) {
        return selectedRuntimeId;
      }
      if (!runtimeId || Number(env?.eReplicas?.size || 0) <= 0) return null;
      if (previous && runtimeId === previous) return null;
      return runtimeId;
    }, { priorRuntimeId: previousRuntimeId }, { timeout: RUNTIME_READY_TIMEOUT }).then(async (handle) => {
      const value = await handle.jsonValue();
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('next runtimeId missing after quick login');
      }
      return value;
    });
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, unknown>;
          jReplicas?: Map<string, unknown>;
          height?: number;
        };
      }).isolatedEnv;
      const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
      const runtimeCreationVisible =
        Boolean(document.querySelector('#runtime-creation'))
        || Boolean(document.querySelector('.quick-login-grid'));
      const matrixErrorText = String(document.querySelector<HTMLElement>('.matrix-status.error')?.innerText || '').trim();
      const primaryAction = document.querySelector<HTMLButtonElement>('button.derive-btn');
      const runtimeErrorText = Array.from(document.querySelectorAll('*'))
        .map((node) => String((node as HTMLElement).innerText || '').trim())
        .find((text) => /failed to create xln wallet|tower restore|strict restore|runtime id collision|invalid runtime/i.test(text))
        || '';
      const localStorageSummary = (() => {
        try {
          const raw = window.localStorage.getItem('xln-vaults');
          if (!raw) return null;
          const parsed = JSON.parse(raw) as {
            activeRuntimeId?: string | null;
            runtimes?: Record<string, { id?: string; signers?: Array<{ entityId?: string; address?: string }> }>;
          };
          return {
            activeRuntimeId: String(parsed?.activeRuntimeId || ''),
            runtimeKeys: Object.keys(parsed?.runtimes || {}),
            signerEntityIds: Object.values(parsed?.runtimes || {}).flatMap((runtime) =>
              Array.isArray(runtime?.signers) ? runtime.signers.map((signer) => String(signer?.entityId || '')) : [],
            ),
          };
        } catch (storageError) {
          return { error: String(storageError) };
        }
      })();
      return {
        href: window.location.href,
        runtimeCreationVisible,
        matrixErrorText,
        runtimeErrorText,
        primaryActionText: String(primaryAction?.innerText || '').trim(),
        primaryActionDisabled: Boolean(primaryAction?.disabled),
        nameValue: String(
          ((document.querySelector('#display-name') as HTMLInputElement | null)?.value
            || (document.querySelector('#name') as HTMLInputElement | null)?.value
            || ''),
        ),
        passphraseLength: String((document.querySelector('#passphrase') as HTMLInputElement | null)?.value || '').length,
        bodyText: String(document.body?.innerText || '').slice(0, 500),
        selectedRuntimeId: String(selectedTrigger?.dataset?.runtimeId || ''),
        selectedEntityId: String(selectedTrigger?.dataset?.entityId || ''),
        selectedSignerId: String(selectedTrigger?.dataset?.signerId || ''),
        envRuntimeId: String(env?.runtimeId || ''),
        envHeight: Number(env?.height || 0),
        envReplicaCount: Number(env?.eReplicas?.size || 0),
        envJurisdictionCount: Number(env?.jReplicas?.size || 0),
        envReplicaKeys: env?.eReplicas ? Array.from(env.eReplicas.keys()).slice(0, 8) : [],
        localStorageSummary,
      };
    }).catch((diagnosticError) => ({ evaluationError: String(diagnosticError) }));
    throw new Error(
      `waitForNextRuntimeReady timeout: ${error instanceof Error ? error.message : String(error)} :: ${JSON.stringify(diagnostics)}`,
    );
  }
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const onboardingVisible = await page.evaluate(() => {
    const onboarding = document.querySelector<HTMLElement>('.onboarding');
    return Boolean(onboarding && onboarding.offsetParent !== null);
  });
  if (onboardingVisible) {
    const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
    throw new Error(`PROFILE_ONBOARDING_UNSUPPORTED_VISIBLE:${JSON.stringify(diagnostics)}`);
  }
}

async function waitForReadyAfterCreate(
  page: Page,
  previousRuntimeId: string | null,
  options: { onboardingAssist?: boolean; onboardingLabel?: string } = {},
): Promise<string> {
  if (!options.onboardingAssist) {
    return await waitForNextRuntimeReady(page, previousRuntimeId);
  }

  const deadline = Date.now() + RUNTIME_READY_TIMEOUT;
  while (Date.now() < deadline) {
    await completeProfileOnboardingIfVisible(page, options.onboardingLabel || 'XLN runtime');
    await dismissOnboardingIfVisible(page);
    try {
      const runtimeId = await page.evaluate(({ priorRuntimeId }) => {
        const env = (window as typeof window & {
          isolatedEnv?: {
            runtimeId?: string;
            eReplicas?: Map<string, unknown>;
          };
        }).isolatedEnv;
        const runtimeId = String(env?.runtimeId || '').toLowerCase();
        const previous = String(priorRuntimeId || '').toLowerCase();

        const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
        const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').toLowerCase();
        const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '');
        const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '');
        if (
          runtimeId
          && selectedRuntimeId === runtimeId
          && selectedRuntimeId !== previous
          && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
          && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
          && Number(env?.eReplicas?.size || 0) > 0
        ) {
          return runtimeId;
        }
        if (
          !runtimeId
          && selectedRuntimeId
          && selectedRuntimeId !== previous
          && /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
          && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
        ) {
          return selectedRuntimeId;
        }
        if (!runtimeId || Number(env?.eReplicas?.size || 0) <= 0) return null;
        if (previous && runtimeId === previous) return null;
        return runtimeId;
      }, { priorRuntimeId: previousRuntimeId }).catch(() => null);
      if (typeof runtimeId === 'string' && runtimeId.length > 0) {
        return runtimeId;
      }
      await page.waitForTimeout(400);
    } catch {
      if (page.isClosed()) throw new Error('waitForReadyAfterCreate aborted because page is closed');
      await page.waitForTimeout(400);
    }
  }
  return await waitForNextRuntimeReady(page, previousRuntimeId);
}

async function completeProfileOnboardingIfVisible(page: Page, label: string): Promise<void> {
  const displayNameInputs = [
    page.locator('#display-name').first(),
    page.getByRole('textbox', { name: /Display name/i }).first(),
  ];
  const visibleDisplayNameInput = async (timeoutMs = 0): Promise<Locator | null> => {
    for (const input of displayNameInputs) {
      if (await input.isVisible({ timeout: timeoutMs }).catch(() => false)) return input;
    }
    return null;
  };
  const finishButtonVisible = async (): Promise<boolean> =>
    (await firstVisibleOnboardingButtonByText(page, /^(Start|Starting\.\.\.|Start using XLN|Continue)$/i, 200)) !== null;
  const onboardingGoneOrReady = async (): Promise<boolean> =>
    (await visibleDisplayNameInput() === null) && !await finishButtonVisible();

  const onboardingVisible =
    await visibleDisplayNameInput(1000) !== null
    || await finishButtonVisible();
  if (!onboardingVisible) {
    return;
  }

  const displayNameInput = await visibleDisplayNameInput(15_000);
  if (displayNameInput && (await displayNameInput.inputValue().catch(() => '')).trim().length === 0) {
    try {
      await displayNameInput.fill(label, { timeout: 5_000 });
    } catch (error) {
      const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
      throw new Error(
        `PROFILE_ONBOARDING_DISPLAY_NAME_FAILED:${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
  }

  await acceptOnboardingTermsIfVisible(page);
  const startButton = await firstVisibleOnboardingButtonByText(page, /^(Start|Start using XLN|Continue)$/i, 1_000);
  if (!startButton) {
    const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
    throw new Error(`PROFILE_ONBOARDING_START_MISSING:${JSON.stringify(diagnostics)}`);
  }
  try {
    await expect(startButton).toBeEnabled({ timeout: 15_000 });
  } catch (error) {
    const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
    throw new Error(
      `PROFILE_ONBOARDING_START_DISABLED:${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  try {
    await startButton.click({ force: true, timeout: 2_000 });
  } catch (error) {
    const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
    throw new Error(
      `PROFILE_ONBOARDING_SUBMIT_FAILED:${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }

  try {
    await expect
      .poll(async () => {
        return await onboardingGoneOrReady();
      }, {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const env = (window as typeof window & { isolatedEnv?: Record<string, any> }).isolatedEnv;
      const inputSummary = (input: any) => ({
          runtimeTxs: (input?.runtimeTxs ?? []).map((tx: any) => String(tx?.type ?? '')),
          jInputs: (input?.jInputs ?? []).map((entry: any) => ({
            jurisdictionName: String(entry?.jurisdictionName ?? ''),
            txs: (entry?.jTxs ?? []).map((tx: any) => String(tx?.type ?? '')),
          })),
          entityInputs: (input?.entityInputs ?? []).map((entry: any) => ({
            entityId: String(entry?.entityId ?? ''),
            signerId: String(entry?.signerId ?? ''),
            txs: (entry?.entityTxs ?? []).map((tx: any) => String(tx?.type ?? '')),
            proposal: Number(entry?.proposedFrame?.height ?? 0),
            precommits: entry?.hashPrecommits instanceof Map ? entry.hashPrecommits.size : 0,
            jPrefix: entry?.jPrefixAttestations instanceof Map ? entry.jPrefixAttestations.size : 0,
          })),
        });
      return {
          visibleErrors: [...document.querySelectorAll<HTMLElement>('.error-msg, .toast.error .message')]
            .filter((element) => element.offsetParent !== null)
            .map((element) => String(element.textContent ?? '').trim()),
          runtimeId: String(env?.runtimeId ?? ''),
          height: Number(env?.height ?? 0),
          runtimeMempool: inputSummary(env?.runtimeMempool),
          pendingOutputs: (env?.pendingOutputs ?? []).map(inputSummary),
          networkInbox: (env?.networkInbox ?? []).map(inputSummary),
          pendingNetworkOutputs: (env?.pendingNetworkOutputs ?? []).map((entry: any) => ({
            attempts: Number(entry?.attempts ?? 0),
            nextAttemptAt: Number(entry?.nextAttemptAt ?? 0),
            output: inputSummary({ entityInputs: [entry?.output ?? entry] }),
          })),
          reliable: {
            ingressPending: env?.runtimeState?.pendingReliableIngress?.size ?? 0,
            ingressActive: env?.runtimeState?.reliableIngressReceiptLedger?.size ?? 0,
            ingressTerminal: env?.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0,
            senderActive: env?.runtimeState?.receivedReliableReceiptLedger?.size ?? 0,
            senderTerminal: env?.runtimeState?.receivedReliableTerminalWatermarks?.size ?? 0,
          },
          replicas: Array.from(env?.eReplicas?.entries?.() ?? []).map(([key, replica]: [string, any]) => ({
            key,
            height: Number(replica?.state?.height ?? 0),
            mempool: (replica?.mempool ?? []).map((tx: any) => String(tx?.type ?? '')),
            proposal: Number(replica?.proposal?.height ?? 0),
            locked: Number(replica?.lockedFrame?.height ?? 0),
            jPrefixTarget: Number(replica?.jPrefixRound?.targetEntityHeight ?? 0),
            accounts: Array.from(replica?.state?.accounts?.entries?.() ?? []).map(
              ([counterpartyId, account]: [string, any]) => ({
                counterpartyId,
                height: Number(account?.currentHeight ?? 0),
                mempool: (account?.mempool ?? []).map((tx: any) => String(tx?.type ?? '')),
                pendingFrame: Number(account?.pendingFrame?.height ?? 0),
              }),
            ),
          })),
      };
    }).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(
      `PROFILE_ONBOARDING_COMPLETION_TIMEOUT:${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }

  const visibleErrors = await page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>('.error-msg, .toast.error .message, [role="alert"]'))
      .filter((element) => element.offsetParent !== null)
      .map((element) => String(element.textContent || '').trim())
      .filter(Boolean);
  });
  if (visibleErrors.length > 0) {
    const diagnostics = await collectProfileOnboardingSurfaceDiagnostics(page);
    throw new Error(`PROFILE_ONBOARDING_SUBMIT_FAILED:${JSON.stringify(diagnostics)}`);
  }
}

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  await expect
    .poll(async () => {
      if (page.isClosed()) return false;
      return await page.evaluate(() => {
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
        if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
        const start = typeof p2p.connect === 'function' ? p2p.connect : p2p.reconnect;
        if (typeof start === 'function') {
          setTimeout(() => {
            try { start.call(p2p); } catch {}
          }, 0);
        }
        return false;
      }).catch(() => false);
    }, {
      timeout: 20_000,
      intervals: [250, 500, 1000],
      message: `[${tag}] runtime must be online`,
    })
    .toBe(true);
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
  const navigationTimeoutMs = Math.max(15_000, initTimeoutMs);
  // Browser flows must stay same-origin in E2E and go through the preview /api proxy.
  // Directly injecting the raw shard API URL into the page makes browser-only paths
  // diverge from production and can bypass normal origin/proxy behavior.
  const apiBaseUrl = appBaseUrl;
  await page.addInitScript((configuredApiBaseUrl: string) => {
    try {
      const target = window as typeof window & {
        __XLN_API_BASE_URL__?: string;
        __xln?: Record<string, unknown>;
        isolatedEnv?: unknown;
      };
      target.__XLN_API_BASE_URL__ = configuredApiBaseUrl;
      Object.defineProperty(target, 'isolatedEnv', {
        configurable: true,
        enumerable: false,
        get() {
          const debugRoot = target.__xln;
          return debugRoot?.liveRuntimeSnapshot || debugRoot?.env || null;
        },
        set(value: unknown) {
          Reflect.defineProperty(target, '__xlnLegacyIsolatedEnv', {
            configurable: true,
            enumerable: false,
            value,
            writable: true,
          });
        },
      });
      localStorage.setItem('xln-api-base-url', configuredApiBaseUrl);
    } catch {
      // no-op
    }
  }, apiBaseUrl);

  const waitForAppReady = async (): Promise<boolean> => {
    if (page.isClosed()) return false;
    const unlock = page.locator('button:has-text("Unlock")');
    if (await unlock.isVisible({ timeout: 1500 }).catch(() => false)) {
      await page.locator('input').first().fill('mml');
      await unlock.click();
      await page.waitForURL('**/app', { timeout: 10_000 });
    }
    try {
      await page.waitForFunction(() => {
        const isVisible = (selector: string): boolean => {
          const element = document.querySelector(selector) as HTMLElement | null;
          if (!element) return false;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const errorVisible = isVisible('.error-screen');
        const inactiveVisible = isVisible('[data-testid="inactive-tab-screen"]');
        const viewVisible =
          isVisible('.view-wrapper') ||
          isVisible('nav[aria-label="Account workspace"]') ||
          isVisible('[data-testid="app-runtime-ready"]');
        const runtimeCreationVisible =
          isVisible('#runtime-creation') ||
          isVisible('.brainvault-wrapper') ||
          isVisible('.quick-login-grid') ||
          Boolean(Array.from(document.querySelectorAll('button')).find((button) => {
            const label = (button.textContent || '').trim().toLowerCase();
            return label === 'alice' || label === 'bob' || label === 'carol' || label === 'dave';
          }));
        return !errorVisible &&
          !inactiveVisible &&
          (viewVisible || runtimeCreationVisible);
      }, { timeout: initTimeoutMs });
      return true;
    } catch {
      return false;
    }
  };

  const currentUrl = page.url();
  if (currentUrl.includes('/app') && await waitForAppReady()) {
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (page.isClosed()) {
      throw new Error('gotoApp aborted because page is already closed');
    }
    const attemptUrl = page.url();
    if (attemptUrl.includes('/app')) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    } else {
      await page.goto(`${appBaseUrl}/app`, { waitUntil: 'commit', timeout: navigationTimeoutMs });
    }
    if (await waitForAppReady()) {
      if (settleMs > 0) await page.waitForTimeout(settleMs);
      return;
    }
  }

  const appDiagnostics = await page.evaluate(() => ({
    href: window.location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 400),
    hasLoading: Boolean(document.querySelector('.loading-screen')),
    hasError: Boolean(document.querySelector('.error-screen')),
    hasView: Boolean(document.querySelector('.view-wrapper')),
    hasRuntimeCreation: Boolean(document.querySelector('#runtime-creation')),
  })).catch(() => null);
  throw new Error(`gotoApp failed to reach ready view: ${JSON.stringify(appDiagnostics)}`);
}

export function selectDemoMnemonic(label: DemoUserName): string {
  const configured = resolveConfiguredDemoMnemonics();
  if (process.env.E2E_RANDOM_MNEMONICS === '1') {
    configured[label] = Wallet.createRandom().mnemonic!.phrase;
  }
  assertDemoSignerIdentities(configured);
  return configured[label];
}

export async function createRuntime(
  page: Page,
  label: string,
  mnemonic: string,
  options: CreateRuntimeOptions = {},
): Promise<void> {
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  const quickLoginLabel = (['alice', 'bob', 'carol', 'dave'] as const)
    .find((demoLabel) => normalizedMnemonic === normalizeMnemonic(selectDemoMnemonic(demoLabel)));
  const isQuickLoginDemo = Boolean(quickLoginLabel);
  let runtimeId = deriveRuntimeIdFromMnemonic(mnemonic);
  const previousRuntimeId = options.fresh
    ? null
    : await getActiveEntity(page).then((entity) => entity?.runtimeId ?? null);
  const canCreateDirectly = await page.evaluate(() => {
    const view = window as typeof window & {
      __xln?: {
        vault?: {
          createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<unknown>;
          deleteRuntime?: (id: string) => Promise<unknown>;
        };
      };
    };
    const hostname = window.location.hostname;
    return Boolean(view.__xln?.vault?.createRuntime)
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
  }).catch(() => false);

  if (canCreateDirectly) {
    if (options.fresh) {
      await page.evaluate(async ({ targetRuntimeId }) => {
        const view = window as typeof window & {
        __xln?: {
          vault?: {
            deleteRuntime?: (id: string) => Promise<unknown>;
          };
        };
        };
        const operations = view.__xln?.vault;
        if (typeof operations?.deleteRuntime !== 'function') return;
        await operations.deleteRuntime(targetRuntimeId);
      }, { targetRuntimeId: runtimeId.toLowerCase() }).catch(() => {});
    }
    const loginType = isQuickLoginDemo ? 'demo' : 'manual';
    const requiresOnboarding = options.requiresOnboarding === true;
    const skipRecoveryRestore = options.fresh === true;
    await page.evaluate(async ({ runtimeLabel, seed, loginType, requiresOnboarding, skipRecoveryRestore }) => {
      const view = window as typeof window & {
        __xln?: {
          vault?: {
            createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<unknown>;
          };
        };
      };
      const operations = view.__xln?.vault;
      if (typeof operations?.createRuntime !== 'function') {
        throw new Error('__xln.vault.createRuntime unavailable');
      }
      await operations.createRuntime(runtimeLabel, seed, {
        loginType,
        requiresOnboarding,
        skipRecoveryRestore,
        ...(skipRecoveryRestore ? { recovery: { useDefaultTowers: false, towers: [] } } : {}),
      });
    }, { runtimeLabel: label, seed: mnemonic, loginType, requiresOnboarding, skipRecoveryRestore });
    await waitForRuntimeReady(page, runtimeId);
    runtimeIdsByLabel.set(label.toLowerCase(), runtimeId);
    if (requiresOnboarding) {
      await completeProfileOnboardingIfVisible(page, label);
      await waitForRuntimeReady(page, runtimeId);
    }
    if (options.requireOnline !== false) {
      await ensureRuntimeOnline(page, `create-${label}`);
    }
    return;
  }

  await ensureRuntimeCreationView(page, label);

  let usedQuickLogin = false;
  if (isQuickLoginDemo) {
    const quickLoginButton = page.getByRole('button', { name: new RegExp(`^${escapeRegex(quickLoginLabel!)}$`, 'i') });
    if (await quickLoginButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await quickLoginButton.click();
      runtimeId = await waitForNextRuntimeReady(page, previousRuntimeId);
      usedQuickLogin = true;
    }
  }
  if (!usedQuickLogin) {
    const mnemonicModeButton = page.getByRole('tab', { name: /^Mnemonic$/i }).first();
    if (await mnemonicModeButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await mnemonicModeButton.click();
    }

    const resolveDisplayNameInput = async () => await firstVisibleLocator([
      page.locator('#name').first(),
      page.getByRole('textbox', { name: /display name/i }).first(),
    ], 1_500);
    const displayNameInput = await resolveDisplayNameInput();
    if (displayNameInput) {
      const currentName = await displayNameInput.inputValue().catch(() => '');
      if (!currentName.trim()) {
        await displayNameInput.fill(label);
      }
    }

    const resolveMnemonicInput = async () => await firstVisibleLocator([
      page.locator('#mnemonic').first(),
      page.getByRole('textbox', { name: /mnemonic/i }).first(),
    ]);
    const mnemonicInput = await resolveMnemonicInput();
    const normalizedSecret = normalizeMnemonic(mnemonic);
    const usingMnemonicImport = Boolean(mnemonicInput);
    if (usingMnemonicImport) {
      await ensureVisibleInputValue(resolveMnemonicInput, normalizedSecret);
    } else {
      const resolvePassphraseInput = async () => await firstVisibleLocator([
        page.locator('#passphrase').first(),
        page.getByRole('textbox', { name: /password|secret/i }).first(),
      ], 15_000);
      const passphraseInput = await resolvePassphraseInput();
      if (!passphraseInput) {
        throw new Error('visible BrainVault passphrase input not found');
      }
      await expect(passphraseInput).toBeVisible({ timeout: 15_000 });
      await ensureVisibleInputValue(resolvePassphraseInput, normalizedSecret);
    }
    const stableDisplayNameInput = await resolveDisplayNameInput();
    if (stableDisplayNameInput && await stableDisplayNameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const currentName = await stableDisplayNameInput.inputValue().catch(() => '');
      if (!currentName.trim()) {
        await stableDisplayNameInput.fill(label);
      }
    }
    await ensureVisibleInputValue(resolveDisplayNameInput, label);
    await selectBrainvaultWorkFactor(page, options.workFactor ?? 1);
    const openVaultButton = await firstVisibleLocator([
      page.getByRole('button', { name: /(Create XLN wallet|Open \/ restore wallet|Open (Wallet|Vault))/, exact: false }).first(),
      page.locator('button.derive-btn').first(),
    ], 15_000);
    if (!openVaultButton) {
      throw new Error('visible create wallet button not found');
    }
    await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
    await openVaultButton.click({ force: true });
    await page.waitForTimeout(400);
    const visiblePassphraseAfterClick = await firstVisibleLocator([
      page.locator('#passphrase').first(),
      page.getByRole('textbox', { name: /password|secret/i }).first(),
    ], 250);
    const visibleMnemonicAfterClick = await firstVisibleLocator([
      page.locator('#mnemonic').first(),
      page.getByRole('textbox', { name: /mnemonic/i }).first(),
    ], 250);
    const createButtonStillEnabled = usingMnemonicImport
      ? false
      : await openVaultButton.isEnabled({ timeout: 500 }).catch(() => false);
    const stillInInitialInputState =
      createButtonStillEnabled
      && (
        (visiblePassphraseAfterClick && String(await visiblePassphraseAfterClick.inputValue().catch(() => '')).trim().length > 0)
        || (visibleMnemonicAfterClick && String(await visibleMnemonicAfterClick.inputValue().catch(() => '')).trim().length > 0)
      );
    if (stillInInitialInputState) {
      await openVaultButton.click({ force: true });
    }
    // BrainVault/manual creation can land on the profile onboarding screen before
    // the runtime is considered fully ready. Assist that screen while polling,
    // otherwise the test can wait forever for a ready signal gated behind Start.
    runtimeId = await waitForReadyAfterCreate(page, previousRuntimeId, {
      onboardingAssist: true,
      onboardingLabel: label,
    });
    await completeProfileOnboardingIfVisible(page, label);
    await waitForRuntimeReady(page, runtimeId);
  }
  runtimeIdsByLabel.set(label.toLowerCase(), runtimeId);
  await completeProfileOnboardingIfVisible(page, label);
  await dismissOnboardingIfVisible(page);
  if (options.requireOnline !== false) {
    await ensureRuntimeOnline(page, `create-${label}`);
  }
}

export async function createRuntimeIdentity(
  page: Page,
  label: string,
  mnemonic: string,
  options: CreateRuntimeOptions = {},
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  const expectedRuntimeId = deriveRuntimeIdFromMnemonic(mnemonic).toLowerCase();
  const expectedJurisdiction = normalizeJurisdictionName(options.jurisdiction);
  await createRuntime(page, label, mnemonic, options);
  const deadline = Date.now() + RUNTIME_READY_TIMEOUT;
  let entity: { entityId: string; signerId: string; runtimeId: string; jurisdiction?: string } | null = null;
  while (Date.now() < deadline) {
    const activeEntity = await getActiveEntity(page).catch(() => null);
    if (
      activeEntity &&
      String(activeEntity.runtimeId || '').toLowerCase() === expectedRuntimeId &&
      String(activeEntity.signerId || '').toLowerCase() === expectedRuntimeId &&
      (!expectedJurisdiction || normalizeJurisdictionName(activeEntity.jurisdiction) === expectedJurisdiction)
    ) {
      entity = activeEntity;
      break;
    }

    const fromEnv = await page.evaluate(({ runtimeId, jurisdiction }) => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, {
            entityId?: string;
            signerId?: string;
            position?: { jurisdiction?: string };
            state?: {
              entityId?: string;
              config?: {
                jurisdiction?: { name?: string };
              };
            };
          }>;
        };
      }).isolatedEnv;
      if (!env?.eReplicas) return null;
      const activeRuntimeId = String(env.runtimeId || '').toLowerCase();
      if (activeRuntimeId && activeRuntimeId !== String(runtimeId || '').toLowerCase()) return null;
      const expectedJurisdiction = String(jurisdiction || '').trim().toLowerCase();
      const candidates: Array<{ entityId: string; signerId: string; runtimeId: string; jurisdiction: string }> = [];
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const [entityId, signerId] = String(replicaKey).split(':');
        if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
        if (String(signerId).toLowerCase() !== String(runtimeId || '').toLowerCase()) continue;
        const replicaJurisdiction = String(
          replica?.state?.config?.jurisdiction?.name
          || replica?.position?.jurisdiction
          || '',
        ).trim();
        candidates.push({
          entityId,
          signerId,
          runtimeId: String(env.runtimeId || runtimeId || '').toLowerCase(),
          jurisdiction: replicaJurisdiction,
        });
      }
      if (expectedJurisdiction) {
        return candidates.find((candidate) =>
          String(candidate.jurisdiction || '').trim().toLowerCase() === expectedJurisdiction,
        ) || null;
      }
      return candidates[0] || null;
    }, { runtimeId: expectedRuntimeId, jurisdiction: expectedJurisdiction }).catch(() => null);
    entity = fromEnv;
    if (entity) break;
    await page.waitForTimeout(250);
  }
  if (!entity) {
    const diagnostics = await page.evaluate(() => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, {
            position?: { jurisdiction?: string };
            state?: {
              entityId?: string;
              config?: { jurisdiction?: { name?: string } };
            };
          }>;
        };
      }).isolatedEnv;
      return {
        envRuntimeId: String(env?.runtimeId || ''),
        replicaKeys: env?.eReplicas ? Array.from(env.eReplicas.entries()).map(([key, replica]) => ({
          key,
          entityId: String(replica?.state?.entityId || ''),
          jurisdiction: String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || ''),
        })) : [],
      };
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    throw new Error(
      `createRuntimeIdentity failed to resolve runtime=${expectedRuntimeId}` +
      `${expectedJurisdiction ? ` jurisdiction=${expectedJurisdiction}` : ''}: ${JSON.stringify(diagnostics)}`,
    );
  }
  if (expectedJurisdiction) {
    await selectContextEntityIfAvailable(page, entity.entityId);
  }
  return entity as { entityId: string; signerId: string; runtimeId: string };
}

export async function getActiveEntity(page: Page): Promise<{ entityId: string; signerId: string; runtimeId: string; jurisdiction?: string } | null> {
  return page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, {
          position?: { jurisdiction?: string };
          state?: {
            config?: { jurisdiction?: { name?: string } };
          };
        }>;
      };
    }).isolatedEnv;
    const runtimeId = String(env?.runtimeId || '').toLowerCase();
    if (runtimeId && env?.eReplicas) {
      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        const [entityId, signerId] = String(replicaKey).split(':');
        const normalizedSignerId = String(signerId || '').toLowerCase();
        if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
        if (normalizedSignerId !== runtimeId) continue;
        const jurisdiction = String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || '').trim();
        return {
          entityId,
          signerId,
          runtimeId: String(env.runtimeId || ''),
          jurisdiction,
        };
      }
    }

    const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
    const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '').trim();
    const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '').trim();
    const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').trim();
    const selectedJurisdiction = String(selectedTrigger?.dataset?.jurisdiction || '').trim();
    if (
      /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
      && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
      && (!runtimeId || selectedRuntimeId.toLowerCase() === runtimeId)
    ) {
      return {
        entityId: selectedEntityId,
        signerId: selectedSignerId,
        runtimeId: selectedRuntimeId,
        jurisdiction: selectedJurisdiction,
      };
    }

    if (!env?.eReplicas) return null;
    const validReplicas: Array<{ entityId: string; signerId: string; jurisdiction?: string }> = [];
    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      const normalizedSignerId = String(signerId || '').toLowerCase();
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      const jurisdiction = String(replica?.state?.config?.jurisdiction?.name || replica?.position?.jurisdiction || '').trim();
      validReplicas.push({ entityId, signerId, jurisdiction });
      if (runtimeId && normalizedSignerId === runtimeId) {
        return {
          entityId,
          signerId,
          runtimeId: String(env.runtimeId || ''),
          jurisdiction,
        };
      }
    }
    const firstReplica = validReplicas[0];
    if (firstReplica) return { ...firstReplica, runtimeId: String(env.runtimeId || '') };
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
    const selectedRuntimeId = document.querySelector<HTMLElement>('[data-testid="context-current"]')?.dataset?.runtimeId;
    if (selectedRuntimeId) return String(selectedRuntimeId).toLowerCase();
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
      };
    }).isolatedEnv;
    return String(env?.runtimeId || '').toLowerCase();
  });
  if (currentRuntimeId === normalizedRuntimeId) {
    await waitForRuntimeReady(page, normalizedRuntimeId);
    await completeProfileOnboardingIfVisible(page, `Runtime ${normalizedRuntimeId.slice(2, 6)}`);
    await dismissOnboardingIfVisible(page);
    await ensureRuntimeOnline(page, `switch-id-${runtimeId.slice(0, 8)}`);
    return;
  }
  await page.evaluate((targetRuntimeId) => {
    const raw = window.localStorage.getItem('xln-vaults');
    if (!raw) throw new Error('xln-vaults missing');
    try {
      const parsed = JSON.parse(raw);
      const runtimes = parsed?.runtimes;
      if (!runtimes || typeof runtimes !== 'object') throw new Error('xln-vaults.runtimes missing');
      for (const [key, value] of Object.entries(runtimes as Record<string, { id?: string; label?: string }>)) {
        const runtime = value || {};
        if (String(key || '').toLowerCase() === targetRuntimeId || String(runtime.id || '').toLowerCase() === targetRuntimeId) {
          parsed.activeRuntimeId = key;
          window.localStorage.setItem('xln-vaults', JSON.stringify(parsed));
          return;
        }
      }
    } catch {
      throw new Error(`runtime ${targetRuntimeId} missing from xln-vaults`);
    }
  }, normalizedRuntimeId);
  await quiesceRuntimePage(page);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } finally {
    resetRuntimePageQuiescence(page);
  }
  await waitForActiveRuntimeId(page, normalizedRuntimeId);
  await waitForRuntimeReady(page, normalizedRuntimeId);
  await completeProfileOnboardingIfVisible(page, `Runtime ${normalizedRuntimeId.slice(2, 6)}`);
  await dismissOnboardingIfVisible(page);
  await ensureRuntimeOnline(page, `switch-id-${runtimeId.slice(0, 8)}`);
}
