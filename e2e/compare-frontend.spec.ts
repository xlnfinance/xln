import { expect, Page, test } from '@playwright/test';

async function collectLegacyMetrics(page: Page) {
  // Try root first, then explicit legacy copy as fallback
  for (const path of ['/', '/index%20copy.html']) {
    await page.goto(`http://localhost:8080${path}`);
    const panelContainer = page.locator('.entity-panel');
    const dropdownBtn = page.locator('.unified-dropdown-btn');
    const entityType = page.locator('#entityTypeSelect');
    const legacyReady = panelContainer.or(dropdownBtn).or(entityType);
    try {
      await expect(legacyReady).toBeVisible({ timeout: 12000 });
      break;
    } catch (e) {
      // try next path
      continue;
    }
  }

  const panelCount = await page
    .locator('.entity-panel')
    .count()
    .catch(() => 0);
  const hasTimeBtns = await page
    .locator('.time-btn-compact')
    .first()
    .isVisible()
    .catch(() => false);
  const hasLiveBtn = await page
    .getByRole('button', { name: /LIVE/ })
    .isVisible()
    .catch(() => false);

  await page.screenshot({ path: 'e2e/test-results/legacy-ui.png', fullPage: true });
  return { panelCount, hasTimeBtns, hasLiveBtn };
}

async function collectSvelteMetrics(page: Page) {
  await page.goto('http://127.0.0.1:5174/');
  // Svelte app signal: container and at least one panel
  await expect(page.locator('.entity-panels-container')).toBeVisible({ timeout: 20000 });
  const panelCount = await page
    .locator('.entity-panel')
    .count()
    .catch(() => 0);

  // Tabs and controls signals
  const hasFormationTab = await page
    .locator('#formationTab')
    .isVisible()
    .catch(() => false);
  const hasJurisdictionsTab = await page
    .locator('#jurisdictionsTab')
    .isVisible()
    .catch(() => false);
  const hasComponentHeaders =
    (await page
      .locator('.component-header')
      .count()
      .catch(() => 0)) > 0;

  await page.screenshot({ path: 'e2e/test-results/svelte-ui.png', fullPage: true });
  return { panelCount, hasFormationTab, hasJurisdictionsTab, hasComponentHeaders };
}

async function collectUiMetrics(page: Page) {
  await page.goto('http://localhost:5173/');
  // Panels page elements
  const panelsHeader = page.getByText('👁️ Panels', { exact: false });
  await expect(panelsHeader).toBeVisible({ timeout: 15000 });
  const panelCount = await page
    .locator('.entity-panel')
    .count()
    .catch(() => 0);
  const hasDropdown = await page
    .locator('.unified-dropdown-btn')
    .first()
    .isVisible()
    .catch(() => false);
  await page.screenshot({ path: 'e2e/test-results/ui-app.png', fullPage: true });
  return { panelCount, hasDropdown };
}

test.skip('compare svelte frontend vs ui app (smoke)', async ({ page }) => {
  const ui = await collectUiMetrics(page);

  // Use a new context/page for the second target to avoid shared state
  const context2 = await page
    .context()
    .browser()
    ?.newContext({ viewport: { width: 1920, height: 1080 } });
  const page2 = await context2!.newPage();
  const svelte = await collectSvelteMetrics(page2);

  // Minimal parity expectations
  expect(ui.panelCount).toBeGreaterThan(0);
  expect(svelte.panelCount).toBeGreaterThan(0);

  // Try a tiny time-machine interaction: click back then LIVE
  const backBtn = page2.locator('.time-btn-compact', { hasText: '⏪' });
  const liveBtn = page2.locator('.time-btn-compact.live');
  await backBtn.click({ trial: true }).catch(() => {});
  await liveBtn.click({ trial: true }).catch(() => {});

  // Log summary for quick manual review in CI logs
  console.log('UI app metrics:', ui);
  console.log('Svelte metrics:', svelte);

  // Attach summary to console; screenshots already saved in e2e/test-results
  console.log('UI compare summary:', { ui, svelte });

  await context2!.close();
});
