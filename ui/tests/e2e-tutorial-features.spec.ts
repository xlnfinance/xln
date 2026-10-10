import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

const chapters = [
  ['jurisdiction', '/'], ['cross', '/swap'], ['receive', '/receive'],
  ['hubs', '/'], ['limits', '/accounts/'], ['move', '/move'], ['withdraw', '/move'],
  ['lending', '/lend'], ['borrow', '/lend'], ['repay', '/lend'],
  ['protection', '/sovereignty'], ['recovery', '/sovereignty'],
  ['company', '/ownership'], ['shares', '/ownership'], ['governance', '/ownership'],
  ['dispute', '/accounts/'],
];

test(
  'every advanced tutorial chapter opens its real screen and can pause without losing input',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    await enterStack(page);
    await expect(page.getByTestId('jurisdiction-banner')).toContainText('Testnet');
    await expect(page.getByTestId('jurisdiction-chain')).toHaveText('Chain 31337');
    await page.getByTestId('jurisdiction-stack').locator('summary').click();
    await expect(page.getByTestId('jurisdiction-stack').locator('code')).toHaveCount(2);
    await page.getByTestId('wallet-tutorial').click();
    for (const [id, path] of chapters) {
      await page.getByTestId('tour-chapter').selectOption(id!);
      await expect(page.getByTestId('tour')).toHaveAttribute('data-step', id!);
      await expect.poll(() => new URL(page.url()).pathname).toContain(path!);
      await expect(page.getByTestId('tour-hint')).not.toBeEmpty();
      await expect(page.getByTestId('tour-prerequisite')).toBeVisible();
      await expect(page.getByTestId('tour-value')).not.toBeEmpty();
      await expect(page.getByTestId('tour-result')).toBeVisible();
      await expect(page.getByTestId('tour-result')).not.toBeEmpty();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('tour-chapter').selectOption('receive');
    await page.getByTestId('receive-amount').fill('5');
    await page.getByTestId('tour-exit').click();
    await expect(page.getByTestId('receive-amount')).toHaveValue('5');
    await page.getByTestId('wallet-tutorial').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'receive');
    await expect(page.getByTestId('receive-amount')).toHaveValue('5');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'tests/test-results/tutorial-mobile.png', fullPage: true });
  },
);

test(
  'jurisdiction name, chain and color follow the selected entity on every screen',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    await enterStack(page);
    await page.getByTestId('entity-switcher-trigger').click();
    const tron = page.getByTestId('entity-switcher-entity').filter({ hasText: /Tron/i });
    await expect(tron).toHaveCount(1);
    await tron.click();
    await expect(page.getByTestId('jurisdiction-banner')).toContainText(/Tron/i);
    await expect(page.locator('.app')).toHaveAttribute('data-jurisdiction', 'tron');
    const chain = await page.getByTestId('jurisdiction-chain').innerText();
    expect(chain).not.toBe('Chain 31337');
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-ownership').click();
    await expect(page.getByTestId('jurisdiction-banner')).toContainText(/Tron/i);
    await expect(page.getByTestId('jurisdiction-chain')).toHaveText(chain);
  },
);
