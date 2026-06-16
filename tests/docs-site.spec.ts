import { expect, test, devices, type BrowserContext, type Page } from '@playwright/test';

type FailureEntry = {
  url: string;
  error: string;
};

function trackSameOriginFailures(page: Page, failures: FailureEntry[]): void {
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!url.startsWith('http')) return;
    failures.push({
      url,
      error: request.failure()?.errorText || 'request failed',
    });
  });

  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith('http')) return;
    if (response.status() < 400) return;
    failures.push({
      url,
      error: `HTTP ${response.status()}`,
    });
  });
}

async function assertNoDocsFailures(failures: FailureEntry[]): Promise<void> {
  const relevant = failures.filter((entry) =>
    entry.url.includes('/docs')
    || entry.url.includes('/docs-catalog/')
    || entry.url.includes('/img/')
    || entry.url.includes('/api/jurisdictions'),
  );
  expect(relevant, 'docs route should not produce failed requests').toEqual([]);
}

test.describe('Docs site', () => {
  test('main site exposes llms context as static text', async ({ page }) => {
    const response = await page.request.get('/llms.txt');
    expect(response?.ok(), '/llms.txt should be served as a real static asset').toBe(true);
    expect(response?.headers()['content-type'] || '').toContain('text/plain');

    const body = await response.text();
    expect(body.includes('# XLN: Bilateral Settlement With Provable Credit')).toBe(true);
    expect(body.includes('//jurisdictions/contracts/Depository.sol')).toBe(true);
    expect(body.includes('//runtime/runtime.ts')).toBe(true);
    expect(body.includes('<!doctype html>')).toBe(false);
  });

  test('main site exposes a working docs surface', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: /^docs$/i })).toBeVisible();

    const failures: FailureEntry[] = [];
    trackSameOriginFailures(page, failures);

    await page.goto('/docs', { waitUntil: 'networkidle' });

    await page.waitForURL(/\/docs(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Full XLN Project Docs' })).toBeVisible();
    await expect(page.locator('.metric-label').filter({ hasText: 'Current source of truth' })).toBeVisible();

    const search = page.getByTestId('docs-search');
    await search.fill('payment');
    await expect(page.getByTestId('doc-link-implementation-payment-spec')).toBeVisible();
    await page.getByTestId('doc-link-implementation-payment-spec').click();
    await page.waitForURL(/doc=implementation%2Fpayment-spec/);
    await expect(page.locator('.doc-title')).toHaveText('XLN Payment System Specification');

    await search.fill('');
    const statusLink = page.locator('.markdown-body a[data-doc-link="1"]').filter({ hasText: /status/i }).first();
    await expect(statusLink).toBeVisible();
    await statusLink.click();
    await page.waitForURL(/doc=status/);
    await expect(page.locator('.doc-title')).toHaveText('XLN Status');

    await page.getByTestId('archive-toggle').click();
    await expect(page.getByTestId('section-archive-guide')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('docs-desktop.png'), fullPage: true });
    await assertNoDocsFailures(failures);
  });

  test('mobile docs navigation stays usable', async ({ browser }, testInfo) => {
    const context: BrowserContext = await browser.newContext({
      ...devices['iPhone 15 Pro'],
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const failures: FailureEntry[] = [];
    trackSameOriginFailures(page, failures);

    await page.goto('/docs?doc=core%2F00_QA', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('docs-nav-toggle')).toBeVisible();
    await expect(page.locator('.doc-title')).toHaveText('0.0 Questions & Answers');
    await expect(page.locator('.markdown-body img')).toHaveCount(3);

    await page.getByTestId('docs-nav-toggle').click();
    await expect(page.locator('.docs-sidebar.open')).toBeVisible();
    await expect(page.getByTestId('doc-link-core-12_invariant')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('docs-mobile.png'), fullPage: true });
    await assertNoDocsFailures(failures);
    await context.close();
  });
});
