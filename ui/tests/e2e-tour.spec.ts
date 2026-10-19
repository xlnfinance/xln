import { expect, test, type Page } from '@playwright/test';
import { enterStack } from './stack';
import { fundFromHubUi } from './fund-from-hub';

async function expectGuideInViewport(page: Page) {
  const card = page.getByTestId('tour').locator('.tour-card');
  await card.evaluate(async node => {
    await Promise.all(node.getAnimations().map(animation => animation.finished));
  });
  await expect(card).toBeInViewport({ ratio: 1 });
}

test('an incoming WETH payment does not complete the swap exercise', { tag: '@functional' }, async ({ page }) => {
  test.setTimeout(60_000);
  await enterStack(page);
  await page.getByTestId('wallet-tutorial').click();
  await page.getByTestId('tour-chapter').selectOption('trade');
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'trade');
  await fundFromHubUi(page, expect, '0.001', 'WETH');
  await expect(page.getByTestId('token-net-WETH')).toHaveText('0.001', { timeout: 20_000 });
  // Observe several actual guide ticks after the financial credit committed.
  for (let tick = 0; tick < 3; tick++) {
    await page.waitForTimeout(200);
    await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'trade');
  }
});

test(
  'guide follows real funding, payment, swap and history without acknowledgement clicks',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const requirements = { requireMarketMaker: true };
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/health');
          expect(response.ok()).toBe(true);
          return (await response.json()).marketMaker;
        },
        { timeout: 20_000 },
      )
      .toMatchObject({ enabled: requirements.requireMarketMaker, ok: true });
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
    await page.setViewportSize({ width: 390, height: 844 });
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
    await expect(guide).toHaveAttribute('data-target', 'back');
    await page.getByTestId('back').click();
    await expect(guide).toHaveAttribute('data-target', 'nav-activity');
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
    await page.getByTestId('home-receive').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'back');
    await page.getByTestId('back').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-pay');
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    await page.getByTestId('tour-replay').click();
    await expect(page.getByTestId('tour')).toHaveAttribute('data-target', 'home-pay');
    await expectGuideInViewport(page);
    expect(grants).toBe(1);
  },
);

async function verifySettingsReplay(page: Page, width: number) {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 844 });
  await enterStack(page);
  await page.getByTestId('nav-settings').locator('visible=true').first().click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByTestId('tour-replay').click();
  await expect(page.getByTestId('home-faucet')).toBeEnabled({ timeout: 40_000 });
  await expect(page).toHaveURL(/\/$/);
  const guide = page.getByTestId('tour');
  await expect(guide).toHaveAttribute('data-target', 'home-faucet');
  await expectGuideInViewport(page);
  // Replaying an already active chapter must also reveal it after Settings navigation.
  await page.getByTestId('nav-settings').locator('visible=true').first().click();
  await page.getByTestId('tour-replay').click();
  await expect(guide).toHaveAttribute('data-target', 'home-faucet');
  await expectGuideInViewport(page);
}

test('Settings Replay reveals the guide and faucet on desktop', { tag: '@functional' }, async ({ page }) => {
  await verifySettingsReplay(page, 1280);
});

test('Settings Replay reveals the guide and faucet on mobile', { tag: '@functional' }, async ({ page }) => {
  await verifySettingsReplay(page, 390);
});
