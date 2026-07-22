import { devices, expect, test, type Browser, type Page, type TestInfo } from './global-setup';

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
  expect(dimensions.document, 'install page must stay within its viewport').toBeLessThanOrEqual(dimensions.viewport);
};

const assertInstallContent = async (page: Page): Promise<void> => {
  await expect(page.getByRole('heading', { name: /Own the runtime\./ })).toBeVisible();
  await expect(page.locator('[data-testid^="install-channel-"]')).toHaveCount(5);
  await expect(page.getByTestId('install-channel-web')).toContainText('fundamental');
  await expect(page.getByTestId('install-channel-cli')).toContainText('Recommended');
  await expect(page.getByTestId('install-channel-cli').locator('code')).toHaveText(
    /bunx --bun xlnfinance@https:\/\/github\.com\/xlnfinance\/xln\/releases\/download\/v/,
  );
  await expect(page.getByTestId('install-channel-desktop')).toContainText('signed installers');
  await expect(page.getByTestId('install-channel-mobile')).toContainText('TestFlight');
  await expect(page.getByTestId('install-channel-extension')).toContainText('Developer mode');
  await expect(page.getByRole('link', { name: 'Install', exact: true })).toHaveClass(/active/);
  await assertNoHorizontalOverflow(page);
};

const openInstallPage = async (page: Page): Promise<BrowserIssue[]> => {
  const issues = trackBrowserIssues(page);
  await page.goto('/install', { waitUntil: 'networkidle' });
  await assertInstallContent(page);
  return issues;
};

test.describe('Install surface', () => {
  test(
    'shows honest availability and polished layouts on wide, laptop, and iPhone screens',
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
        const issues = await openInstallPage(page);

        await page.screenshot({
          path: testInfo.outputPath(`install-${viewport.name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        expect(issues, `${viewport.name} browser console and network must stay clean`).toEqual([]);
        await context.close();
      }
    },
  );
});
