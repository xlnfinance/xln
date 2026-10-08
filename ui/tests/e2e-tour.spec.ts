import { expect, test, type Page } from '@playwright/test';
import { enterStack } from './stack';

/** Click whatever the guide highlights when it is a navigation hop, until it points at `id`. */
async function followTo(page: Page, id: string): Promise<void> {
  const guide = page.getByTestId('tour');
  await expect
    .poll(async () => {
      const target = await guide.getAttribute('data-target');
      if (target === id) return id;
      if (target === 'nav-home') await page.getByTestId('nav-home').locator('visible=true').first().click();
      return target;
    })
    .toBe(id);
}

test(
  'guide walks money in, payments and trading on real actions only',
  { tag: '@functional' },
  async ({ page, context }) => {
    test.setTimeout(75_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let grants = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/faucet/offchain') grants++;
    });
    await enterStack(page);
    await page.getByRole('button', { name: 'Tour', exact: true }).click();
    const guide = page.getByTestId('tour');
    await expect(guide).toHaveAttribute('data-target', 'home-faucet');
    await expect(guide).toHaveAttribute('data-chapter', 'Money in');
    await expect(page.getByTestId('tour-next')).toHaveCount(0);
    await page.getByTestId('home-faucet').click();
    // A detail step points at the breakdown and waits for the user, never for a timer.
    await expect(guide).toHaveAttribute('data-step', 'balance', { timeout: 20_000 });
    await expect(guide).toHaveAttribute('data-target', 'home-balance-breakdown');
    expect(grants).toBe(1);
    await expect(page.getByTestId('token-net-USDC')).toContainText('100');
    await page.getByTestId('tour-next').click();
    await expect(guide).toHaveAttribute('data-step', 'pay');
    await expect(page.getByTestId('tour-next')).toHaveCount(0);
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
    await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', { timeout: 15_000 });
    await expect(page.getByTestId('receipt-amount')).toContainText('25.00 USDC');
    await expect(guide).toHaveAttribute('data-step', 'receipt');
    await expect(guide).toHaveAttribute('data-target', 'receipt-done');
    await page.getByTestId('receipt-done').click();
    await expect(guide).toHaveAttribute('data-step', 'receive');
    await followTo(page, 'home-receive');
    await page.getByTestId('home-receive').click();
    await expect(guide).toHaveAttribute('data-target', 'receive-amount');
    await page.getByTestId('receive-amount').fill('10');
    await expect(guide).toHaveAttribute('data-target', 'receive-copy-link');
    await page.getByTestId('receive-copy-link').click();
    await expect(guide).toHaveAttribute('data-step', 'trade');
    await expect(guide).toHaveAttribute('data-chapter', 'Trading');
    await followTo(page, 'home-swap');
    await page.getByTestId('home-swap').click();
    const book = page.getByTestId('orderbook').locator('visible=true').first();
    await expect(book).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
    await book.locator('.bk-row.ask').last().click();
    await expect(guide).toHaveAttribute('data-target', 'receive-spectrum-confirm');
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(page.getByTestId('receive-spectrum-confirm')).toHaveText('Extend credit limit');
    await page.getByTestId('receive-spectrum-confirm').click();
    await expect(guide).toHaveAttribute('data-target', 'swap-submit', { timeout: 15_000 });
    await expect(page.getByTestId('swap-submit')).toBeEnabled();
    await page.getByTestId('swap-submit').click();
    await expect(guide).toHaveAttribute('data-step', 'account', { timeout: 15_000 });
    await expect(guide).toHaveAttribute('data-chapter', 'Your account');
    expect(grants).toBe(1);
  },
);

test(
  'guide walks account, exit rights, safety and history from a chapter start',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(75_000);
    await enterStack(page);
    await page.getByTestId('home-faucet').click();
    await expect(page.getByTestId('test-money-status')).toContainText('100 USDC received', { timeout: 20_000 });
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    await page.getByTestId('tour-chapter-your-account').click();
    const guide = page.getByTestId('tour');
    await expect(guide).toHaveAttribute('data-step', 'account');
    await followTo(page, 'account-row');
    await page.getByTestId('account-row').first().click();
    await expect(guide).toHaveAttribute('data-step', 'lane');
    await expect(guide).toHaveAttribute('data-target', 'account-lane-USDC');
    await page.getByTestId('tour-next').click();
    // Credit becomes collateral: the hub locks it on-chain after the user's own request.
    await expect(guide).toHaveAttribute('data-step', 'cover');
    await expect(guide).toHaveAttribute('data-target', 'account-cover');
    await page.getByTestId('account-cover').click();
    await expect(guide).toHaveAttribute('data-target', 'collateral-cover-promise');
    await page.getByTestId('collateral-cover-promise').click();
    await expect(guide).toHaveAttribute('data-target', 'collateral-request');
    await expect(page.getByTestId('collateral-request')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('collateral-request').click();
    await expect(guide).toHaveAttribute('data-step', 'dispute', { timeout: 30_000 });
    await expect(page.getByTestId('account-exposure')).toContainText('$0.00');
    // Exit rights are shown, never exercised: the user opens the dispute sheet and closes it.
    await expect(guide).toHaveAttribute('data-target', 'account-dispute');
    await page.getByTestId('account-dispute').click();
    await expect(guide).toHaveAttribute('data-step', 'dispute-close');
    await expect(page.getByTestId('dispute-prepare')).toBeVisible();
    await page.getByTestId('sheet-close').click();
    await expect(guide).toHaveAttribute('data-step', 'security');
    await expect(page.getByTestId('account-status')).toHaveText('Open');
    await followTo(page, 'home-sovereignty');
    await page.getByTestId('home-sovereignty').click();
    await expect(guide).toHaveAttribute('data-step', 'evidence');
    await expect(guide).toHaveAttribute('data-target', 'evidence-export');
    const download = page.waitForEvent('download');
    await page.getByTestId('evidence-export').click();
    expect((await download).suggestedFilename()).toMatch(/\.json$/);
    await expect(guide).toHaveAttribute('data-step', 'history');
    await page.getByTestId('nav-activity').locator('visible=true').first().click();
    await expect(guide).toHaveAttribute('data-step', 'proof');
    await page.getByTestId('activity-row').first().click();
    await expect(guide).toHaveAttribute('data-step', 'finish');
    await page.getByTestId('tour-next').click();
    await expect(guide).toHaveCount(0);
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
    await page.getByRole('button', { name: 'Tour', exact: true }).click();
    // Funding is already observed, so the guide opens on the balance detail and then the first payment.
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'balance');
    await page.getByTestId('tour-next').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-pay');
    await expect(page.getByTestId('tour-next')).toHaveCount(0);
    expect(grants).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
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
