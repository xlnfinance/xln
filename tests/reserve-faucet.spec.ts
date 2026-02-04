import { test, expect } from '@playwright/test';

const parseBalance = (text: string | null): number => {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
};

test.describe('Reserve faucet (user mode)', () => {
  test('should increase reserve balance after faucet', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/app');

    const reservesTab = page.getByTestId('tab-reserves');
    await expect(reservesTab).toBeVisible({ timeout: 180_000 });
    await reservesTab.click();

    const balanceLocator = page.getByTestId('reserve-balance-USDC');
    await expect(balanceLocator).toBeVisible({ timeout: 30_000 });

    const initialText = await balanceLocator.textContent();
    const initialValue = parseBalance(initialText);

    const faucetButton = page.getByTestId('reserve-faucet-USDC');
    await expect(faucetButton).toBeEnabled({ timeout: 10_000 });
    await faucetButton.click();

    await expect
      .poll(async () => {
        const text = await balanceLocator.textContent();
        return parseBalance(text);
      }, {
        timeout: 120_000,
        intervals: [1000, 2000, 3000, 5000],
      })
      .toBeGreaterThan(initialValue);
  });
});
