import type { Page, expect as PlaywrightExpect } from '@playwright/test';
type Expect = typeof PlaywrightExpect;

export async function fundFromHubUi(
  page: Page,
  expect: Expect,
  amount = '100',
  token: 'USDC' | 'WETH' = 'USDC',
): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await page.getByRole('button', { name: token, exact: true }).click();
  await page.getByTestId('faucet-amount').fill(amount);
  const spectrum = page.getByTestId('receive-spectrum');
  if (await spectrum.isVisible()) {
    await page.getByRole('button', { name: '0% collateral', exact: true }).click();
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(spectrum).toHaveCount(0, { timeout: 15_000 });
  }
  await expect(page.getByTestId('faucet-offchain')).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/offchain' && response.request().method() === 'POST',
    ),
    page.getByTestId('faucet-offchain').click(),
  ]);
  expect(response.ok(), `Faucet admission failed: ${response.status()} ${await response.text()}`).toBe(true);
  await expect(page.getByTestId('faucet-status')).toContainText('Payment requested.');
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId(`token-net-${token}`)).toBeVisible({ timeout: 90_000 });
}
