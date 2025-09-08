import { test, expect } from '@playwright/test';

test('Unified dropdown selects entity', async ({ page }) => {
  await page.goto('http://127.0.0.1:8080/');
  await page.addInitScript(() => { (window as any).__useDistServer = true; });
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // Create a lazy entity with two validators
  await page.locator('#entityNameInput').fill('DropdownTest');
  await page.getByRole('button', { name: '➕ Add Validator' }).click();
  await page.getByRole('combobox').nth(2).selectOption('alice');
  await page.getByRole('combobox').nth(3).selectOption('bob');
  await page.getByRole('button', { name: 'Create Entity' }).click();

  // Wait replicas appear
  await page.waitForFunction(() => (window as any).xlnEnv?.replicas?.size > 0, undefined, { timeout: 10000 });

  // Open dropdown in first panel
  await page.locator('#entityPanelsContainer .entity-panel').first().locator('.unified-dropdown-btn').click();
  // Click the first selectable entity row
  await page.locator('#entityPanelsContainer .entity-panel').first().locator('.unified-dropdown-content .dropdown-item.indent-2').first().click();

  // Verify selection reflected in header text
  const text = await page.locator('#entityPanelsContainer .entity-panel').first().locator('.dropdown-text').textContent();
  expect(text || '').toContain('→');
});


