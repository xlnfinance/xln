import { expect, type Locator, type Page } from '@playwright/test';
import { getIndexedAccountPath, HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import { requireAppBaseUrl } from './e2e-base-url';

export const APP_BASE_URL = requireAppBaseUrl();
export const DEFAULT_INIT_TIMEOUT = 30_000;
const RUNTIME_READY_TIMEOUT = process.env.E2E_LONG === '1' ? 150_000 : 120_000;

export type DemoUserName = 'alice' | 'bob' | 'carol' | 'dave';

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

const normalizeJurisdictionName = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const deriveSignerAddressFromMnemonic = (mnemonic: string, index = 0): string => {
  const normalized = normalizeMnemonic(mnemonic);
  const hdNode = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(normalized), getIndexedAccountPath(index));
  return hdNode.address.toLowerCase();
};

const deriveRuntimeIdFromMnemonic = (mnemonic: string): string =>
  deriveSignerAddressFromMnemonic(mnemonic, 0);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function selectBrainvaultWorkFactor(page: Page, factor = 1): Promise<void> {
  const factorButton = page.getByRole('button', { name: new RegExp(`^${factor}\\s+`, 'i') }).first();
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

async function firstVisibleButtonByText(
  page: Page,
  pattern: RegExp,
  timeoutMs = 1_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const buttons = page.locator('button');
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
      await checkbox.check({ force: true, timeout: 2_000 }).catch(() => null);
    }
    return;
  }
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
        nameValue: String((document.querySelector('#name') as HTMLInputElement | null)?.value || ''),
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
  const completed = await page.evaluate(() => {
    const hasOnboarding =
      Boolean(document.querySelector('#display-name')) ||
      Array.from(document.querySelectorAll('button')).some((button) =>
        /^(Start|Start using XLN|Continue)$/i.test(String(button.textContent || '').trim()),
      );
    if (!hasOnboarding) return false;
    // Profile onboarding owns real setup side effects such as initial hub joins.
    // Do not mark it complete through localStorage here; completeProfileOnboardingIfVisible()
    // must press Start so the app runs the same finish() path a user does.
    if (document.querySelector('#display-name')) return false;

    const entityIds = Array.from(document.querySelectorAll('code'))
      .map((node) => String(node.textContent || '').trim())
      .filter((text) => /^0x[a-fA-F0-9]{64}$/.test(text));
    if (entityIds.length === 0) return false;

    const displayName = String((document.querySelector('#display-name') as HTMLInputElement | null)?.value || '').trim();
    const hubJoinPreference = String((document.querySelector('#hub-join-select') as HTMLSelectElement | null)?.value || '').trim();
    for (const id of entityIds) {
      localStorage.setItem(`xln-onboarding-complete:${id.toLowerCase()}`, 'true');
    }
    if (displayName) localStorage.setItem('xln-display-name', displayName);
    if (hubJoinPreference) localStorage.setItem('xln-hub-join-preference', hubJoinPreference);
    return true;
  }).catch(() => false);

  if (completed) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
}

async function waitForReadyAfterCreate(
  page: Page,
  previousRuntimeId: string | null,
  options: { onboardingAssist?: boolean } = {},
): Promise<string> {
  if (!options.onboardingAssist) {
    return await waitForNextRuntimeReady(page, previousRuntimeId);
  }

  const deadline = Date.now() + RUNTIME_READY_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      await dismissOnboardingIfVisible(page);
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
    (await firstVisibleButtonByText(page, /^(Start|Starting\.\.\.|Start using XLN|Continue)$/i, 200)) !== null;
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
    await displayNameInput.fill(label, { timeout: 5_000 }).catch(() => null);
  }

  await acceptOnboardingTermsIfVisible(page);
  const startButton = await firstVisibleButtonByText(page, /^(Start|Start using XLN|Continue)$/i, 1_000);
  const submitted = Boolean(startButton && await startButton.isEnabled().catch(() => false));
  if (startButton && submitted) {
    await startButton.click({ force: true, timeout: 2_000 });
  }

  if (submitted) {
    await expect
      .poll(async () => {
        return await onboardingGoneOrReady();
      }, {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(true);
    return;
  }

  const fallbackState = await page.evaluate(() => {
    const entityIds = Array.from(document.querySelectorAll('code'))
      .map((node) => String(node.textContent || '').trim())
      .filter((text) => /^0x[a-fA-F0-9]{64}$/.test(text));
    const displayName = String((document.querySelector('#display-name') as HTMLInputElement | null)?.value || '').trim();
    const hubJoinPreference = String((document.querySelector('#hub-join-select') as HTMLSelectElement | null)?.value || '').trim();
    return { entityIds, displayName, hubJoinPreference };
  });
  if (fallbackState.entityIds.length > 0) {
    await page.evaluate(({ ids, displayName, hubJoinPreference }) => {
      for (const id of ids) {
        localStorage.setItem(`xln-onboarding-complete:${String(id).trim().toLowerCase()}`, 'true');
      }
      if (displayName) localStorage.setItem('xln-display-name', displayName);
      if (hubJoinPreference) localStorage.setItem('xln-hub-join-preference', hubJoinPreference);
    }, { ids: fallbackState.entityIds, displayName: fallbackState.displayName, hubJoinPreference: fallbackState.hubJoinPreference });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  await expect
    .poll(async () => {
      return await onboardingGoneOrReady();
    }, {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);
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
      (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__ = configuredApiBaseUrl;
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
      __xlnVaultOperations?: {
        createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<unknown>;
        deleteRuntime?: (id: string) => Promise<unknown>;
      };
    };
    const hostname = window.location.hostname;
    return Boolean(view.__xlnVaultOperations?.createRuntime)
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
  }).catch(() => false);

  if (canCreateDirectly) {
    if (options.fresh) {
      await page.evaluate(async ({ targetRuntimeId }) => {
        const view = window as typeof window & {
          __xlnVaultOperations?: {
            deleteRuntime?: (id: string) => Promise<unknown>;
          };
        };
        if (typeof view.__xlnVaultOperations?.deleteRuntime !== 'function') return;
        await view.__xlnVaultOperations.deleteRuntime(targetRuntimeId);
      }, { targetRuntimeId: runtimeId.toLowerCase() }).catch(() => {});
    }
    const loginType = isQuickLoginDemo ? 'demo' : 'manual';
    const requiresOnboarding = options.requiresOnboarding === true;
    const skipRecoveryRestore = options.fresh === true;
    await page.evaluate(async ({ runtimeLabel, seed, loginType, requiresOnboarding, skipRecoveryRestore }) => {
      const view = window as typeof window & {
        __xlnVaultOperations?: {
          createRuntime?: (name: string, seed: string, options?: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const operations = view.__xlnVaultOperations;
      if (typeof operations?.createRuntime !== 'function') {
        throw new Error('__xlnVaultOperations.createRuntime unavailable');
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

  if (isQuickLoginDemo) {
    const quickLoginButton = page.getByRole('button', { name: new RegExp(`^${escapeRegex(quickLoginLabel!)}$`, 'i') });
    await expect(quickLoginButton).toBeVisible({ timeout: 15_000 });
    await quickLoginButton.click();
    runtimeId = await waitForNextRuntimeReady(page, previousRuntimeId);
  } else {
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
      page.getByRole('button', { name: /(Create XLN wallet|Open (Wallet|Vault))/, exact: false }).first(),
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
    runtimeId = await waitForReadyAfterCreate(page, previousRuntimeId, { onboardingAssist: true });
    await completeProfileOnboardingIfVisible(page, label);
    await waitForRuntimeReady(page, runtimeId);
  }
  runtimeIdsByLabel.set(label.toLowerCase(), runtimeId);
  await dismissOnboardingIfVisible(page);
  await completeProfileOnboardingIfVisible(page, label);
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
    const selectedTrigger = document.querySelector<HTMLElement>('[data-testid="context-current"]');
    const selectedEntityId = String(selectedTrigger?.dataset?.entityId || '').trim();
    const selectedSignerId = String(selectedTrigger?.dataset?.signerId || '').trim();
    const selectedRuntimeId = String(selectedTrigger?.dataset?.runtimeId || '').trim();
    const selectedJurisdiction = String(selectedTrigger?.dataset?.jurisdiction || '').trim();
    if (
      /^0x[a-fA-F0-9]{64}$/.test(selectedEntityId)
      && /^0x[a-fA-F0-9]{40}$/.test(selectedSignerId)
    ) {
      return {
        entityId: selectedEntityId,
        signerId: selectedSignerId,
        runtimeId: selectedRuntimeId,
        jurisdiction: selectedJurisdiction,
      };
    }

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
    if (!env?.eReplicas) return null;
    const runtimeId = String(env.runtimeId || '').toLowerCase();
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
    await dismissOnboardingIfVisible(page);
    await completeProfileOnboardingIfVisible(page, `Runtime ${normalizedRuntimeId.slice(2, 6)}`);
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
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForActiveRuntimeId(page, normalizedRuntimeId);
  await waitForRuntimeReady(page, normalizedRuntimeId);
  await dismissOnboardingIfVisible(page);
  await completeProfileOnboardingIfVisible(page, `Runtime ${normalizedRuntimeId.slice(2, 6)}`);
  await ensureRuntimeOnline(page, `switch-id-${runtimeId.slice(0, 8)}`);
}
