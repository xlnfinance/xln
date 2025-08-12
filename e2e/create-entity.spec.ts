import { test, expect } from '@playwright/test';

// Helper to select first validator as 'alice'
async function selectFirstValidatorAsAlice(page) {
  // Open the dropdown for the first validator row (data-validator-id="0")
  await page.locator('[data-validator-id="0"] .validator-selector').click();
  // Click within the options container to avoid matching other text on page
  const options = page.locator('#validatorOptions0');
  await expect(options).toBeVisible();
  await options.getByText('alice.eth', { exact: true }).click();
}

test('creates a new lazy entity via formation panel', async ({ page }) => {
  await page.goto('/');

  // Ensure formation tab is visible (default active)
  await expect(page.locator('#formationTabContent')).toBeVisible();

  // Wait for app environment to be ready
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // Jurisdiction defaults to 8545 (Ethereum). Ensure it is selected.
  const jurisdiction = page.locator('#jurisdictionSelect');
  await expect(jurisdiction).toHaveValue('8545');

  // Select lazy entity type explicitly
  await page.locator('#entityTypeSelect').selectOption('lazy');

  // Enter entity name
  const name = `PlaywrightEntity_${Date.now()}`;
  await page.locator('#entityNameInput').fill(name);

  // Capture initial replica count
  const beforeCount = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return env ? env.replicas.size : 0;
  });

  // Choose validator 'alice' for the first row
  await selectFirstValidatorAsAlice(page);

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
  expect(afterCount).toBeGreaterThan(beforeCount);

  // Visual confirmation steps for video: open history IO and first entity dropdown
  await page.locator('#historyToggle').click();
  await page.waitForTimeout(300);
  await page.locator('.entity-panels-container').evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
  const firstDropdownBtn = page.locator('.entity-panel .unified-dropdown-btn').first();
  await firstDropdownBtn.click();
  // Hold the final frame a bit so the video isn't 0:00
  await page.waitForTimeout(2000);
});


