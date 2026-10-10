import { expect, test } from '@playwright/test';
import { WALLET_LESSONS } from '../../frontend/src/lib/tutorial/curriculum';

test(
  'Svelte tutorial walks all feature workspaces and resumes the same chapter',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/app');
    await page.locator('#name').fill(`tutorial-${crypto.randomUUID()}`);
    await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable tutorial test wallet 2026!');
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByTestId('context-current')).toBeVisible();
    await expect(page.getByTestId('jurisdiction-banner')).toContainText('Testnet');
    await page.getByTestId('wallet-tutorial').click();
    for (const lesson of WALLET_LESSONS) {
      await expect(page.getByTestId('tour')).toHaveAttribute('data-step', lesson.id);
      await expect(page.getByTestId('tour-hint')).not.toBeEmpty();
      await expect(page.getByTestId('tour-prerequisite')).toHaveText(`Before you start: ${lesson.prerequisite}`);
      await expect(page.getByTestId('tour-value')).toHaveText(lesson.value);
      await expect(page.getByTestId('tour-result')).toContainText(lesson.outcome);
      await expect(page).toHaveURL(new RegExp(`#${lesson.route === 'accounts/open' ? 'accounts' : lesson.route}$`));
      if (lesson.id === 'dispute') await expect(page.getByRole('heading', { name: 'Dispute Account', exact: true })).toBeVisible();
      if (lesson.id !== 'dispute') await page.getByTestId('tour-advance').click();
    }
    await page.getByTestId('tour-chapter').selectOption('cross');
    await expect(page.getByTestId('tour-hint')).toContainText('To network');
    await page.reload();
    await page.locator('button.wallet').first().click();
    await page.getByLabel('Password', { exact: true }).fill('Disposable tutorial test wallet 2026!');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'cross');
    await page.getByTestId('tour-chapter').selectOption('dispute');
    await page.getByTestId('tour-next').click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await page.getByTestId('wallet-tutorial').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'dispute');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../output/tutorial-svelte-mobile.png', fullPage: true });
  },
);
