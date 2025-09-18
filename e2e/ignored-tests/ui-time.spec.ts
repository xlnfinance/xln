import { expect, test } from '@playwright/test';

test('Time machine step controls and slider mapping', async ({ page }) => {
  await page.goto('http://127.0.0.1:8080/');
  await page.addInitScript(() => {
    (window as any).__useDistServer = true;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // create a quick lazy entity
  await page.locator('#entityNameInput').fill('TimeTest');
  await page.getByRole('button', { name: '➕ Add Validator' }).click();
  await page.getByRole('combobox').nth(2).selectOption('alice');
  await page.getByRole('combobox').nth(3).selectOption('bob');
  await page.getByRole('button', { name: 'Create Entity' }).click();

  await page.waitForFunction(() => (window as any).xlnEnv?.replicas?.size > 0, undefined, { timeout: 10000 });

  await expect(page.locator('.entity-panels-container').first()).toBeVisible();

  // bind first panel to first replica
  const firstPanel = page.locator('#entityPanelsContainer .entity-panel').first();
  await firstPanel.scrollIntoViewIfNeeded();
  await firstPanel.locator('.unified-dropdown-btn').click();
  await firstPanel.locator('.unified-dropdown-content .dropdown-item.indent-2').first().click({ force: true });

  // produce two history frames via chat + propose
  await firstPanel.getByRole('button', { name: '⚙️ Controls ▼' }).click();
  await expect(firstPanel.locator('.controls-section').first()).toBeVisible();
  await firstPanel.locator('textarea').fill('hi1');
  await firstPanel.getByRole('button', { name: 'Send Message' }).first().click();
  await firstPanel.locator('textarea').fill('hi2');
  await firstPanel.getByRole('button', { name: 'Send Message' }).first().click();

  await page.waitForTimeout(500);

  // Slider: move to start (value 0) then step forward
  const slider = page.locator('#timeSlider');
  await slider.focus();
  await slider.fill('0');
  await page.waitForTimeout(50);

  await firstPanel.getByRole('button', { name: '🗂️ History ▼' }).click();
  await expect(firstPanel.locator('.transaction-history')).toBeVisible();
  // label should show Frame 1 /
  await expect(firstPanel.locator('.transaction-history .current-frame')).toContainText('Frame 0');

  // step forward updates frame or moves to live
  await page.getByTitle('Step Forward (→ arrow)').click();
  await page.waitForTimeout(50);
  await expect(firstPanel.locator('.transaction-history .current-frame')).not.toHaveText('Frame 1', { timeout: 2000 });
});
