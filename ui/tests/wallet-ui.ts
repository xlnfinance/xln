import type { Page } from '@playwright/test';

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
  // Surface the first recovery invariant immediately instead of timing out on Home.
  await page
    .locator('[data-testid="nav-home"]:visible, [role="alert"]')
    .first()
    .waitFor({ state: 'visible', timeout: BOOT_TIMEOUT });
  const errors = await page.getByRole('alert').allTextContents();
  if (errors.length > 0) throw new Error(`WALLET_BOOT_FAILED:${errors.join('\n')}`);
}
