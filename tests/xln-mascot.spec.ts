import { devices, expect, test, type Browser, type Page, type TestInfo } from './global-setup';

type BrowserIssue = Readonly<{ type: string; text: string }>;
const REAL_AI = process.env['XLN_REAL_AI_E2E'] === '1';

function trackIssues(page: Page): BrowserIssue[] {
  const issues: BrowserIssue[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push({ type: `console:${message.type()}`, text: message.text() });
    }
  });
  page.on('pageerror', error => issues.push({ type: 'pageerror', text: error.message }));
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText ?? '';
    if (errorText === 'net::ERR_ABORTED') return;
    issues.push({ type: 'requestfailed', text: `${request.url()} ${errorText}` });
  });
  page.on('response', response => {
    if (response.status() >= 400) issues.push({ type: `http:${response.status()}`, text: response.url() });
  });
  return issues;
}

async function loadMascot(page: Page, theme: 'dark' | 'light', show = true): Promise<BrowserIssue[]> {
  const issues = trackIssues(page);
  await page.addInitScript(({ selectedTheme, visible }) => {
    localStorage.setItem('xln-auth-scheme', selectedTheme);
    if (!localStorage.getItem('xln-settings')) {
      localStorage.setItem('xln-settings', JSON.stringify({
        theme: selectedTheme,
        showXlnMascot: visible,
        xlnMascotDock: { version: 1, side: 'right', offsetRatio: 0.72 },
      }));
    }
  }, { selectedTheme: theme, visible: show });
  await page.goto('/app?locktest=1&scenarioPreview=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate(selectedTheme => document.documentElement.setAttribute('data-theme', selectedTheme), theme);
  const authRoot = page.locator('.brainvault-wrapper');
  if (theme === 'light') await expect(authRoot).toHaveClass(/scheme-light/);
  else await expect(authRoot).not.toHaveClass(/scheme-light/);
  if (show) {
    const root = page.getByTestId('xln-mascot-root');
    await expect(root).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => root.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.top >= 0 &&
        rect.right <= innerWidth && rect.bottom <= innerHeight;
    })).toBe(true);
  }
  return issues;
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage = true,
  animations: 'allow' | 'disabled' = 'disabled',
): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage, animations });
}

async function assertInsideViewport(page: Page, selector: string): Promise<void> {
  const geometry = await page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
}

async function newPage(browser: Browser, width: number, height: number, theme: 'dark' | 'light') {
  const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, colorScheme: theme });
  return { page: await context.newPage(), close: () => context.close() };
}

test.describe('xln mascot assistant', () => {
  test('drags, docks, persists, and exposes an honest assistant state', { tag: '@functional' }, async ({ browser }, testInfo) => {
    const wide = await newPage(browser, 1920, 1080, 'light');
    const issues = await loadMascot(wide.page, 'light');
    const root = wide.page.getByTestId('xln-mascot-root');
    await expect(root).toHaveAttribute('data-dock-side', 'right');
    await capture(wide.page, testInfo, 'wide-light-mascot-idle-right');

    const box = await wide.page.getByTestId('xln-mascot-toggle').boundingBox();
    expect(box).not.toBeNull();
    await wide.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await wide.page.mouse.down();
    await wide.page.mouse.move(24, 420, { steps: 12 });
    await wide.page.mouse.up();
    await expect(root).toHaveAttribute('data-dock-side', 'left');
    await wide.page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    // Holding a pointer during Chromium capture can omit compositor tiles. Capture
    // the deterministic drop result at viewport size after the next painted frame.
    await capture(wide.page, testInfo, 'wide-light-mascot-dragging', false, 'allow');
    await expect(wide.page.getByTestId('xln-mascot-chat')).toHaveCount(0);

    const stored = await wide.page.evaluate(() => JSON.parse(localStorage.getItem('xln-settings') || '{}'));
    expect(stored.xlnMascotDock.side).toBe('left');
    await wide.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(root).toHaveAttribute('data-dock-side', 'left');

    await wide.page.getByTestId('xln-mascot-toggle').click();
    const chat = wide.page.getByTestId('xln-mascot-chat');
    await expect(chat).toBeVisible();
    await expect(chat).toContainText(/Local AI · public docs|Local AI offline/, { timeout: 10_000 });
    await expect(wide.page.getByTestId('xln-mascot-input')).toBeFocused();
    await assertInsideViewport(wide.page, '[data-testid="xln-mascot-chat"]');
    const positions = await wide.page.evaluate(() => {
      const mascot = document.querySelector('[data-testid="xln-mascot-root"]')!.getBoundingClientRect();
      const panel = document.querySelector('[data-testid="xln-mascot-chat"]')!.getBoundingClientRect();
      return { mascotRight: mascot.right, panelLeft: panel.left };
    });
    expect(positions.panelLeft).toBeGreaterThan(positions.mascotRight);
    const assistantReady = await chat.getByText('Local AI · public docs').isVisible();
    await capture(wide.page, testInfo, `wide-light-mascot-chat-left-${assistantReady ? 'ready' : 'offline'}`, false);

    await wide.page.getByTestId('xln-mascot-input').press('Escape');
    await expect(chat).toHaveCount(0);
    await expect(wide.page.getByTestId('xln-mascot-toggle')).toBeFocused();
    expect(issues).toEqual([]);
    await wide.close();
  });

  test('supports keyboard docking, hidden persistence, and reduced motion', { tag: '@functional' }, async ({ browser }, testInfo) => {
    const reducedContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
    });
    const page = await reducedContext.newPage();
    const issues = await loadMascot(page, 'dark');
    const toggle = page.getByTestId('xln-mascot-toggle');
    await toggle.focus();
    await toggle.press('Alt+ArrowUp');
    await expect(page.getByTestId('xln-mascot-root')).toHaveAttribute('data-dock-side', 'top');
    await toggle.press('ArrowRight');
    await expect(page.getByTestId('xln-mascot-root')).toHaveAttribute('data-offset', '0.7700');
    const animation = await page.locator('.logo-stage').evaluate(element => getComputedStyle(element).animationName);
    expect(animation).toBe('none');
    await page.getByTestId('xln-mascot-toggle').click();
    await expect(page.getByTestId('xln-mascot-chat')).toBeVisible();
    await capture(page, testInfo, 'laptop-dark-reduced-motion-chat');
    await page.getByTestId('xln-mascot-close').click();

    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('xln-settings') || '{}');
      settings.showXlnMascot = false;
      localStorage.setItem('xln-settings', JSON.stringify(settings));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('xln-mascot-root')).toHaveCount(0);
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('xln-settings') || '{}');
      settings.showXlnMascot = true;
      localStorage.setItem('xln-settings', JSON.stringify(settings));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('xln-mascot-root')).toBeVisible();
    expect(issues).toEqual([]);
    await reducedContext.close();
  });

  test('fits the logo and open chat on iPhone in dark and light themes', { tag: '@functional' }, async ({ browser }, testInfo) => {
    const darkContext = await browser.newContext({ ...devices['iPhone 15 Pro'], ignoreHTTPSErrors: true, colorScheme: 'dark' });
    const darkPage = await darkContext.newPage();
    const darkIssues = await loadMascot(darkPage, 'dark');
    const toggle = darkPage.getByTestId('xln-mascot-toggle');
    const target = await toggle.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    await capture(darkPage, testInfo, 'iphone-dark-mascot-right');
    await toggle.click();
    await expect(darkPage.getByTestId('xln-mascot-chat')).toBeVisible();
    await assertInsideViewport(darkPage, '[data-testid="xln-mascot-chat"]');
    await capture(darkPage, testInfo, 'iphone-dark-mascot-chat-open');
    expect(darkIssues).toEqual([]);
    await darkContext.close();

    const lightContext = await browser.newContext({ ...devices['iPhone 15 Pro'], ignoreHTTPSErrors: true, colorScheme: 'light' });
    const lightPage = await lightContext.newPage();
    const lightIssues = await loadMascot(lightPage, 'light');
    const lightToggle = lightPage.getByTestId('xln-mascot-toggle');
    await lightToggle.focus();
    await lightToggle.press('Alt+ArrowUp');
    await expect(lightPage.getByTestId('xln-mascot-root')).toHaveAttribute('data-dock-side', 'top');
    await assertInsideViewport(lightPage, '[data-testid="xln-mascot-root"]');
    await capture(lightPage, testInfo, 'iphone-light-mascot-top');
    expect(lightIssues).toEqual([]);
    await lightContext.close();
  });

  test('renders model Markdown without executable or malformed links', { tag: '@resilience' }, async ({ page }, testInfo) => {
    await page.route('**/api/assistant/models', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'local',
        available: true,
        defaultModel: 'qwen3-coder:latest',
        models: [{ id: 'qwen3-coder:latest', name: 'Qwen' }],
      }),
    }));
    await page.route('**/api/assistant/chat', route => route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      body: [
        'data: {"content":"**Safe answer.** [broken](http://[) [blocked](javascript:window.__xlnMascotXss=1) <img src=x onerror=window.__xlnMascotXss=2>"}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
    }));

    const issues = await loadMascot(page, 'dark');
    await page.getByTestId('xln-mascot-toggle').click();
    await page.getByTestId('xln-mascot-input').fill('Explain safely');
    await page.getByTestId('xln-mascot-submit').click();
    const answer = page.getByTestId('xln-mascot-chat').locator('article.assistant .message-markdown');
    await expect(answer.locator('strong')).toHaveText('Safe answer.');
    await expect(answer.locator('img, script, iframe, svg')).toHaveCount(0);
    await expect(answer.locator('a[href]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as typeof window & { __xlnMascotXss?: number }).__xlnMascotXss)).toBeUndefined();
    await capture(page, testInfo, 'laptop-dark-sanitized-markdown');
    expect(issues).toEqual([]);
  });

  test('streams a real docs-grounded answer through the production proxy', { tag: '@functional' }, async ({ page }, testInfo) => {
    // XLN_ALLOW_SKIP: requires the explicitly enabled external local AI service.
    test.skip(!REAL_AI, 'Set XLN_REAL_AI_E2E=1 with the local xln AI service running.');
    const issues = await loadMascot(page, 'dark');
    await page.getByTestId('xln-mascot-toggle').click();
    await expect(page.getByText('Local AI · public docs')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'What am I looking at?' }).click();
    await expect(page.getByTestId('xln-mascot-root')).toHaveAttribute('data-presence-state', 'thinking');
    await capture(page, testInfo, 'laptop-dark-real-ai-thinking');
    const answer = page.getByTestId('xln-mascot-chat').locator('article.assistant .message-markdown');
    await expect(answer).not.toHaveText('Thinking…', { timeout: 120_000 });
    await expect(answer).not.toBeEmpty();
    await expect(page.getByTestId('xln-mascot-root')).toHaveAttribute('data-presence-state', 'ready');
    await capture(page, testInfo, 'laptop-dark-real-ai-answer');
    expect(issues).toEqual([]);
  });
});
