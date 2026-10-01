import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

test('malformed shared swap quote leaves the wallet usable without submitting an order', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await enterStack(page);
  // Exercise the real route without reloading/unlocking or replacing runtime state.
  await page.evaluate(() => {
    window.history.pushState(null, '', '/swap?side=ask&price=x&size=1');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('Invalid swap link. Choose a price from the order book.')).toBeVisible();
  await expect(page.getByTestId('swap-give')).toHaveValue('');
  await expect(page.getByTestId('swap-want')).toHaveValue('');
  await expect(page.getByTestId('swap-submit')).toBeDisabled();
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await expect(page.getByTestId('home-total')).toBeVisible();
  expect(errors).toEqual([]);
});
