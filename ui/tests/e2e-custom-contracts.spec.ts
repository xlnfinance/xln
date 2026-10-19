import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

test('custom Solidity tooling compiles a draft while unavailable admission cannot submit it', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await enterStack(page);
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-custom-contracts').click();
  await expect(page.getByTestId('custom-unavailable')).toContainText('New custom-contract admission is unavailable');
  await expect(page.getByTestId('custom-source')).not.toHaveValue('');
  await page.getByTestId('custom-compile').click();
  await expect(page.getByTestId('custom-compiled')).toContainText('0.8.37');
  await expect(page.getByRole('button', { name: 'Propose to counterparty' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
