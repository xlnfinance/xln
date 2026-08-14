import { expect, test } from '../../global-setup.mts';

async function deriveCompanyOwner(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/app');
  await page.getByLabel('Vault name public derivation input').fill('company-owner@example.com');
  await page.getByLabel('Secret passphrase').fill('CompanyOwnerStrongPassphrase!23');
  await page.getByRole('button', { name: /^Advanced\b/ }).click();
  await page.getByRole('button', { name: /^1\s+Test$/ }).click();
  const deriveButton = page.getByRole('button', { name: 'Derive wallet', exact: true });
  await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
  await deriveButton.click();

  await expect(page.getByLabel('Display name')).toBeVisible({ timeout: 240_000 });
  await page.getByRole('button', { name: /^start$/i }).click();
  await expect(page.getByTestId('tab-accounts')).toBeVisible({ timeout: 30_000 });
}

async function openEntityFormation(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('context-current').click();
  await page.getByRole('button', { name: '+ Entity', exact: true }).click();
  const panel = page.getByTestId('entity-formation-panel');
  await expect(panel.getByRole('heading', { name: 'Create Entity', exact: true })).toBeVisible();
  await expect(panel.getByText('Every person, company, and hub starts as the same Entity.')).toBeVisible();
  await expect(panel.getByTestId('formation-personal')).toHaveClass(/active/);
  await panel.getByTestId('formation-shared').click();
  await expect(panel.getByText('Board members (2)', { exact: true })).toBeVisible();
}

test.describe('Entity formation', () => {
  test('shows one canonical personal or shared Entity workflow at every supported viewport', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(5 * 60 * 1000);
    await deriveCompanyOwner(page);
    await openEntityFormation(page);

    for (const viewport of [
      { name: 'iphone', width: 393, height: 852 },
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'wide', width: 1920, height: 1080 },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByTestId('entity-formation-panel').getByRole('heading', { name: 'Create Entity', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`entity-formation-${viewport.name}.png`), fullPage: true });
    }
  });
});
