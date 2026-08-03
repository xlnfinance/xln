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

test.describe('Vault reload and recovery', () => {
  test('create, lock, unlock, and reload preserve one protected vault without exposing secrets', {
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

    await page.evaluate(async id => {
      const vault = window.__xln?.vault as VaultDebugOperations | undefined;
      if (!vault?.lockRuntime) throw new Error('VAULT_RELOAD_E2E_LOCK_MISSING');
      await vault.lockRuntime(id);
      if (vault.getSignerPrivateKey?.(0) !== null) throw new Error('VAULT_RELOAD_E2E_LOCK_DID_NOT_REVOKE_SIGNER');
    }, runtimeId);

    await page.evaluate(async ({ id, phrase }) => {
      const vault = window.__xln?.vault as VaultDebugOperations | undefined;
      if (!vault?.unlockRuntime) throw new Error('VAULT_RELOAD_E2E_UNLOCK_MISSING');
      await vault.unlockRuntime(id, phrase, null);
      if (!vault.getSignerPrivateKey?.(0)) throw new Error('VAULT_RELOAD_E2E_UNLOCK_DID_NOT_RESTORE_SIGNER');
      if (!vault.suspendAllRuntimeActivity) throw new Error('VAULT_RELOAD_E2E_SUSPEND_MISSING');
      await vault.suspendAllRuntimeActivity();
    }, { id: runtimeId, phrase: seed });

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
