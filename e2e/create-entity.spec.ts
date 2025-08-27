import { test, expect } from '@playwright/test';

test('creates a new lazy entity via formation panel', async ({ page }) => {
  await page.goto('/');

  // Wait for app environment to be ready
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), { timeout: 30000 });

  // Navigate to Formation tab
  await page.locator('text=Formation').click();
  await page.waitForTimeout(500);

  // Capture initial replica count
  const beforeCount = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return env ? env.replicas.size : 0;
  });

  // Jurisdiction defaults to 8545 (Ethereum). Ensure it is selected.
  const jurisdiction = page.locator('#jurisdictionSelect');
  await expect(jurisdiction).toHaveValue('8545');

  // Select lazy entity type explicitly
  await page.locator('#entityTypeSelect').selectOption('lazy');

  // Enter entity name
  const name = `PlaywrightEntity_${Date.now()}`;
  await page.locator('#entityNameInput').fill(name);

  // Select validator 'alice' for the first validator row
  const firstValidatorSelect = page.locator('.validator-name').first();
  await firstValidatorSelect.selectOption('alice');

  // Ensure threshold is 1
  const threshold = page.locator('#thresholdSlider');
  await threshold.evaluate((el: HTMLInputElement) => {
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Click Create Entity button
  const createBtn = page.getByRole('button', { name: /Create Entity/i });
  await expect(createBtn).toBeVisible();
  await createBtn.click();

  // Wait for entity creation to complete
  await page.waitForTimeout(2000);

  // Verify in the app state that new replicas were imported
  // For a single validator, we expect at least +1 replica
  await page.waitForFunction(
    (prev) => {
      const env = (window as any).xlnEnv;
      return env && env.replicas && env.replicas.size > prev;
    },
    beforeCount,
    { timeout: 30000 }
  );
  
  const afterCount = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return env ? env.replicas.size : 0;
  });
  
  console.log(`✅ Entity creation test: replicas before=${beforeCount}, after=${afterCount}`);
  expect(afterCount).toBeGreaterThan(beforeCount);

  // Visual confirmation: take a screenshot for verification
  await page.screenshot({ path: 'entity-created.png', fullPage: true });
  
  // Hold the final frame a bit so the video isn't 0:00
  await page.waitForTimeout(1000);
});


