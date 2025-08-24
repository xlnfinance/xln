import { test, expect } from '@playwright/test';

test('Panels add/clone/remove and 1..4 layout', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/');
  await page.addInitScript(() => { (window as any).__useDistServer = true; });
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // initial 4
  await expect(page.locator('#entityPanelsContainer .entity-panel')).toHaveCount(4);

  // close one -> 3
  await page.locator('#entityPanelsContainer .entity-panel').nth(3).getByTitle('Close').click();
  await expect(page.locator('#entityPanelsContainer .entity-panel')).toHaveCount(3);

  // select an entity in first panel to enable cloning with same selection
  await page.locator('#entityPanelsContainer .entity-panel').first().locator('.unified-dropdown-btn').click();
  await page.locator('#entityPanelsContainer .entity-panel').first().locator('.unified-dropdown-content .dropdown-item.indent-2').first().click();
  const selectedHeader = await page.locator('#entityPanelsContainer .entity-panel').first().locator('.dropdown-text').textContent();

  // clone -> 4 panels
  await page.locator('#entityPanelsContainer .entity-panel').first().getByTitle('Clone').click();
  await expect(page.locator('#entityPanelsContainer .entity-panel')).toHaveCount(4);
  const clonedHeader = await page.locator('#entityPanelsContainer .entity-panel').nth(3).locator('.dropdown-text').textContent();
  expect((clonedHeader || '').trim()).toBe((selectedHeader || '').trim());
});


