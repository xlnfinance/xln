import { test, expect } from '@playwright/test';

test('Svelte UI: creates a lazy entity via Formation', async ({ page }) => {
  page.on('console', (msg) => console.log('UI console:', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('UI pageerror:', err.message));
  page.on('requestfailed', (req) => console.log('UI requestfailed:', req.url(), req.failure()?.errorText));
  await page.goto('http://127.0.0.1:8080/');

  // Enable runtime server import and env init via UI helper flag
  await page.addInitScript(() => { (window as any).__useDistServer = true; });
  // Reload to apply the flag
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).xlnEnv), undefined, { timeout: 30000 });

  // Set name and threshold
  const name = `SvelteEntity_${Date.now()}`;
  await page.locator('#entityNameInput').fill(name);

  // Add a second validator and set signer names
  await page.getByRole('button', { name: '➕ Add Validator' }).click();
  await page.getByRole('combobox').nth(2).selectOption('alice');
  await page.getByRole('combobox').nth(3).selectOption('bob');

  await page.locator('#thresholdSlider').evaluate((el: HTMLInputElement) => {
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Snapshot replicas before
  const beforeCount = await page.evaluate(() => (window as any).xlnEnv?.replicas?.size ?? 0);

  await page.getByRole('button', { name: 'Create Entity' }).click();

  // Wait for increase
  await page.waitForFunction((prev) => {
    const env = (window as any).xlnEnv;
    return env && env.replicas && env.replicas.size > prev;
  }, beforeCount, { timeout: 30000 });

  // Hold for video clarity
  await page.waitForTimeout(2000);

  await expect(page.locator('.entity-panels-container').first()).toBeVisible();
});


