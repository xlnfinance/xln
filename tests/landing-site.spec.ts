import { devices, expect, test, type Browser, type Page, type TestInfo } from './global-setup.mts';

type BrowserIssue = Readonly<{ type: string; text: string }>;

const trackBrowserIssues = (page: Page): BrowserIssue[] => {
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
};

const assertNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, 'landing page must stay within its viewport').toBeLessThanOrEqual(dimensions.viewport);
};

test.describe('Landing surface', () => {
  test(
    'stays public-only and polished on wide, laptop, and iPhone screens',
    { tag: '@functional' },
    async ({ browser }, testInfo: TestInfo) => {
      const viewports = [
        { name: 'wide', context: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
        { name: 'laptop', context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
        { name: 'iphone', context: devices['iPhone 15 Pro'] },
      ] as const;

      for (const viewport of viewports) {
        const context = await (browser as Browser).newContext({ ...viewport.context, ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const issues = trackBrowserIssues(page);
        const walletRequests: string[] = [];
        page.on('request', request => {
          const path = new URL(request.url()).pathname;
          if (
            path === '/runtime.js'
            || path === '/brainvault-worker.js'
            || path === '/api/jurisdictions'
            || path.startsWith('/api/runtime')
          ) {
            walletRequests.push(path);
          }
        });

        await page.goto('/', { waitUntil: 'networkidle' });
        await expect(page.getByRole('heading', { level: 1 })).toContainText('One protocol. Every jurisdiction.');
        await expect(page.getByRole('link', { name: 'App', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Install', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
        await expect(page.getByText('deriveDelta', { exact: true })).toHaveCount(0);
        await assertNoHorizontalOverflow(page);

        await page.screenshot({
          path: testInfo.outputPath(`landing-${viewport.name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        expect(walletRequests, `${viewport.name} landing must not initialize wallet runtime assets`).toEqual([]);
        expect(issues, `${viewport.name} browser console and network must stay clean`).toEqual([]);
        await context.close();
      }
    },
  );
});
