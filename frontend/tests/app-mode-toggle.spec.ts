import { test, expect } from '@playwright/test';

test.describe('/app route - User/Dev mode toggle', () => {
  test('loads in user mode by default', async ({ page }) => {
    await page.goto('https://localhost:8080/app', { waitUntil: 'networkidle' });

    // Should see mode toggle button
    const toggleBtn = page.locator('.mode-toggle');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveText('Dev');

    console.log('✅ User mode loads with Dev toggle visible');
  });

  test('toggle switches to dev mode', async ({ page }) => {
    await page.goto('https://localhost:8080/app', { waitUntil: 'networkidle' });

    // Click Dev toggle
    const toggleBtn = page.locator('.mode-toggle');
    await toggleBtn.click();
    await page.waitForTimeout(1000);

    // Should show "User" button now
    await expect(toggleBtn).toHaveText('User');

    console.log('✅ Dev mode activated');
  });
});
