import { devices, expect, test, type Browser, type Page, type TestInfo } from './global-setup.mts';

type BrowserIssue = Readonly<{ type: string; text: string }>;
type Scenario = 'full-collateral' | 'reserve-backed' | 'debt-recovery';

function trackBrowserIssues(page: Page): BrowserIssue[] {
  const issues: BrowserIssue[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push({ type: `console:${message.type()}`, text: message.text() });
    }
  });
  page.on('pageerror', (error) => issues.push({ type: 'pageerror', text: error.message }));
  page.on('requestfailed', (request) => issues.push({ type: 'requestfailed', text: `${request.url()} ${request.failure()?.errorText ?? ''}` }));
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push({ type: `http:${response.status()}`, text: response.url() });
  });
  return issues;
}

async function loadRcpan(page: Page, theme: 'dark' | 'light'): Promise<BrowserIssue[]> {
  const issues = trackBrowserIssues(page);
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('xln-settings', JSON.stringify({
      theme: selectedTheme,
      showXlnMascot: true,
    }));
  }, theme);
  await page.goto('/rcpan', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('xln-mascot-root')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A balance you can take to court.' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await pause(page);
  return issues;
}

async function pause(page: Page): Promise<void> {
  const pauseButton = page.locator('button[aria-label="Pause simulation"]');
  if (await pauseButton.isVisible()) await pauseButton.click();
}

async function restart(page: Page): Promise<void> {
  await page.locator('button[aria-label="Restart scenario"]').click();
}

async function setRange(page: Page, label: string, value: string): Promise<void> {
  const range = page.locator('.rcpan-lab label.range', { hasText: label }).locator('input[type="range"]');
  await range.evaluate((input, next) => {
    const element = input as HTMLInputElement;
    element.value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function selectScenario(page: Page, scenario: Scenario): Promise<void> {
  await page.locator('.rcpan-lab label', { hasText: /^Scenario/ }).locator('select').selectOption(scenario);
  await pause(page);
  await restart(page);
}

async function runToPhase(page: Page, scenario: Scenario, phase: string): Promise<void> {
  await selectScenario(page, scenario);
  // Keep each phase visible for a full polling interval. At 3× the shortest
  // phase lasts ~233 ms, so a busy browser can observe the label and advance
  // again before Playwright clicks Pause.
  await setRange(page, 'Playback', '1');
  await page.locator('button[aria-label="Play simulation"]').click();
  await expect(page.locator('.playback-card > span')).toContainText(phase, { timeout: 15_000 });
  await pause(page);
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  selector?: string,
  animations: 'allow' | 'disabled' = 'disabled',
): Promise<void> {
  const path = testInfo.outputPath(`${name}.jpg`);
  const image = { path, type: 'jpeg' as const, quality: 92, animations };
  if (selector) await page.locator(selector).screenshot(image);
  else await page.screenshot({ ...image, fullPage: true });
}

async function assertNoOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.document, 'page must not overflow horizontally').toBeLessThanOrEqual(dimensions.viewport);
}

async function assertMicroscopeNodesContained(page: Page): Promise<void> {
  const violations = await page.locator('.microscope-stage').evaluateAll((stages) => stages.flatMap((stage, stageIndex) => {
    const boundary = stage.getBoundingClientRect();
    return [...stage.querySelectorAll('.reserve-orbit, .node-identity')].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const clippedLeft = rect.left < boundary.left - 1;
      const clippedRight = rect.right > boundary.right + 1;
      return clippedLeft || clippedRight
        ? [{
          stageIndex,
          className: element.className,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          boundaryLeft: Math.round(boundary.left),
          boundaryRight: Math.round(boundary.right),
        }]
        : [];
    });
  }));
  expect(violations, 'reserve nodes and their captions must stay inside the microscope stage').toEqual([]);
}

async function assertHeroContentContained(page: Page): Promise<void> {
  await expect(page.locator('.sales-hero-inner')).toHaveCount(1);
  await expect(page.locator('.sales-hero-summary')).toHaveCount(1);
  await expect(page.locator('.sales-hero .sales-action')).toHaveCount(2);
  const violations = await page.locator(
    '.sales-hero-inner, .sales-hero-summary, .sales-hero .sales-action',
  ).evaluateAll((elements) => {
    const hero = document.querySelector('.sales-hero');
    if (!hero) return [{ selector: '.sales-hero', reason: 'missing' }];
    const boundary = hero.getBoundingClientRect();
    const visibleLeft = Math.max(0, boundary.left);
    const visibleRight = Math.min(window.innerWidth, boundary.right);
    return elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < visibleLeft - 1 || rect.right > visibleRight + 1
        ? [{
            selector: element.className,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            visibleLeft: Math.round(visibleLeft),
            visibleRight: Math.round(visibleRight),
          }]
        : [];
    });
  });
  expect(violations, 'hero copy and CTAs must stay inside the visible iPhone hero').toEqual([]);
}

async function assertCoreSurface(page: Page): Promise<void> {
  await expect(page.locator('.topbar-links > a')).toHaveText(['App', 'Install', 'Docs', 'RCPAN', 'Releases']);
  await expect(page.getByRole('link', { name: 'RCPAN', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.system-story')).toHaveCount(2);
  await expect(page.locator('.system-story').nth(0).locator('.reserve-node')).toHaveCount(2);
  await expect(page.locator('.system-story').nth(1).locator('.reserve-node')).toHaveCount(2);
  await expect(page.locator('.system-story').nth(0).locator('.token-lane')).toHaveCount(2);
  await expect(page.locator('.system-story').nth(1).locator('.token-lane')).toHaveCount(2);
  await expect(page.locator('.system-story').nth(0).locator('.ledger-row')).toHaveCount(2);
  await expect(page.locator('.system-story').nth(1).locator('.ledger-row')).toHaveCount(2);
  await expect(page.locator('.fcuan-story .proof-state b')).toHaveText('No shared proof');
  await expect(page.getByText('Why xln is a different kind of L2')).toBeVisible();
  await assertNoOverflow(page);
  await assertMicroscopeNodesContained(page);
}

async function newViewportPage(browser: Browser, width: number, height: number, deviceScaleFactor = 1) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, ignoreHTTPSErrors: true });
  return { page: await context.newPage(), close: () => context.close() };
}

test.describe('RCPAN dispute microscope', () => {
  test('wide and laptop show all three deterministic dispute paths', { tag: '@functional' }, async ({ browser }, testInfo) => {
    const wide = await newViewportPage(browser, 1920, 1080, 1);
    const wideIssues = await loadRcpan(wide.page, 'light');
    await assertCoreSurface(wide.page);
    await capture(wide.page, testInfo, 'wide-light-hero');

    await selectScenario(wide.page, 'full-collateral');
    await wide.page.locator('button[aria-label="Play simulation"]').click();
    await wide.page.waitForTimeout(260);
    await pause(wide.page);
    await capture(wide.page, testInfo, 'wide-light-payment-moving', '.microscope-section', 'allow');

    await runToPhase(wide.page, 'full-collateral', 'settled');
    await expect(wide.page.locator('.rcpan-story .system-number')).toContainText('$0');
    await capture(wide.page, testInfo, 'wide-light-full-collateral-settled', '.microscope-section');
    expect(wideIssues, 'wide browser console/network should be clean').toEqual([]);
    await wide.close();

    const laptop = await newViewportPage(browser, 1440, 900, 1);
    const laptopIssues = await loadRcpan(laptop.page, 'dark');
    await assertCoreSurface(laptop.page);

    await runToPhase(laptop.page, 'reserve-backed', 'finalizing');
    await capture(laptop.page, testInfo, 'laptop-dark-70-30-finalizing', '.microscope-section');

    await runToPhase(laptop.page, 'reserve-backed', 'dispute open');
    await expect(laptop.page.getByTestId('microscope-court-request').last()).toBeVisible();
    await expect(laptop.page.getByTestId('microscope-dispute-outline').last()).toBeVisible();
    await assertMicroscopeNodesContained(laptop.page);
    await capture(laptop.page, testInfo, 'laptop-dark-dispute-request', '.microscope-section');

    await runToPhase(laptop.page, 'debt-recovery', 'settled');
    await expect(laptop.page.getByTestId('microscope-debt-object').last()).toContainText('FIFO debt object');
    await capture(laptop.page, testInfo, 'laptop-dark-debt-queued', '.microscope-section');

    await runToPhase(laptop.page, 'debt-recovery', 'rebalance request 1');
    const firstReserveRequest = laptop.page.getByTestId('microscope-reserve-flow');
    await expect(firstReserveRequest).toBeVisible();
    await expect(firstReserveRequest).toContainText('Rebalance #1');
    await expect(firstReserveRequest).toContainText('request 1 of 2');
    await expect(laptop.page.locator('.rcpan-story .phase-header')).toContainText('request 1 of 2');
    await capture(laptop.page, testInfo, 'laptop-dark-rebalance-request-1', '.rcpan-story');

    await runToPhase(laptop.page, 'debt-recovery', 'rebalance request 2');
    const secondReserveRequest = laptop.page.getByTestId('microscope-reserve-flow');
    await expect(secondReserveRequest).toBeVisible();
    await expect(secondReserveRequest).toContainText('Rebalance #2');
    await expect(secondReserveRequest).toContainText('request 2 of 2');
    await expect(laptop.page.locator('.rcpan-story .phase-header')).toContainText('request 2 of 2');
    await capture(laptop.page, testInfo, 'laptop-dark-rebalance-request-2', '.rcpan-story');

    await runToPhase(laptop.page, 'debt-recovery', 'debt enforcement');
    await expect(laptop.page.getByTestId('microscope-enforce-flow')).toBeVisible();
    await capture(laptop.page, testInfo, 'laptop-dark-debt-enforcement', '.rcpan-story');

    await runToPhase(laptop.page, 'debt-recovery', 'repaid');
    await expect(laptop.page.getByTestId('microscope-debt-object').last()).toContainText('$0');
    await capture(laptop.page, testInfo, 'laptop-dark-debt-repaid', '.microscope-section');
    await capture(laptop.page, testInfo, 'laptop-dark-comparison', '.system-comparison');
    await capture(laptop.page, testInfo, 'laptop-dark-controls', '#rcpan-lab');
    expect(laptopIssues, 'laptop browser console/network should be clean').toEqual([]);
    await laptop.close();
  });

  test('iPhone stacks both worlds and keeps all controls usable', { tag: '@functional' }, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ ...devices['iPhone 15 Pro'], ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const issues = await loadRcpan(page, 'dark');
    await assertCoreSurface(page);
    await assertHeroContentContained(page);
    await capture(page, testInfo, 'iphone-dark-full-page');
    await capture(page, testInfo, 'iphone-dark-hero', '.sales-hero');

    const cards = await page.locator('.system-story').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width };
    }));
    expect(cards[1]!.y).toBeGreaterThan(cards[0]!.y);
    expect(Math.abs(cards[0]!.x - cards[1]!.x)).toBeLessThan(2);

    await runToPhase(page, 'full-collateral', 'settled');
    const mobileReserveWidths = await page.locator('.rcpan-story .reserve-node').evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('.reserve-orbit')?.getBoundingClientRect().width ?? 0),
    );
    expect(mobileReserveWidths[1]!).toBeGreaterThan(mobileReserveWidths[0]! + 5);
    await capture(page, testInfo, 'iphone-dark-reserve-size-difference', '.system-grid');

    await runToPhase(page, 'debt-recovery', 'settled');
    await capture(page, testInfo, 'iphone-dark-debt-queued', '.microscope-section');
    await capture(page, testInfo, 'iphone-dark-comparison', '.system-comparison');
    await capture(page, testInfo, 'iphone-dark-controls', '#rcpan-lab');
    await assertNoOverflow(page);
    expect(issues, 'iPhone browser console/network should be clean').toEqual([]);
    await context.close();
  });

  test('playground switches 1-4 tokens and all court placements', { tag: '@functional' }, async ({ page }, testInfo) => {
    const issues = await loadRcpan(page, 'dark');
    const tokenSelect = page.locator('.rcpan-lab label', { hasText: /^Tokens/ }).locator('select');
    const courtSelect = page.locator('.rcpan-lab label', { hasText: /^Court position/ }).locator('select');

    for (const count of ['1', '2', '3', '4']) {
      await tokenSelect.selectOption(count);
      await expect(page.locator('.rcpan-story .token-lane')).toHaveCount(Number(count));
      await expect(page.locator('.rcpan-story .ledger-row')).toHaveCount(Number(count));
    }

    for (const placement of ['top', 'bottom', 'right']) {
      await courtSelect.selectOption(placement);
      await expect(page.locator('.rcpan-story [data-court-placement]')).toHaveAttribute('data-court-placement', placement);
    }
    await page.locator('.rcpan-lab summary', { hasText: 'Color system' }).click();
    await page.getByRole('button', { name: 'Custom palette' }).click();
    const userColor = page.locator('.palette-grid label', { hasText: 'User' }).locator('input[type="color"]');
    await userColor.fill('#aa33ff');
    await expect(page.locator('.rcpan-story').last().locator('.reserve-node').first()).toHaveAttribute('style', /#aa33ff/);
    await capture(page, testInfo, 'desktop-dark-four-tokens-court-right', '.microscope-section');
    await assertNoOverflow(page);
    expect(issues, 'playground browser console/network should be clean').toEqual([]);
  });
});
