import { devices, expect, test, type Browser, type Page, type TestInfo } from './global-setup.mts';

type BrowserIssue = Readonly<{ type: string; text: string }>;

const trackBrowserIssues = (page: Page): BrowserIssue[] => {
  const issues: BrowserIssue[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push({ type: `console:${message.type()}`, text: message.text() });
  });
  page.on('pageerror', error => issues.push({ type: 'pageerror', text: error.message }));
  page.on('requestfailed', request => issues.push({ type: 'requestfailed', text: `${request.url()} ${request.failure()?.errorText ?? ''}` }));
  page.on('response', response => {
    if (response.status() >= 400) issues.push({ type: `http:${response.status()}`, text: response.url() });
  });
  return issues;
};

const assertNoOverflow = async (page: Page, route: string): Promise<void> => {
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.document, `${route} must stay inside its viewport`).toBeLessThanOrEqual(dimensions.viewport);
};

const ROUTES = [
  { path: '/rcpan', heading: 'Credit that can', ready: 'Every token conserved', interaction: async (page: Page) => page.getByRole('button', { name: /70 \/ 30/ }).click() },
  { path: '/releases', heading: 'Releases', ready: 'Foundation code root verified', interaction: async (page: Page) => page.getByRole('combobox', { name: /^Metric/ }).selectOption('complexity') },
  { path: '/reviews', heading: 'AI Reviews of xln', ready: 'sonnet-4', interaction: async (page: Page) => page.getByRole('button', { name: /Why Lightning failed/ }).click() },
  { path: '/unicast', heading: 'Why Broadcast Dies at Scale', ready: 'O(1) per hop', interaction: async (page: Page) => page.getByRole('slider').fill('40') },
] as const;

test.describe('React public-site routes', () => {
  test('stay interactive and polished across public viewports', { tag: '@functional' }, async ({ browser }, testInfo: TestInfo) => {
    const viewports = [
      { name: 'wide', context: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
      { name: 'laptop', context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
      { name: 'iphone', context: devices['iPhone 15 Pro'] },
    ] as const;

    for (const viewport of viewports) {
      const context = await (browser as Browser).newContext({ ...viewport.context, ignoreHTTPSErrors: true });
      for (const route of ROUTES) {
        const page = await context.newPage();
        const issues = trackBrowserIssues(page);
        await page.goto(route.path, { waitUntil: 'networkidle' });
        await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(route.heading);
        await expect(page.getByText(route.ready, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
        await route.interaction(page);
        if (route.path === '/releases') await expect(page.getByRole('heading', { name: 'Release Notes' })).toBeVisible();
        await assertNoOverflow(page, route.path);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
        await page.screenshot({ path: testInfo.outputPath(`${route.path.slice(1)}-${viewport.name}.png`), fullPage: true, animations: 'disabled' });
        expect(issues, `${route.path} ${viewport.name} browser health`).toEqual([]);
        await page.close();
      }
      await context.close();
    }
  });
});
