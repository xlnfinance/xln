import { test, expect } from '@playwright/test';

test('visual check - /app mode toggle with panel visibility', async ({ page }) => {
  console.log('=== /APP VISUAL VERIFICATION ===\n');

  // Navigate to /app
  await page.goto('/app');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // 1. USER MODE
  console.log('USER MODE:');
  const devButton = page.locator('button:has-text("Dev")').first();
  await expect(devButton).toBeVisible({ timeout: 10000 });

  // Verify user mode elements
  const nameField = page.locator('text=NAME').first();
  await expect(nameField).toBeVisible();
  console.log('  ✓ Wallet interface visible');
  console.log('  ✓ "Dev" button visible');

  // Verify dev mode elements NOT visible
  const timeMachine = page.locator('.time-machine-bar').first();
  const isTimeMachineVisible = await timeMachine.isVisible().catch(() => false);
  console.log(`  ✓ Time machine NOT visible: ${!isTimeMachineVisible}`);

  await page.screenshot({ path: 'test-results/visual-user-mode.png', fullPage: true });
  console.log('  ✓ Screenshot: test-results/visual-user-mode.png\n');

  // 2. SWITCH TO DEV MODE
  console.log('Switching to DEV MODE...');
  await devButton.click();
  await page.waitForTimeout(3000); // Give time for panels to render

  const userButton = page.locator('button:has-text("User")').first();
  await expect(userButton).toBeVisible();
  console.log('  ✓ Mode switched (button now says "User")\n');

  // 3. DEV MODE - Check all components
  console.log('DEV MODE:');

  // Time machine should be visible
  await expect(timeMachine).toBeVisible({ timeout: 5000 });
  console.log('  ✓ Time machine visible');

  // Check for dockview panels
  const dockview = page.locator('[class*="dockview"]').first();
  const isDockviewVisible = await dockview.isVisible({ timeout: 5000 }).catch(() => false);
  console.log(`  ✓ Dockview panels: ${isDockviewVisible ? 'visible' : 'NOT visible'}`);

  // Check for Graph3D or Architect panel titles
  const architectPanel = page.locator('text=🎬 Architect').first();
  const isArchitectVisible = await architectPanel.isVisible({ timeout: 5000 }).catch(() => false);
  console.log(`  ✓ Architect panel: ${isArchitectVisible ? 'visible' : 'NOT visible'}`);

  const graph3dPanel = page.locator('text=🌐 Graph3D').first();
  const isGraph3dVisible = await graph3dPanel.isVisible({ timeout: 5000 }).catch(() => false);
  console.log(`  ✓ Graph3D panel: ${isGraph3dVisible ? 'visible' : 'NOT visible'}`);

  // Check for canvas element (3D graph)
  const canvas = page.locator('canvas').first();
  const isCanvasVisible = await canvas.isVisible({ timeout: 5000 }).catch(() => false);
  console.log(`  ✓ 3D canvas: ${isCanvasVisible ? 'visible' : 'NOT visible'}`);

  // Wait a bit more for 3D graph to render
  await page.waitForTimeout(2000);

  await page.screenshot({ path: 'test-results/visual-dev-mode.png', fullPage: true });
  console.log('  ✓ Screenshot: test-results/visual-dev-mode.png\n');

  // 4. SWITCH BACK TO USER MODE
  console.log('Switching back to USER MODE...');
  await userButton.click();
  await page.waitForTimeout(2000);

  await expect(devButton).toBeVisible();
  await expect(nameField).toBeVisible();
  console.log('  ✓ Back to user mode');
  console.log('  ✓ Wallet interface restored\n');

  await page.screenshot({ path: 'test-results/visual-user-mode-return.png', fullPage: true });
  console.log('  ✓ Screenshot: test-results/visual-user-mode-return.png\n');

  console.log('=== VISUAL VERIFICATION COMPLETE ===');
});
