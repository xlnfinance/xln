import { expect, type Page } from '@playwright/test';

export async function submitLoanRequest(page: Page, termLabel: string, rate: string): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-lend').click();
  await page.getByTestId('lend-side-borrow').click();
  await page.getByRole('button', { name: termLabel, exact: true }).click();
  await page.getByTestId('lend-amount').fill('1');
  await page.getByTestId('lend-rate').fill(rate);
  const receive = page.getByTestId('receive-spectrum');
  await receive.getByRole('button', { name: 'Accept it as credit instead', exact: true }).click();
  await receive.getByRole('checkbox').uncheck();
  await page.getByTestId('receive-spectrum-confirm').click();
  await expect(page.getByTestId('lend-submit')).toBeEnabled();
  await page.getByTestId('lend-submit').click();
}
