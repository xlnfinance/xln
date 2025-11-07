/**
 * Landing Page Smoke Test
 *
 * CRITICAL: This test MUST pass before any deploy.
 * Landing page is the public face - it must work flawlessly.
 */

import { test, expect } from '@playwright/test';

test.describe('Landing Page - Critical Elements', () => {
  test('should load and display centered Modular Contract System heading', async ({ page }) => {
    // Visit landing page (assumes landing hasn't been unlocked yet)
    await page.goto('/');

    // Wait for page to load
    await page.waitForLoadState('domcontentloaded');

    // Check heading exists
    const heading = page.locator('h2:has-text("Modular Contract System")');
    await expect(heading).toBeVisible();

    // Verify heading is centered
    const headingBox = await heading.boundingBox();
    expect(headingBox).not.toBeNull();

    // Get parent section width
    const section = heading.locator('xpath=ancestor::*[contains(@class, "section")]');
    const sectionBox = await section.boundingBox();
    expect(sectionBox).not.toBeNull();

    // Check that heading is roughly centered (within 10% tolerance)
    if (headingBox && sectionBox) {
      const headingCenter = headingBox.x + headingBox.width / 2;
      const sectionCenter = sectionBox.x + sectionBox.width / 2;
      const tolerance = sectionBox.width * 0.1;

      expect(Math.abs(headingCenter - sectionCenter)).toBeLessThan(tolerance);
    }
  });

  test('should display slot machine contracts section', async ({ page }) => {
    await page.goto('/');

    // Check that all three contract slots are visible
    await expect(page.locator('text=PLUGGABLE').first()).toBeVisible();
    await expect(page.locator('text=⭐ CORE ⭐')).toBeVisible();
    await expect(page.locator('text=Depository.sol')).toBeVisible();
    await expect(page.locator('text=EntityProvider.sol')).toBeVisible();
    await expect(page.locator('text=SubcontractProvider.sol')).toBeVisible();
  });

  test('should have working MML unlock functionality', async ({ page }) => {
    await page.goto('/');

    // Find invite input
    const input = page.locator('input.invite-input');
    await expect(input).toBeVisible();

    // Type MML and submit
    await input.fill('mml');
    await page.locator('button:has-text("Unlock")').click();

    // Should navigate to /view
    await page.waitForURL('/view', { timeout: 5000 });
    expect(page.url()).toContain('/view');
  });

  test('should not have broken images or missing assets', async ({ page }) => {
    await page.goto('/');

    // Check for 404 errors in network requests
    const failedRequests: string[] = [];

    page.on('response', response => {
      if (response.status() === 404) {
        failedRequests.push(response.url());
      }
    });

    // Wait for page to fully load
    await page.waitForLoadState('networkidle');

    // Fail test if any 404s were found
    expect(failedRequests).toEqual([]);
  });

  test('should be responsive and not overflow horizontally', async ({ page }) => {
    // Test at common viewport sizes
    const viewports = [
      { width: 375, height: 667 },  // Mobile (iPhone SE)
      { width: 768, height: 1024 }, // Tablet
      { width: 1920, height: 1080 } // Desktop
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/');

      // Check for horizontal scrollbar (indicates overflow)
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });

      expect(hasHorizontalScroll).toBe(false);
    }
  });
});
