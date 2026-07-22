import { expect, test } from '../../tests/global-setup.ts';

async function completeOnboarding(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByLabel('Display name')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('heading', { name: /Configure account/i })).toBeVisible();
  await expect(page.getByText('Local only')).toBeVisible();
  const startButton = page.getByRole('button', { name: /^start$/i });
  await expect(startButton).toBeVisible();
  await startButton.click();
  await expect(page.getByTestId('tab-accounts')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Open Account$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open Account', exact: true })).toBeVisible();
  await expect(page.getByText('Counterparties')).toBeVisible();
  const capacityBar = page.locator('.delta-capacity-bar').first();
  await expect(capacityBar).toHaveCount(1);
  await expect.poll(async () => capacityBar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      paddingTop: style.paddingTop,
      borderTopWidth: style.borderTopWidth,
    };
  })).toEqual({ paddingTop: '0px', borderTopWidth: '0px' });
}

test.describe('BrainVault default flow', () => {
  test('derives a vault end-to-end (real worker, 1 factor)', { tag: '@functional' }, async ({ page }, testInfo) => {
    // Allow extra time for hash-wasm download + Argon2 computation
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/app');

    await page.getByLabel('Vault name public derivation input').fill('vault-test@example.com');
    await page.getByLabel('Secret passphrase').fill('A_VeryHARDpassword123!');

    // Security work factor presets are collapsed under the "Advanced" toggle now
    await page.getByRole('button', { name: /Security work factor/i }).click();
    await page.getByRole('button', { name: /^1\s+Test$/ }).click();

    const deriveButton = page.getByRole('button', { name: /^Derive wallet$/i });
    await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
    await deriveButton.click();

    await completeOnboarding(page);
    await page.screenshot({ path: testInfo.outputPath('wallet-after-onboarding.png'), fullPage: true });
    await expect(page.getByRole('button', { name: /vault-test@example\.com/i }).first()).toBeVisible();
  });

  test('derives a vault end-to-end (real worker, 2 factors)', { tag: '@functional' }, async ({ page }, testInfo) => {
    // Allow extra time for hash-wasm download + Argon2 computation
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/app');

    await page.getByLabel('Vault name public derivation input').fill('vault-tes2t@example.com');
    await page.getByLabel('Secret passphrase').fill('NotHardEnough!11');

    // Security work factor presets are collapsed under the "Advanced" toggle now
    await page.getByRole('button', { name: /Security work factor/i }).click();
    await page.getByRole('button', { name: /^2\s+Basic$/ }).click();

    const deriveButton = page.getByRole('button', { name: /^Derive wallet$/i });
    await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
    await deriveButton.click();

    await completeOnboarding(page);
    await page.screenshot({ path: testInfo.outputPath('wallet-after-onboarding.png'), fullPage: true });
    await expect(page.getByRole('button', { name: /vault-tes2t@example\.com/i }).first()).toBeVisible();
  });
});
