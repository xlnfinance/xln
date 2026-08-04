import { expect, test, type Page } from './global-setup.mts';

const capture = async (page: Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> => {
  for (const [viewport, width, height] of [['wide', 1920, 1080], ['laptop', 1440, 900], ['iphone', 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}:${viewport} overflow`).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${viewport}.png`), fullPage: true, animations: 'disabled' });
  }
};

test.describe('React operator health and QA', () => {

  test('renders real health evidence and protected QA cockpit', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(3 * 60_000);
    await page.goto('/health', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ops-health-page')).toBeVisible();
    await expect(page.getByTestId('health-verdict-banner')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('health-verdict-status')).toContainText(/READY|DEGRADED|FAIL|UNKNOWN/);
    await capture(page, testInfo, 'ops-health');
    await page.goto('/qa', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ops-qa-page')).toBeVisible();
    await expect(page.getByTestId('qa-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('qa-admin-controls')).toBeVisible();
    await capture(page, testInfo, 'ops-qa');
    await page.goto('/runs', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ops-runs-page')).toBeVisible();
    await expect(page.getByTestId('runs-summary')).toBeVisible({ timeout: 30_000 });
    await capture(page, testInfo, 'ops-runs');
  });
});
