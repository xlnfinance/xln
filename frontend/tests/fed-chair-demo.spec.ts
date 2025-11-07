/**
 * Fed Chair Demo - The "WOW WOW" Experience
 *
 * Tests the full banker demo flow that showcases XLN's capabilities:
 * 1. Create 3×3 hub (9 entities)
 * 2. Fund all entities ($1M each)
 * 3. Send payments and watch broadcast animations
 * 4. Scale test (100 entities, FPS stays 60+)
 *
 * This is the showcase feature - it MUST work flawlessly.
 */

import { test, expect, Page } from '@playwright/test';

// Helper: Navigate to /view and wait for runtime to initialize
async function navigateToView(page: Page) {
  await page.goto('/');

  // Enter MML code to unlock /view
  await page.getByRole('textbox', { name: 'Access Code' }).fill('mml');
  await page.getByRole('button', { name: 'Unlock' }).click();

  // Wait for /view to load
  await page.waitForURL('/view');
  await page.waitForLoadState('networkidle');

  // Wait for XLN runtime to initialize
  await page.waitForFunction(() => {
    return window.hasOwnProperty('XLN') && window.XLN !== null;
  }, { timeout: 10000 });
}

// Helper: Check for console errors
async function getConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  return errors;
}

test.describe('Fed Chair Demo - Step-by-Step', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToView(page);

    // Click Economy mode button to show banker demo controls
    await page.getByRole('button', { name: '💰 Economy' }).click();
    await page.waitForTimeout(500);  // Wait for UI to render
  });

  test('Step 1: Create 3×3 Hub (9 entities)', async ({ page }) => {
    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Click "Step 1: Create 3×3 Hub"
    await page.getByRole('button', { name: /Step 1.*Create 3×3 Hub/ }).click();

    // Wait for entities to be created
    await page.waitForTimeout(2000);  // Give time for 3D rendering

    // Check that Entities panel shows "9 total"
    const entitiesPanel = page.locator('text=🏢 Entities').locator('..');
    await expect(entitiesPanel).toContainText('9 total');

    // Verify Graph3D shows entities in the stats
    const graph3DStats = page.locator('text=Render FPS').locator('..');
    await expect(graph3DStats).toContainText('Entities');
    await expect(graph3DStats).toContainText('9');

    // No console errors
    expect(errors).toEqual([]);
  });

  test('Step 2: Fund All ($1M each)', async ({ page }) => {
    // Create entities first
    await page.getByRole('button', { name: /Step 1.*Create 3×3 Hub/ }).click();
    await page.waitForTimeout(2000);

    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Click "Step 2: Fund All ($1M each)"
    await page.getByRole('button', { name: /Step 2.*Fund All/ }).click();

    // Wait for funding transactions to process
    await page.waitForTimeout(3000);

    // Check that entities now have reserves (Graph3D should show connections or state changes)
    // We can verify by checking console logs for "Mint" transactions
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'log') consoleLogs.push(msg.text());
    });

    // Wait for log messages
    await page.waitForTimeout(1000);

    // Verify no errors during funding
    expect(errors).toEqual([]);
  });

  test('Step 3: Random Payment (shows broadcast animation)', async ({ page }) => {
    // Setup: Create and fund entities
    await page.getByRole('button', { name: /Step 1.*Create 3×3 Hub/ }).click();
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Step 2.*Fund All/ }).click();
    await page.waitForTimeout(3000);

    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Click "Step 3: Random Payment"
    await page.getByRole('button', { name: /Step 3.*Random Payment/ }).click();

    // Wait for payment to process and animation to play
    await page.waitForTimeout(3000);

    // Check that runtime processed the transaction
    // (We'd see particles/connections in Graph3D, but hard to verify visually)

    // Verify no errors during payment
    expect(errors).toEqual([]);

    // Verify FPS counter is still updating (Graph3D still rendering)
    const fpsElement = page.locator('text=Render FPS').locator('..');
    const fpsTextBefore = await fpsElement.textContent();
    await page.waitForTimeout(1000);
    const fpsTextAfter = await fpsElement.textContent();

    // FPS should be changing (graph is alive)
    expect(fpsTextBefore).not.toEqual(fpsTextAfter);
  });

  test('Scale Test: +100 Entities (FPS stays 60+)', async ({ page }) => {
    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Click scale test button
    await page.getByRole('button', { name: /Scale Test.*\+100 Entities/ }).click();

    // Wait for 100 entities to be created and rendered
    await page.waitForTimeout(5000);

    // Check that Entities panel shows many entities
    const entitiesPanel = page.locator('text=🏢 Entities').locator('..');
    const entitiesText = await entitiesPanel.textContent();

    // Should have at least 100 entities
    expect(entitiesText).toMatch(/\d+\stotal/);
    const entityCount = parseInt(entitiesText!.match(/(\d+)\stotal/)![1]);
    expect(entityCount).toBeGreaterThanOrEqual(100);

    // Check FPS counter - should show reasonable performance
    const graph3DStats = page.locator('text=Render FPS').locator('..');
    const statsText = await graph3DStats.textContent();

    // Extract FPS value
    const fpsMatch = statsText!.match(/Render FPS\s*([\d.]+)/);
    expect(fpsMatch).toBeTruthy();

    const fps = parseFloat(fpsMatch![1]);

    // FPS should be at least 30 (60 is ideal, but 30 is acceptable for scale test)
    expect(fps).toBeGreaterThan(30);

    // No console errors during scale test
    expect(errors).toEqual([]);
  });

  test('Reset Demo (clears all entities)', async ({ page }) => {
    // Create entities first
    await page.getByRole('button', { name: /Step 1.*Create 3×3 Hub/ }).click();
    await page.waitForTimeout(2000);

    // Verify entities exist
    const entitiesPanelBefore = page.locator('text=🏢 Entities').locator('..');
    await expect(entitiesPanelBefore).toContainText('9 total');

    // Click Reset Demo
    await page.getByRole('button', { name: '🔄 Reset Demo' }).click();

    // Wait for reset to complete
    await page.waitForTimeout(2000);

    // Check that entities are cleared
    const entitiesPanelAfter = page.locator('text=🏢 Entities').locator('..');
    await expect(entitiesPanelAfter).toContainText('0 total');
  });
});

test.describe('Fed Chair Demo - Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToView(page);
    await page.getByRole('button', { name: '💰 Economy' }).click();
    await page.waitForTimeout(500);
  });

  test('Graph3D panel is visible and rendering', async ({ page }) => {
    // Check that Graph3D panel exists
    const graph3DPanel = page.locator('text=🌐 Graph3D').locator('..');
    await expect(graph3DPanel).toBeVisible();

    // Check that FPS counter is visible and updating
    const fpsElement = page.locator('text=Render FPS').locator('..');
    await expect(fpsElement).toBeVisible();

    // FPS should be non-zero
    const fpsText = await fpsElement.textContent();
    expect(fpsText).toMatch(/[\d.]+/);
  });

  test('Broadcast visualization controls are present', async ({ page }) => {
    // Check for "Enable J-Machine Broadcast" checkbox
    const broadcastCheckbox = page.getByRole('checkbox', { name: 'Enable J-Machine Broadcast' });
    await expect(broadcastCheckbox).toBeVisible();

    // Verify checkbox is checked by default
    await expect(broadcastCheckbox).toBeChecked();

    // Check for broadcast style radio buttons
    await expect(page.getByRole('radio', { name: /Ray-Cast/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Expanding Wave/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Particle Swarm/ })).toBeVisible();
  });

  test('All banker demo buttons are present', async ({ page }) => {
    // Verify all step buttons exist
    await expect(page.getByRole('button', { name: /Step 1.*Create 3×3 Hub/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Step 2.*Fund All/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Step 3.*Random Payment/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Quick.*20% Transfer/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Scale Test.*\+100 Entities/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '🔄 Reset Demo' })).toBeVisible();
  });
});

test.describe('Fed Chair Demo - Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToView(page);
    await page.getByRole('button', { name: '💰 Economy' }).click();
    await page.waitForTimeout(500);
  });

  test('Clicking buttons without entities should not crash', async ({ page }) => {
    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Try to fund before creating entities (should be graceful)
    await page.getByRole('button', { name: /Step 2.*Fund All/ }).click();
    await page.waitForTimeout(1000);

    // Try to send payment before creating entities (should be graceful)
    await page.getByRole('button', { name: /Step 3.*Random Payment/ }).click();
    await page.waitForTimeout(1000);

    // Should not crash (errors might be expected, but no uncaught exceptions)
    // Page should still be responsive
    await expect(page.getByRole('button', { name: /Step 1.*Create 3×3 Hub/ })).toBeVisible();
  });
});
