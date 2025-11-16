/**
 * SMOKE TEST: Alice-Hub-Bob Demo - Core Functionality
 *
 * Verifies critical path:
 * 1. AHB demo launches
 * 2. Creates Alice, Hub, Bob (NOT bank names!)
 * 3. Generates 9 frames (not 18/19!)
 * 4. Subtitles exist in frames
 *
 * Run: bunx playwright test tests/smoke/ahb-core.spec.ts
 */

import { test, expect } from '@playwright/test';

test.describe('AHB Demo - Critical Path', () => {
  test('AHB creates Alice/Hub/Bob with 9 frames', async ({ page }) => {
    // Navigate to /view
    await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Close welcome modal
    const welcomeClose = page.locator('.tutorial-overlay button').first();
    if (await welcomeClose.isVisible()) {
      await welcomeClose.click();
    }

    // Expand LVL 1 ELEMENTARY
    await page.getByRole('button', { name: /ELEMENTARY/ }).click();
    await page.waitForTimeout(500);

    // Click Alice-Hub-Bob
    await page.getByRole('button', { name: /Alice-Hub-Bob/ }).click();
    await page.waitForTimeout(6000); // Wait for prepopulate to complete

    // VERIFICATION 1: Entity count
    const entityCount = await page.evaluate(() => {
      return window.XLN?.isolatedEnv?.replicas?.size || 0;
    });
    expect(entityCount).toBe(3); // Should be exactly 3 entities

    // VERIFICATION 2: Frame count
    const frameCount = await page.evaluate(() => {
      return window.XLN?.isolatedEnv?.history?.length || 0;
    });
    expect(frameCount).toBe(9); // Should be exactly 9 frames

    // VERIFICATION 3: Entity names (NOT bank names!)
    const entityNames = await page.evaluate(() => {
      const replicas = window.XLN?.isolatedEnv?.replicas || new Map();
      const keys = Array.from(replicas.keys());

      // Get entity names from replica keys or IDs
      const names = keys.map(key => {
        const parts = key.split(':');
        return parts[0]; // entityId part
      });

      return names;
    });

    // Should NOT contain "Bank of America" or similar
    const hasBankNames = entityNames.some(name =>
      name.includes('Bank of America') ||
      name.includes('Wells Fargo') ||
      name.includes('Citi')
    );
    expect(hasBankNames).toBe(false);

    // VERIFICATION 4: Subtitle data exists
    const firstFrameHasSubtitle = await page.evaluate(() => {
      const frames = window.XLN?.isolatedEnv?.history || [];
      return !!frames[0]?.subtitle;
    });
    expect(firstFrameHasSubtitle).toBe(true);

    // VERIFICATION 5: Subtitle structure
    const subtitleData = await page.evaluate(() => {
      const frames = window.XLN?.isolatedEnv?.history || [];
      return frames[0]?.subtitle;
    });

    expect(subtitleData).toBeDefined();
    expect(subtitleData).toHaveProperty('title');
    expect(subtitleData).toHaveProperty('what');
    expect(subtitleData).toHaveProperty('why');
    expect(subtitleData).toHaveProperty('tradfiParallel');

    console.log('✅ SMOKE TEST PASSED!');
    console.log(`   Entities: ${entityCount}`);
    console.log(`   Frames: ${frameCount}`);
    console.log(`   Subtitle title: ${subtitleData.title}`);
  });

  test('Status message shows correct frame count', async ({ page }) => {
    await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Close welcome modal
    const welcomeClose = page.locator('.tutorial-overlay button').first();
    if (await welcomeClose.isVisible()) {
      await welcomeClose.click();
    }

    // Expand and click AHB
    await page.getByRole('button', { name: /ELEMENTARY/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Alice-Hub-Bob/ }).click();
    await page.waitForTimeout(6000);

    // Check status message
    const statusText = await page.locator('.action-section p, [class*="status"], [class*="action"]').filter({ hasText: /frames loaded/ }).first().textContent();

    // Should contain "9 frames" not "18 frames" or "19 frames"
    expect(statusText).toContain('9 frames');
    expect(statusText).not.toContain('18 frames');
    expect(statusText).not.toContain('19 frames');
  });
});
