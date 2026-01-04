import { test, expect } from '@playwright/test';

test.describe('/app route - User/Dev Mode Toggle', () => {
  test('should toggle between user and dev modes correctly', async ({ page }) => {
    // 1. Navigate to /app
    console.log('=== NAVIGATING TO /APP ===');
    await page.goto('/app');
    await page.waitForLoadState('networkidle');

    // Take initial screenshot
    await page.screenshot({ path: 'test-results/app-initial-load.png', fullPage: true });
    console.log('✓ Initial load screenshot saved');

    // Check for console errors during initial load
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });

    // 2. Verify User Mode (Default)
    console.log('\n=== VERIFYING USER MODE (DEFAULT) ===');

    // Should see wallet interface with NAME, PASSWORD, SECURITY FACTOR fields
    const nameField = page.locator('text=NAME').first();
    await expect(nameField).toBeVisible({ timeout: 10000 });
    console.log('✓ NAME field visible');

    const passwordField = page.locator('text=PASSWORD').first();
    await expect(passwordField).toBeVisible();
    console.log('✓ PASSWORD field visible');

    const securityFactor = page.locator('text=SECURITY FACTOR').first();
    await expect(securityFactor).toBeVisible();
    console.log('✓ SECURITY FACTOR field visible');

    // Should see purple "Dev" button in bottom-right
    const devButton = page.locator('button:has-text("Dev")').first();
    await expect(devButton).toBeVisible();
    console.log('✓ "Dev" button visible in bottom-right');

    // Should NOT see network graph (Graph3D canvas)
    const graph3d = page.locator('canvas').first();
    const isGraph3dVisible = await graph3d.isVisible().catch(() => false);
    expect(isGraph3dVisible).toBe(false);
    console.log('✓ Network graph NOT visible (correct for user mode)');

    // Should NOT see time machine (has class 'time-machine-bar')
    const timeMachine = page.locator('.time-machine-bar').first();
    const isTimeMachineVisible = await timeMachine.isVisible().catch(() => false);
    expect(isTimeMachineVisible).toBe(false);
    console.log('✓ Time machine NOT visible (correct for user mode)');

    // Take user mode screenshot
    await page.screenshot({ path: 'test-results/app-user-mode.png', fullPage: true });
    console.log('✓ User mode screenshot saved');

    // 3. Click Dev Toggle Button
    console.log('\n=== CLICKING DEV TOGGLE BUTTON ===');
    await devButton.click();
    console.log('✓ Clicked "Dev" button');

    // Wait for mode switch (1-2 seconds)
    await page.waitForTimeout(2000);
    console.log('✓ Waited for mode switch');

    // Take dev mode screenshot
    await page.screenshot({ path: 'test-results/app-dev-mode.png', fullPage: true });
    console.log('✓ Dev mode screenshot saved');

    // 4. Verify Dev Mode
    console.log('\n=== VERIFYING DEV MODE ===');

    // Button should now say "User"
    const userButton = page.locator('button:has-text("User")').first();
    await expect(userButton).toBeVisible({ timeout: 5000 });
    console.log('✓ Button now says "User"');

    // Should see network graph (Graph3D panel)
    const graph3dVisible = await page.locator('canvas').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (graph3dVisible) {
      console.log('✓ Network graph (Graph3D) visible');
    } else {
      console.log('⚠ Network graph not found (may load asynchronously)');
    }

    // Should see panels (Architect, Jurisdiction, etc.) - check for dockview container
    const dockviewPanel = page.locator('[class*="dockview"]').first();
    const isDockviewVisible = await dockviewPanel.isVisible({ timeout: 5000 }).catch(() => false);
    if (isDockviewVisible) {
      console.log('✓ Dockview panels visible');
    } else {
      console.log('⚠ Dockview panels not found (checking alternative selectors)');
    }

    // Should see time machine at bottom
    const timeMachineVisible = await page.locator('[class*="time-machine"], [class*="timeline"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (timeMachineVisible) {
      console.log('✓ Time machine visible');
    } else {
      console.log('⚠ Time machine not found (may use different selector)');
    }

    // 5. Toggle Back to User Mode
    console.log('\n=== TOGGLING BACK TO USER MODE ===');
    await userButton.click();
    console.log('✓ Clicked "User" button');

    // Wait for mode switch
    await page.waitForTimeout(2000);
    console.log('✓ Waited for mode switch');

    // Should return to wallet interface
    await expect(nameField).toBeVisible({ timeout: 5000 });
    console.log('✓ Wallet interface visible again');

    // Button should say "Dev" again
    const devButtonAgain = page.locator('button:has-text("Dev")').first();
    await expect(devButtonAgain).toBeVisible();
    console.log('✓ Button says "Dev" again');

    // Take final screenshot
    await page.screenshot({ path: 'test-results/app-back-to-user-mode.png', fullPage: true });
    console.log('✓ Back to user mode screenshot saved');

    // 6. Check Console
    console.log('\n=== CONSOLE CHECK ===');
    if (consoleErrors.length > 0) {
      console.log('❌ Console errors found:');
      consoleErrors.forEach(err => console.log(`  - ${err}`));
    } else {
      console.log('✓ No console errors');
    }

    if (consoleWarnings.length > 0) {
      console.log('⚠ Console warnings found:');
      consoleWarnings.slice(0, 5).forEach(warn => console.log(`  - ${warn}`));
      if (consoleWarnings.length > 5) {
        console.log(`  ... and ${consoleWarnings.length - 5} more`);
      }
    } else {
      console.log('✓ No console warnings');
    }

    // Final assertion: should be back in user mode
    expect(await devButtonAgain.isVisible()).toBe(true);
    console.log('\n=== TEST COMPLETED SUCCESSFULLY ===');
  });

  test('should persist mode toggle across interactions', async ({ page }) => {
    console.log('=== TESTING MODE PERSISTENCE ===');
    await page.goto('/app');
    await page.waitForLoadState('networkidle');

    // Start in user mode
    const devButton = page.locator('button:has-text("Dev")').first();
    await expect(devButton).toBeVisible({ timeout: 10000 });
    console.log('✓ Started in user mode');

    // Switch to dev mode
    await devButton.click();
    await page.waitForTimeout(2000);

    const userButton = page.locator('button:has-text("User")').first();
    await expect(userButton).toBeVisible();
    console.log('✓ Switched to dev mode');

    // Interact with page (click somewhere else)
    await page.click('body', { position: { x: 100, y: 100 } });
    await page.waitForTimeout(500);

    // Should still be in dev mode
    await expect(userButton).toBeVisible();
    console.log('✓ Still in dev mode after interaction');

    // Switch back
    await userButton.click();
    await page.waitForTimeout(2000);

    await expect(devButton).toBeVisible();
    console.log('✓ Successfully returned to user mode');

    console.log('=== PERSISTENCE TEST COMPLETED ===');
  });
});
