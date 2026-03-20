import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { APP_BASE_URL } from './utils/e2e-baseline';

async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(`${APP_BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
}

async function waitUntilOwnsActiveLock(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tabId = window.sessionStorage.getItem('xln-tab-id');
    const raw = window.localStorage.getItem('xln-active-tab-lock');
    if (!tabId || !raw) return false;
    try {
      const parsed = JSON.parse(raw) as { tabId?: string };
      return parsed.tabId === tabId;
    } catch {
      return false;
    }
  }, undefined, { timeout: 10_000 });
}

test.describe('Active tab lock handoff', () => {
  test('second /app tab takes ownership and first becomes inactive', async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();

    try {
      await openApp(first, '/app');
      await waitUntilOwnsActiveLock(first);
      await openApp(second, '/app');

      await expect(first.getByRole('heading', { name: 'Inactive Tab' })).toBeVisible({ timeout: 10_000 });
      await expect(second.getByRole('heading', { name: 'Inactive Tab' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('inactive tab stays inert until explicit reload', async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();

    try {
      await openApp(first, '/app');
      await waitUntilOwnsActiveLock(first);
      await openApp(second, '/app');

      await expect(first.getByRole('heading', { name: 'Inactive Tab' })).toBeVisible({ timeout: 10_000 });
      await expect(second.getByRole('heading', { name: 'Inactive Tab' })).toHaveCount(0);

      await first.bringToFront();
      await first.waitForTimeout(1500);
      await expect(first.getByRole('heading', { name: 'Inactive Tab' })).toBeVisible();
      await expect(second.getByRole('heading', { name: 'Inactive Tab' })).toHaveCount(0);

      await first.getByRole('button', { name: 'Reload to acquire active lock' }).click();
      await expect(second.getByRole('heading', { name: 'Inactive Tab' })).toBeVisible({ timeout: 10_000 });
      await expect(first.getByRole('heading', { name: 'Inactive Tab' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('embedded pay path also participates in ownership handoff', async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const first = await context.newPage();
    const second = await context.newPage();
    const targetEntityId = `0x${'1'.repeat(64)}`;

    try {
      await openApp(first, '/app');
      await waitUntilOwnsActiveLock(first);
      await openApp(
        second,
        `/app?e#pay?id=${encodeURIComponent(targetEntityId)}&token=1&amt=1&mode=embed`,
      );

      await expect(first.getByRole('heading', { name: 'Inactive Tab' })).toBeVisible({ timeout: 10_000 });
      await expect(second.getByRole('heading', { name: 'Inactive Tab' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
