import { expect, test } from '../../global-setup.mts';
import { Wallet } from 'ethers';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';

async function deriveCompanyOwner(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/app');
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('ENTITY_FORMATION_E2E_MNEMONIC_UNAVAILABLE');
  await createWalletIdentity(page, `company-owner-${Date.now()}`, mnemonic.phrase);
}

async function openEntityFormation(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-ownership').click();
  const panel = page.getByTestId('entity-formation');
  await panel.locator('summary').click();
  await expect(panel).toContainText('Each has its own accounts and approval rules.');
  await expect(panel.getByLabel('Shared approval')).not.toBeChecked();
  await expect(panel.getByTestId('formation-kind')).toHaveValue('numbered');
  await expect(panel.getByTestId('formation-submit')).toHaveText('Register on-chain');
  await panel.getByTestId('formation-kind').selectOption('lazy');
  await expect(panel).toContainText('No registration transaction.');
  await expect(panel.getByTestId('formation-submit')).toHaveText('Create entity');
  await panel.getByLabel('Shared approval').check();
  await panel.getByRole('button', { name: 'Add signer', exact: true }).click();
  await expect(panel.getByLabel('Signer address')).toHaveCount(2);
  await expect(panel.getByLabel('Required voting weight · total 2')).toHaveValue('2');
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
        const panel = page.getByTestId('entity-formation');
        await expect(panel.getByTestId('formation-name')).toBeVisible();
        await expect(panel.getByLabel('Signer address')).toHaveCount(2);
        await expect(panel.getByLabel('Required voting weight · total 2')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`entity-formation-${viewport.name}.png`), fullPage: true });
      }
    },
  );
});
