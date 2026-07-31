import { expect, test } from '@playwright/test';

const TEST_URL = '/app?locktest=1&scenarioPreview=1';
const VIEWPORTS = [
  { label: 'iphone', width: 390, height: 844 },
  { label: 'laptop', width: 1440, height: 900 },
  { label: 'wide', width: 2560, height: 1440 },
] as const;

test.describe('Recovery choice guidance', () => {
  for (const viewport of VIEWPORTS) {
    test(`shows concise tradeoffs at ${viewport.label} size`, { tag: '@functional' }, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(TEST_URL);

      await expect(page.getByTestId('brainvault-tradeoffs')).toBeVisible();
      await expect(page.getByText('No secret paper, photo, or cloud backup to protect', { exact: true })).toBeVisible();
      await expect(page.getByText(/estimated bits/i)).toHaveCount(0);
      await page.waitForTimeout(800);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-brainvault.png`), fullPage: true });

      await page.getByRole('tab', { name: 'Mnemonic', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Create or restore from seed', exact: true })).toBeVisible();
      await expect(page.getByTestId('mnemonic-tradeoffs')).toBeVisible();
      await expect(page.getByText('Fresh seeds use strong cryptographic randomness', { exact: true })).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-mnemonic.png`), fullPage: true });
    });
  }

  test('requires the work factor to be rehearsed explicitly', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto(TEST_URL);

    await page.getByLabel('Vault name public derivation input').fill('rehearsal@example.org');
    await page.getByLabel('Secret passphrase').fill('correct horse battery staple');
    await page.getByRole('button', { name: /Security work factor/ }).click();
    await page.getByRole('button', { name: '1 Test', exact: true }).click();
    await page.getByTestId('recovery-rehearsal-option').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();

    await expect(page.getByTestId('recovery-rehearsal-active')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Vault name public derivation input')).toHaveValue('');
    await expect(page.getByLabel('Secret passphrase')).toHaveValue('');
    await expect(page.getByRole('button', { name: /Choose the same factor again/ })).toBeVisible();

    await page.getByLabel('Vault name public derivation input').fill('rehearsal@example.org');
    await page.getByLabel('Secret passphrase').fill('correct horse battery staple');
    await expect(page.getByRole('button', { name: 'Verify recovery', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /Choose the same factor again/ }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: testInfo.outputPath('rehearsal-factor-required.png'), fullPage: true });

    await page.getByRole('button', { name: '1 Test', exact: true }).click();
    await expect(page.getByRole('button', { name: '1 Test', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Verify recovery', exact: true })).toBeEnabled();
    await page.waitForTimeout(250);
    await page.screenshot({ path: testInfo.outputPath('rehearsal-ready.png'), fullPage: true });
  });
});
