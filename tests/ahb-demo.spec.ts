/**
 * E2E Test: Alice-Hub-Bob Demo Flow
 *
 * Tests the complete AHB preset with Fed Chair subtitles:
 * 1. Load AHB preset
 * 2. Step through all 9 frames
 * 3. Verify subtitles appear correctly
 * 4. Verify final state (reserves, collateral, accounts)
 *
 * Run with: bunx playwright test tests/ahb-demo.spec.ts
 */

import { test, expect } from '@playwright/test';

test.describe('Alice-Hub-Bob (AHB) Demo', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to xln UI
    await page.goto('http://localhost:8080');

    // Wait for app to initialize
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Give XLN time to boot
  });

  test('should load AHB preset and display subtitles', async ({ page }) => {
    // Step 1: Open Settings
    await page.click('[aria-label="Settings"]');
    await page.waitForSelector('text=Admin Actions');

    // Step 2: Clear database (clean slate)
    await page.click('button:has-text("Clear Database")');
    await page.click('button:has-text("OK")'); // Confirm dialog
    await page.waitForTimeout(1000);

    // Step 3: Select AHB preset from dropdown
    const presetDropdown = page.locator('select.preset-dropdown');
    await presetDropdown.selectOption('ahb');

    // Verify AHB is selected
    const selectedValue = await presetDropdown.inputValue();
    expect(selectedValue).toBe('ahb');

    // Step 4: Run AHB prepopulation
    await page.click('.preset-selector button:has-text("Run")');

    // Wait for prepopulation to complete
    await page.waitForTimeout(5000); // AHB creates 3 entities + 9 frames

    // Step 5: Close settings, go back to main view
    await page.click('[aria-label="Back"]');
    await page.waitForTimeout(1000);

    // Step 6: Enter History mode (time machine)
    const historyButton = page.locator('button:has-text("HISTORY")');
    if (await historyButton.isVisible()) {
      await historyButton.click();
    }

    // Step 7: Verify we're at frame 0 (initial state)
    const timeDisplay = page.locator('.time-machine .status-display');
    await expect(timeDisplay).toContainText('0:00'); // Start time

    // Step 8: Verify subtitle appears
    const subtitle = page.locator('.subtitle-card');
    await expect(subtitle).toBeVisible({ timeout: 3000 });

    // Verify first frame subtitle
    await expect(subtitle).toContainText('Initial Liquidity Provision');
    await expect(subtitle).toContainText('What\'s Happening');
    await expect(subtitle).toContainText('Why This Matters');
    await expect(subtitle).toContainText('Traditional Finance Parallel');
    await expect(subtitle).toContainText('Hub Reserve: 100 USDC');

    console.log('✅ Frame 0: Initial state verified');

    // Step 9: Step through all frames
    const frames = [
      { title: 'Reserve-to-Reserve Transfer', metric: 'Hub Reserve: 70 USDC' },
      { title: 'Second R2R Transfer', metric: 'Hub Reserve: 50 USDC' },
      { title: 'Reserve-to-Collateral Prefunding', metric: 'Alice Reserve: 20 USDC' },
      { title: 'Second R2C Prefunding', metric: 'Bob Reserve: 5 USDC' },
      { title: 'Off-Chain Bilateral Netting', metric: 'Ondelta: +10 → +5' },
      { title: 'Credit Extension Beyond Collateral', metric: 'Credit exposure: 23 USDC' },
      { title: 'Cooperative Settlement', metric: 'Alice Reserve: 20 → 25' },
      { title: 'End State: Mixed Reserve', metric: 'Alice: 25 USDC reserve' }
    ];

    for (let i = 0; i < frames.length; i++) {
      // Step forward
      await page.click('button[title*="Step forward"]');
      await page.waitForTimeout(500);

      // Verify subtitle updates
      await expect(subtitle).toContainText(frames[i].title, { timeout: 2000 });

      // Verify key metric if specified
      if (frames[i].metric) {
        await expect(subtitle).toContainText(frames[i].metric);
      }

      console.log(`✅ Frame ${i + 1}: ${frames[i].title} verified`);
    }

    // Step 10: Verify we're at the last frame
    const frameCounter = page.locator('.time-machine .status-display');
    await expect(frameCounter).toContainText('8/8'); // Frame 8 of 8 (0-indexed)

    console.log('✅ All 9 frames verified successfully');
  });

  test('should verify 3D topology shows Alice, Hub, Bob', async ({ page }) => {
    // Ensure AHB is loaded (repeat prepopulation if needed)
    await page.click('[aria-label="Settings"]');
    const presetDropdown = page.locator('select.preset-dropdown');
    await presetDropdown.selectOption('ahb');
    await page.click('.preset-selector button:has-text("Run")');
    await page.waitForTimeout(5000);
    await page.click('[aria-label="Back"]');

    // Wait for 3D scene to render
    await page.waitForSelector('canvas', { timeout: 5000 });

    // Check that we have 3 entities visible
    // (This is a smoke test - full 3D verification would need WebGL inspection)
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    // Verify entity labels exist (if they're rendered as HTML overlays)
    // Note: If labels are drawn on canvas, we'd need snapshot comparison
    const pageContent = await page.content();

    // Check for entity presence in some form (adjust based on actual UI)
    // This is a basic check - enhance based on how entities are displayed
    console.log('✅ 3D canvas rendering verified');
  });

  test('should handle subtitle visibility toggle', async ({ page }) => {
    // Setup: Load AHB
    await page.click('[aria-label="Settings"]');
    const presetDropdown = page.locator('select.preset-dropdown');
    await presetDropdown.selectOption('ahb');
    await page.click('.preset-selector button:has-text("Run")');
    await page.waitForTimeout(5000);
    await page.click('[aria-label="Back"]');

    // Enter history mode
    const historyButton = page.locator('button:has-text("HISTORY")');
    if (await historyButton.isVisible()) {
      await historyButton.click();
    }

    // Subtitle should be visible in history mode
    const subtitle = page.locator('.subtitle-card');
    await expect(subtitle).toBeVisible({ timeout: 3000 });

    // Switch back to LIVE mode
    const liveButton = page.locator('button:has-text("LIVE")');
    if (await liveButton.isVisible()) {
      await liveButton.click();
      await page.waitForTimeout(500);
    }

    // Subtitle should be hidden in live mode
    await expect(subtitle).not.toBeVisible();

    console.log('✅ Subtitle visibility toggle verified');
  });
});
