import { expect, test, type Page } from '@playwright/test';
import { enterStack } from './stack';

async function expectFirstScreen(page: Page) {
  // Check the initial viewport, never scroll a hidden action into view to pass.
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const navigation = await page.locator('.tabbar').boundingBox();
  const bottom = navigation?.y ?? page.viewportSize()!.height;
  for (const id of ['home-total', 'home-faucet', 'home-pay', 'home-receive', 'home-swap']) {
    const control = page.getByTestId(id);
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.y, id).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, id).toBeLessThanOrEqual(bottom);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const viewport of [
  { width: 1280, height: 860 },
  { width: 390, height: 844 },
]) {
  test(
    `faucet and payment actions stay discoverable at ${viewport.width}px before and after funding`,
    { tag: '@functional' },
    async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize(viewport);
      let grants = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/faucet/offchain') grants++;
      });
      await enterStack(page);
      await page.getByTestId('wallet-tutorial').click();
      await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-faucet');
      await expectFirstScreen(page);
      await page.getByRole('button', { name: 'Get 100 test USDC', exact: true }).click();
      await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received', { timeout: 20_000 });
      await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-pay');
      await expect(page.getByTestId('home-faucet')).toBeEnabled();
      await expect(page.getByTestId('home-total')).toHaveText('$100.00');
      await expectFirstScreen(page);
      await page.screenshot({ path: `../output/faucet-visible-${viewport.width}.png` });
      expect(grants).toBe(1);
      await page.getByTestId('home-pay').click();
      await expect(page.getByTestId('pay-to')).toBeVisible();
      await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'pay-to');
    },
  );
}
