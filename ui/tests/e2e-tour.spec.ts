import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

test(
  'guide follows real funding, payment, swap and history without acknowledgement clicks',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    let grants = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/faucet/offchain') grants++;
    });
    await enterStack(page);
    await page.getByTestId('wallet-tutorial').click();
    const guide = page.getByTestId('tour');
    await expect(guide).toHaveAttribute('data-target', 'home-faucet');
    await expect(page.getByTestId('tour-next')).toHaveCount(0);
    await page.getByTestId('home-faucet').click();
    await expect(guide).toHaveAttribute('data-step', 'pay', { timeout: 20_000 });
    expect(grants).toBe(1);
    await expect(page.getByTestId('token-net-USDC')).toContainText('100');
    await page.screenshot({ path: 'tests/test-results/guide-next-payment.png', fullPage: true });
    await page.getByTestId('home-show-zero').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('token-row-WETH')).toBeVisible();
    await page.getByTestId('home-show-zero').click();
    await page.getByTestId('home-pay').click();
    await expect(guide).toHaveAttribute('data-target', 'pay-to');
    await page.getByTestId('pay-to').fill('H');
    await expect(guide).toHaveAttribute('data-target', 'pay-to');
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const card = document.querySelector<HTMLElement>('.tour-card')!;
          if (getComputedStyle(card).visibility === 'hidden') return true;
          const a = card.getBoundingClientRect();
          const b = document.querySelector<HTMLElement>('[data-testid=pay-recipient-options]')!.getBoundingClientRect();
          return a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right;
        }),
      )
      .toBe(true);
    await page.locator('[data-testid^=pay-suggestion-H2]').first().click();
    await expect(guide).toHaveAttribute('data-target', 'pay-amount');
    await page.getByTestId('pay-amount').fill('25');
    await expect(guide).toHaveAttribute('data-target', 'pay-submit');
    await expect(page.getByTestId('pay-submit')).toBeEnabled();
    await page.getByTestId('pay-submit').click();
    await page.getByTestId('receipt-open').click();
    await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 15_000 });
    await expect(page.getByTestId('receipt-amount')).toContainText('25.00 USDC');
    await expect(guide).toHaveAttribute('data-target', 'receipt-done');
    await page.getByTestId('receipt-done').click();
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('home-swap').click();
    const book = page.getByTestId('orderbook').locator('visible=true').first();
    await expect(book).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
    await expect(guide).toHaveAttribute('data-target', 'swap-give');
    await expect(page.getByTestId('tour-value')).toContainText('price you choose');
    await page.getByTestId('swap-give').fill('25');
    await expect(guide).toHaveAttribute('data-target', 'swap-submit', { timeout: 15_000 });
    await expect(guide).toContainText('incoming credit notice');
    await expect(page.getByTestId('swap-submit')).toBeEnabled();
    await page.getByTestId('swap-submit').click();
    await expect(guide).toHaveAttribute('data-step', 'history', { timeout: 15_000 });
    await page.getByTestId('nav-activity').locator('visible=true').first().click();
    await expect(guide).toHaveAttribute('data-step', 'history');
    await expect(page).toHaveURL(/\/activity$/);
    await expect(guide).toHaveAttribute('data-target', 'activity-row');
    await expect(page.getByTestId('activity-row').filter({ hasText: '25' }).first()).toBeVisible();
    await page.getByTestId('tour-advance').click();
    await expect(guide).toHaveAttribute('data-step', 'jurisdiction');
    await page.getByTestId('tour-chapter').selectOption({ label: 'Finish Keep practising' });
    await page.getByTestId('tour-next').click();
    await expect(guide).toHaveCount(0);
    expect(grants).toBe(1);
  },
);

test(
  'starting guidance after receiving money skips the faucet without a second grant',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(45_000);
    let grants = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/faucet/offchain') grants++;
    });
    await enterStack(page);
    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 20_000 });
    await page.getByTestId('wallet-tutorial').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-pay');
    await expect(page.getByTestId('tour-next')).toHaveCount(0);
    expect(grants).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('home-pay').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('home-pay')).toBeInViewport();
    await page.screenshot({ path: 'tests/test-results/guide-mobile.png', fullPage: true });
  },
);


test('starting the guided demo from Settings opens Home and its faucet', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/settings');
  await expect(page.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Try with test money', exact: true }).click();
  await expect(page.getByTestId('home-faucet')).toBeEnabled({ timeout: 40_000 });
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-faucet');
});
