import { test, expect } from '@playwright/test';

test.describe('/app route - User/Dev mode toggle', () => {
  test('loads in user mode by default', async ({ page }) => {
    await page.goto('https://localhost:8080/app');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Should see BrainVault interface (user mode)
    const title = await page.title();
    expect(title).toContain('Wallet');

    // Should see mode toggle button
    const toggleBtn = page.locator('.mode-toggle');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveText('Dev');

    console.log('✅ User mode loads correctly');
  });

  test('toggle switches to dev mode', async ({ page }) => {
    await page.goto('https://localhost:8080/app');
    await page.waitForLoadState('networkidle');

    // Click Dev toggle
    const toggleBtn = page.locator('.mode-toggle');
    await toggleBtn.click();

    // Wait for mode switch
    await page.waitForTimeout(500);

    // Should show "User" button now
    await expect(toggleBtn).toHaveText('User');

    // Title should change
    const title = await page.title();
    expect(title).toContain('Network');

    // Should see Graph3D or dev panels
    const dockview = page.locator('.view-container');
    await expect(dockview).toBeVisible();

    console.log('✅ Dev mode activated');
  });

  test('toggle back to user mode', async ({ page }) => {
    await page.goto('https://localhost:8080/app');
    await page.waitForLoadState('networkidle');

    // Switch to dev
    await page.locator('.mode-toggle').click();
    await page.waitForTimeout(500);

    // Switch back to user
    await page.locator('.mode-toggle').click();
    await page.waitForTimeout(500);

    // Should show Dev button again
    const toggleBtn = page.locator('.mode-toggle');
    await expect(toggleBtn).toHaveText('Dev');

    console.log('✅ Mode toggle works both ways');
  });
});
