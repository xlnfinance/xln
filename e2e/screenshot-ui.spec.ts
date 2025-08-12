import { test, expect } from '@playwright/test';

test('Capture Svelte UI layout screenshot', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/');
  await page.addInitScript(() => { (window as any).__useDistServer = true; });
  await page.reload();
  await page.waitForSelector('#entityPanelsContainer', { timeout: 30000 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: 'e2e/test-results/svelte-ui.png', fullPage: true });
  // quick assert containers exist
  const panelsCount = await page.locator('#entityPanelsContainer .entity-panel').count();
  expect(panelsCount).toBeGreaterThan(0);
});


