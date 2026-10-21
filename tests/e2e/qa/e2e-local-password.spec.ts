import { expect, test } from '@playwright/test';
import { HDNodeWallet } from 'ethers';
import { DEFAULT_INIT_TIMEOUT, gotoApp } from '../../utils/e2e-demo-users';
import { readWalletIdentity } from '../../../ui/tests/wallet-ui';
import type { RuntimeReplica } from '../../../core/runtime/types';

test(
  'an existing Svelte wallet enrolls a password and locks without derivation',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(55_000);
    // Preserve the catalog identity while exercising the current React wallet.
    await gotoApp(page);
    const workerPaths: string[] = [];
    page.on('worker', worker => {
      workerPaths.push(new URL(worker.url()).pathname);
    });
    await page.getByRole('button', { name: 'Open a test wallet', exact: true }).click();
    await expect(page.getByTestId('home-total')).toBeVisible({ timeout: DEFAULT_INIT_TIMEOUT });
    const identity = await readWalletIdentity(page);
    await page.reload();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByTestId('home-total')).toBeVisible();
    expect(await readWalletIdentity(page)).toEqual(identity);
    const runtime = await page.evaluateHandle(() => {
      const debug = (window as typeof window & { __xln?: { env: () => RuntimeReplica | null } }).__xln;
      if (!debug?.env()) throw new Error('Runtime diagnostics unavailable');
      return debug.env()!;
    });
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    await page.getByRole('button', { name: 'Set a local password', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set a local password', exact: true })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill('local-password-audit');
    await page.getByLabel('Confirm password', { exact: true }).fill('local-password-audit');
    await page.getByRole('button', { name: 'Save and open', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set a local password', exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(async id => {
        const vaults = JSON.parse(localStorage.getItem('xln-ui-vaults')!);
        const vault = vaults.find((entry: { id: string }) => entry.id === id);
        const keyCount = await new Promise<number>((resolve, reject) => {
          const request = indexedDB.open('xln-vault-keys-v1', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db.transaction('keys', 'readonly').objectStore('keys').count();
            read.onerror = () => {
              db.close();
              reject(read.error);
            };
            read.onsuccess = () => {
              db.close();
              resolve(read.result);
            };
          };
        });
        return {
          deviceProtectionRemoved: !vault.deviceProtection,
          passwordSaved: localStorage.getItem(`xln-password-vault:${id}`) !== null,
          keyCount,
        };
      }, identity.runtimeId),
    ).toEqual({ deviceProtectionRemoved: true, passwordSaved: true, keyCount: 0 });
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect
      .poll(() =>
        runtime.evaluate(env => ({
          paused: env.infrastructure?.persistencePaused,
          seedRemoved: env.runtimeSeed === undefined,
        })),
      )
      .toEqual({ paused: true, seedRemoved: true });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unlock wallet', exact: true })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Derive vault', exact: true })).toHaveCount(0);
    await page.getByLabel('Password', { exact: true }).fill('wrong-local-password');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Incorrect password');
    await expect(page.getByTestId('home-total')).toHaveCount(0);
    await page.getByLabel('Password', { exact: true }).fill('local-password-audit');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(identity.entityId);
    expect(await readWalletIdentity(page)).toEqual(identity);
    await runtime.dispose();
    await page.reload();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unlock wallet', exact: true })).toBeVisible();
    await expect(page.getByTestId('home-total')).toHaveCount(0);
    await page.getByLabel('Password', { exact: true }).fill('local-password-audit');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(identity.entityId);
    expect(await readWalletIdentity(page)).toEqual(identity);
    expect(workerPaths.every(path => path === '/account-worker.js')).toBe(true);
  },
);

test('a new Svelte wallet sets its password before leaving creation', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(55_000);
  await gotoApp(page);
  await page.getByRole('button', { name: /^Restore a wallet/ }).click();
  await page.getByLabel('Recovery phrase', { exact: true }).fill(HDNodeWallet.createRandom().mnemonic!.phrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set a local password', exact: true })).toBeVisible();
  await expect(page.getByTestId('home-total')).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('new-wallet-local-password');
  await page.getByLabel('Confirm password', { exact: true }).fill('new-wallet-local-password');
  await page.getByRole('button', { name: 'Save and open', exact: true }).click();
  await expect(page.getByTestId('home-total')).toBeVisible({ timeout: DEFAULT_INIT_TIMEOUT });
  await expect(page.getByRole('heading', { name: 'Set a local password', exact: true })).toHaveCount(0);
  const identity = await readWalletIdentity(page);
  await page.reload();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock wallet', exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  await page.getByLabel('Password', { exact: true }).fill('new-wallet-local-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('home-entity-id')).toHaveText(identity.entityId);
  expect(await readWalletIdentity(page)).toEqual(identity);
});

test('Svelte BrainVault uses its original secret for local unlock', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(55_000);
  await gotoApp(page);
  const workerPaths: string[] = [];
  page.on('worker', worker => workerPaths.push(new URL(worker.url()).pathname));
  await page.getByRole('button', { name: /^Create a wallet/ }).click();
  await page.getByLabel('Vault name', { exact: true }).fill(`Original ${Date.now()}`);
  await expect(page.getByLabel('Passphrase', { exact: true })).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill('123');
  await page.getByRole('button', { name: 'Test 1 shard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Derive vault', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Derive vault', exact: true }).click();
  await expect(page.getByTestId('home-total')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('heading', { name: 'Set a local password' })).toHaveCount(0);
  expect(workerPaths.filter(path => path !== '/account-worker.js')).toHaveLength(1);
  const identity = await readWalletIdentity(page);
  workerPaths.length = 0;
  await page.reload();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  await page.getByLabel('Password', { exact: true }).fill('123');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('home-entity-id')).toHaveText(identity.entityId);
  expect(await readWalletIdentity(page)).toEqual(identity);
  expect(workerPaths.filter(path => path !== '/account-worker.js')).toEqual([]);
});
