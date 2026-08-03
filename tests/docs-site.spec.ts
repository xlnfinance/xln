import { expect, test, devices, type BrowserContext, type Page } from './global-setup.mts';

type FailureEntry = {
  url: string;
  error: string;
};

type BrowserIssue = Readonly<{ type: string; text: string }>;

function trackBrowserIssues(page: Page): BrowserIssue[] {
  const issues: BrowserIssue[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push({ type: `console:${message.type()}`, text: message.text() });
    }
  });
  page.on('pageerror', error => issues.push({ type: 'pageerror', text: error.message }));
  page.on('requestfailed', request => {
    issues.push({ type: 'requestfailed', text: `${request.url()} ${request.failure()?.errorText ?? ''}` });
  });
  page.on('response', response => {
    if (response.status() >= 400) issues.push({ type: `http:${response.status()}`, text: response.url() });
  });
  return issues;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, 'docs page must stay within its viewport').toBeLessThanOrEqual(dimensions.viewport);
}

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
  test('main site exposes llms context as static text', { tag: '@functional' }, async ({ page }) => {
    const response = await page.request.get('/llms.txt');
    expect(response?.ok(), '/llms.txt should be served as a real static asset').toBe(true);
    expect(response?.headers()['content-type'] || '').toContain('text/plain');

    const body = await response.text();
    expect(body.includes('# XLN: Bilateral Settlement With Provable Credit')).toBe(true);
    expect(body.includes('//jurisdictions/contracts/Depository.sol')).toBe(true);
    expect(body.includes('//runtime/runtime.ts')).toBe(true);
    expect(body.includes('<!doctype html>')).toBe(false);
  });

  test('main site exposes a working docs surface', { tag: '@functional' }, async ({ page }, testInfo) => {
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
    await expect(page.locator('.doc-title')).toHaveText('Payment and HTLC flow');

    await search.fill('');
    const statusLink = page.getByTestId('doc-link-status').first();
    await expect(statusLink).toBeVisible();
    await statusLink.click();
    await page.waitForURL(/doc=status/);
    await expect(page.locator('.doc-title')).toHaveText('XLN Status');

    await page.getByTestId('archive-toggle').click();
    await expect(page.getByTestId('section-archive-guide')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('docs-desktop.png'), fullPage: true });
    await assertNoDocsFailures(failures);
  });

  test('mobile docs navigation stays usable', { tag: '@functional' }, async ({ browser }, testInfo) => {
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
    const openSidebar = page.locator('.docs-sidebar.open');
    await expect(openSidebar).toBeVisible();
    await expect(page.getByTestId('doc-link-core-12_invariant')).toBeVisible();

    const sidebarBounds = await openSidebar.boundingBox();
    const viewport = page.viewportSize();
    if (!sidebarBounds || !viewport) throw new Error('mobile docs viewport bounds are unavailable');
    expect(sidebarBounds.y).toBe(56);
    expect(sidebarBounds.height).toBe(viewport.height - 56);

    await page.screenshot({ path: testInfo.outputPath('docs-mobile-open.png'), animations: 'disabled' });
    await assertNoDocsFailures(failures);
    await context.close();
  });

  test(
    'keeps a nested document clean on wide, laptop, and iPhone screens',
    { tag: '@functional' },
    async ({ browser }, testInfo) => {
      const viewports = [
        { name: 'wide', context: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
        { name: 'laptop', context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
        { name: 'iphone', context: devices['iPhone 15 Pro'] },
      ] as const;

      for (const viewport of viewports) {
        const context: BrowserContext = await browser.newContext({
          ...viewport.context,
          ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        const issues = trackBrowserIssues(page);

        await page.goto('/docs?doc=core%2F00_QA', { waitUntil: 'networkidle' });
        await expect(page.getByRole('heading', { name: 'Full XLN Project Docs' })).toBeVisible();
        await expect(page.locator('.doc-title')).toHaveText('0.0 Questions & Answers');
        await assertNoHorizontalOverflow(page);

        await page.screenshot({
          path: testInfo.outputPath(`docs-${viewport.name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        expect(issues, `${viewport.name} browser console and network must stay clean`).toEqual([]);
        await context.close();
      }
    },
  );
});
