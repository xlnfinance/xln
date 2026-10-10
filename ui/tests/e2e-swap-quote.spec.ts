import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

test('cross-network orders require an explicit minimum instead of borrowing a same-network quote', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  await enterStack(page);
  await page.getByTestId('home-faucet').click();
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received');
  await page.getByTestId('home-swap').click();
  await expect(page.getByTestId('orderbook').locator('visible=true').first()).toHaveAttribute('data-status', 'live');
  await page.getByTestId('swap-give').fill('25');
  await expect(page.getByTestId('swap-quote-note')).toContainText('Quoted at the best price');
  await expect(page.getByTestId('swap-submit')).toBeEnabled();

  await page.getByRole('button', { name: 'Across networks', exact: true }).click();
  await expect(page.getByTestId('swap-want')).toHaveValue('');
  await expect(page.getByTestId('swap-want')).toHaveAttribute('placeholder', '0.00');
  await expect(page.getByTestId('swap-quote-note')).toContainText('not a live cross-network quote');
  await expect(page.getByTestId('swap-quote-note')).toContainText('matching liquidity');
  await expect(page.getByTestId('cross-swap-safety')).toContainText('Stay online');
  await expect(page.getByTestId('cross-swap-safety')).toContainText('Cancel rest');
  await expect(page.getByTestId('swap-submit')).toBeDisabled();
  await page.getByTestId('swap-want').fill('0.01');
  await expect(page.getByTestId('swap-submit')).toBeEnabled();

  // A manually chosen price also belongs to its venue; changing modes requires a new choice.
  await page.getByRole('button', { name: 'Same network', exact: true }).click();
  await page.getByTestId('swap-want').fill('0.02');
  await page.getByRole('button', { name: 'Across networks', exact: true }).click();
  await expect(page.getByTestId('swap-want')).toHaveValue('');
  await expect(page.getByTestId('swap-submit')).toBeDisabled();
});
