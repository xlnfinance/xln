import { devices, expect, test, type Browser, type Page } from './global-setup.mts';

const assertNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
};

test.describe('React wallet shell and onboarding', () => {

  test('renders a clean first-run wallet at iPhone, laptop, and wide desktop sizes', { tag: '@functional' }, async ({ browser }, testInfo) => {
    const viewports = [
      { name: 'wide', context: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
      { name: 'laptop', context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
      { name: 'iphone', context: devices['iPhone 15 Pro'] },
    ] as const;

    for (const viewport of viewports) {
      const context = await (browser as Browser).newContext(viewport.context);
      const page = await context.newPage();
      await page.goto('/app', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Create xln wallet' })).toBeVisible();
      await expect(page.getByTestId('wallet-mnemonic-input')).toHaveAttribute('autocomplete', 'off');
      await expect(page.getByRole('button', { name: 'Create wallet' })).toBeDisabled();
      await assertNoHorizontalOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`wallet-onboarding-${viewport.name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      await context.close();
    }
  });

  test('supports keyboard setup choice and exposes offline state without leaking a phrase', { tag: '@functional' }, async ({ page }) => {
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Import phrase' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wallet-mnemonic-input')).toHaveAttribute('placeholder', 'Enter your 12-word or 24-word phrase');
    await page.context().setOffline(true);
    await expect(page.getByText('Offline — wallet setup and local vault access remain available.')).toBeVisible();
    expect(await page.locator('body').textContent()).not.toContain('abandon ability able');
    await page.context().setOffline(false);
  });
});
