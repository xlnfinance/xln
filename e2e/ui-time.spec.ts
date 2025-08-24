import { test, expect } from '@playwright/test';

test('Time machine step controls and slider mapping', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/');
  await page.addInitScript(() => { (window as any).__useDistServer = true; });
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // Ensure some history: send a couple of chats
  // open dropdown and select first entity if any exists; otherwise create one quickly
  const hasReplicas = await page.evaluate(() => (window as any).xlnEnv?.replicas?.size > 0);
  if (!hasReplicas) {
    // create a quick lazy entity
    await page.locator('#entityNameInput').fill('TimeTest');
    await page.getByRole('button', { name: '➕ Add New Validator' }).click();
    const rows = page.locator('#validatorsList .validator-row');
    await rows.nth(0).locator('input').first().fill('alice');
    await rows.nth(1).locator('input').first().fill('bob');
    await page.getByRole('button', { name: 'Create Entity' }).click();
  }

  await page.waitForFunction(() => (window as any).xlnEnv?.replicas?.size > 0, undefined, { timeout: 10000 });
  // bind first panel to first replica
  const firstPanel = page.locator('#entityPanelsContainer .entity-panel').first();
  await firstPanel.scrollIntoViewIfNeeded();
  await firstPanel.locator('.unified-dropdown-btn').click();
  await firstPanel.locator('.unified-dropdown-content .dropdown-item.indent-2').first().click({ force: true });

  // produce two history frames via chat + propose
  await page.locator('#entityPanelsContainer .entity-panel').first().locator('textarea').fill('hi1');
  await page.getByRole('button', { name: 'Send Message' }).first().click();
  await page.locator('#entityPanelsContainer .entity-panel').first().locator('textarea').fill('hi2');
  await page.getByRole('button', { name: 'Propose' }).first().click();

  await page.waitForTimeout(500);

  // Slider: move to start (value 0) then step forward
  const slider = page.locator('#timeSlider');
  await slider.focus();
  await slider.fill('0');
  await page.waitForTimeout(50);
  // label should show Frame 1 /
  await expect(page.locator('.time-display')).toContainText('Frame 1');

  // step forward updates frame or moves to live
  await page.getByTitle('Forward').click();
  await page.waitForTimeout(50);
  await expect(page.locator('.time-display')).not.toHaveText('Frame 1', { timeout: 2000 });
});


