import type { Page } from '@playwright/test';
import type { RuntimeReplica } from '../../core/runtime/types';

// No test-framework runtime import: both browser runners use this public UI flow.
export const BOOT_TIMEOUT = 180_000;
export const LOCAL_PASSWORD = 'e2e-local-wallet-password';

/** Import through the public wallet UI, including production builds without diagnostics. */
export async function importStackPhraseUi(page: Page, phrase: string): Promise<void> {
  await page.locator('[data-testid="gate-stack"][data-state="online"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: /Restore a wallet/ }).click();
  await page.locator('textarea').fill(phrase);
  await page.locator('button[type="submit"]').click();
  await page
    .getByRole('heading', { name: 'Set a local password' })
    .waitFor({ state: 'visible', timeout: BOOT_TIMEOUT });
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Save and open', exact: true }).click();
  await waitForWalletBoot(page);
}

/** The caller's scenario deadline also bounds bootstrap after import or unlock. */
export async function waitForWalletBoot(page: Page): Promise<void> {
  // Surface the first recovery invariant immediately instead of timing out on Home.
  await page
    .locator('[data-testid="nav-home"]:visible, [role="alert"]')
    .first()
    .waitFor({ state: 'visible', timeout: BOOT_TIMEOUT });
  const errors = await page.getByRole('alert').allTextContents();
  if (errors.length > 0) throw new Error(`WALLET_BOOT_FAILED:${errors.join('\n')}`);
}

export async function createWalletIdentity(
  page: Page,
  label: string,
  mnemonic: string,
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  await importStackPhraseUi(page, mnemonic.trim().split(/\s+/).join(' '));
  await page.waitForFunction(
    () => {
      const debug = (
        window as Window & {
          __xln?: { env: () => RuntimeReplica | null; store: { getState: () => { activeEntityId: string | null } } };
        }
      ).__xln;
      return Boolean(debug && debug.env()?.runtimeId && debug.store.getState().activeEntityId);
    },
    undefined,
    { timeout: 150_000 },
  );
  const identity = await readWalletIdentity(page);
  if (!/^0x[a-fA-F0-9]{40}$/.test(identity.runtimeId)) {
    throw new Error(`WALLET_RUNTIME_ID_INVALID:${label}:${identity.runtimeId}`);
  }
  return identity;
}

/** Observe the active owner using the same authority checks before and after reload. */
export async function readWalletIdentity(
  page: Page,
): Promise<{ entityId: string; signerId: string; runtimeId: string }> {
  return page.evaluate(() => {
    const debug = (
      window as Window & {
        __xln?: { env: () => RuntimeReplica | null; store: { getState: () => { activeEntityId: string | null } } };
      }
    ).__xln;
    if (!debug) throw new Error('WALLET_DIAGNOSTICS_UNAVAILABLE');
    const env = debug.env();
    const entityId = debug.store.getState().activeEntityId;
    if (!env || !entityId || !env.runtimeId) throw new Error('WALLET_IDENTITY_UNAVAILABLE');
    const replicas = [...env.state.eReplicas.values()].filter(replica => replica.entityId === entityId);
    const [replica] = replicas;
    if (replicas.length !== 1 || !replica) throw new Error(`WALLET_SIGNER_NOT_UNIQUE:${entityId}:${replicas.length}`);
    return { entityId, signerId: replica.signerId, runtimeId: env.runtimeId };
  });
}
