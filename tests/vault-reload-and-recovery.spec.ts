import { Wallet } from 'ethers';
import { expect, test } from './global-setup.mts';

type VaultDebugOperations = {
  createRuntime?: (label: string, seed: string, options: Record<string, unknown>) => Promise<{ id?: unknown }>;
  getSignerPrivateKey?: (index: number) => string | null;
  lockRuntime?: (runtimeId: string) => Promise<void>;
  runtimeExists?: (runtimeId: string) => boolean;
  suspendAllRuntimeActivity?: () => Promise<void>;
  unlockRuntime?: (runtimeId: string, seed: string, durationMs?: number | null) => Promise<void>;
};

const readSanitizedVault = async (page: import('@playwright/test').Page): Promise<unknown> =>
  page.evaluate(() => {
    const raw = localStorage.getItem('xln-vaults');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { activeRuntimeId?: unknown; runtimes?: Record<string, Record<string, unknown>> };
    return {
      activeRuntimeId: parsed.activeRuntimeId ?? null,
      runtimes: Object.fromEntries(Object.entries(parsed.runtimes ?? {}).map(([id, runtime]) => [id, {
        id: runtime['id'],
        label: runtime['label'],
        hasProtectedSecrets: Boolean(runtime['protectedSecrets']),
        protectedVersion: (runtime['protectedSecrets'] as { version?: unknown } | undefined)?.version ?? null,
        containsRawSecretFields: ['seed', 'mnemonic12', 'devicePassphrase', 'env']
          .some(field => Object.hasOwn(runtime, field)),
      }])),
    };
  });

const captureWalletState = async (
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  state: 'ready' | 'locked',
): Promise<void> => {
  for (const [name, width, height] of [
    ['wide', 1920, 1080],
    ['laptop', 1440, 900],
    ['iphone', 393, 852],
  ] as const) {
    await page.setViewportSize({ width, height });
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `${state} ${name} horizontal overflow`).toBeLessThanOrEqual(dimensions.viewport);
    await page.screenshot({
      path: testInfo.outputPath(`wallet-${state}-${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
};

test.describe('Vault reload and recovery', () => {
  test('create, settings, lock, unlock, and reload preserve one protected vault without exposing secrets', {
    tag: '@resilience',
  }, async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => typeof window.__xln?.vault?.createRuntime)).toBe('function');

    const seed = Wallet.createRandom().mnemonic?.phrase;
    if (!seed) throw new Error('VAULT_RELOAD_E2E_MNEMONIC_GENERATION_FAILED');
    const runtimeId = await page.evaluate(async ({ phrase }) => {
      const vault = window.__xln?.vault as VaultDebugOperations | undefined;
      if (!vault?.createRuntime) throw new Error('VAULT_RELOAD_E2E_CREATE_MISSING');
      const runtime = await vault.createRuntime('vault-reload-e2e', phrase, {
        loginType: 'manual',
        requiresOnboarding: false,
        skipRecoveryRestore: true,
        recovery: { useDefaultTowers: false, towers: [] },
        unlockDurationMs: null,
        fundSigner: false,
      });
      const id = String(runtime.id ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(id)) throw new Error(`VAULT_RELOAD_E2E_ID_INVALID:${id}`);
      return id;
    }, { phrase: seed });

    const created = await readSanitizedVault(page);
    expect(created).toMatchObject({
      activeRuntimeId: runtimeId,
      runtimes: {
        [runtimeId]: {
          id: runtimeId,
          hasProtectedSecrets: true,
          protectedVersion: 1,
          containsRawSecretFields: false,
        },
      },
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    expect(await page.locator('body').textContent()).not.toContain(seed);
    await captureWalletState(page, testInfo, 'ready');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption('arctic');
    await page.getByLabel('Lite mode').check();
    await page.getByLabel('xln mascot').uncheck();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Theme')).toHaveValue('arctic');
    await expect(page.getByLabel('Lite mode')).toBeChecked();
    await expect(page.getByLabel('xln mascot')).not.toBeChecked();
    await page.getByRole('button', { name: 'Overview' }).click();

    await page.getByRole('button', { name: 'Lock this runtime' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock your local runtime.' })).toBeVisible();
    expect(await page.evaluate(() =>
      (window.__xln?.vault as VaultDebugOperations | undefined)?.getSignerPrivateKey?.(0) ?? null,
    )).toBeNull();
    await captureWalletState(page, testInfo, 'locked');

    const wrongSeed = Wallet.createRandom().mnemonic?.phrase;
    if (!wrongSeed) throw new Error('VAULT_RELOAD_E2E_WRONG_MNEMONIC_GENERATION_FAILED');
    const failedUnlock = await page.evaluate(async ({ id, phrase }) => {
      const vault = window.__xln?.vault as VaultDebugOperations | undefined;
      if (!vault?.unlockRuntime) throw new Error('VAULT_RELOAD_E2E_UNLOCK_MISSING');
      try {
        await vault.unlockRuntime(id, phrase, null);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, { id: runtimeId, phrase: wrongSeed });
    expect(failedUnlock).toBeTruthy();
    expect(await page.evaluate(() =>
      (window.__xln?.vault as VaultDebugOperations | undefined)?.getSignerPrivateKey?.(0) ?? null,
    )).toBeNull();

    await page.getByTestId('wallet-unlock-mnemonic').fill(seed);
    await page.getByRole('button', { name: 'Unlock wallet' }).click();
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    expect(await page.locator('body').textContent()).not.toContain(seed);
    await page.evaluate(async () => {
      const vault = window.__xln?.vault as VaultDebugOperations | undefined;
      if (!vault?.getSignerPrivateKey?.(0)) throw new Error('VAULT_RELOAD_E2E_UNLOCK_DID_NOT_RESTORE_SIGNER');
      if (!vault.suspendAllRuntimeActivity) throw new Error('VAULT_RELOAD_E2E_SUSPEND_MISSING');
      await vault.suspendAllRuntimeActivity();
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(id => {
      const vault = window.__xln?.vault as VaultDebugOperations | undefined;
      return Boolean(vault?.runtimeExists?.(id) && vault.getSignerPrivateKey?.(0));
    }, runtimeId), { timeout: 60_000 }).toBe(true);

    const reloaded = await readSanitizedVault(page);
    expect(reloaded).toEqual(created);
    await testInfo.attach('vault-reload-sanitized.json', {
      body: Buffer.from(JSON.stringify(reloaded, null, 2)),
      contentType: 'application/json',
    });
  });
});
