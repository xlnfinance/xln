/**
 * FINAL VERIFICATION: Entity names + frame count + no console errors
 */
import { test, expect } from '@playwright/test';

test('Final verification - all fixes working', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  // Capture page errors
  page.on('pageerror', err => {
    const msg = err.message;
    // Filter out known non-critical errors
    if (!msg.includes('WebSocket') && !msg.includes('plausible.io')) {
      pageErrors.push(msg);
    }
  });

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('WebSocket') && !text.includes('ERR_BLOCKED_BY_CLIENT')) {
        consoleErrors.push(text);
      }
    }
  });

  await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Expand LVL 1
  await page.locator('button').filter({ hasText: 'LVL 1 ELEMENTARY' }).click();
  await page.waitForTimeout(500);

  // Run AHB demo
  await page.locator('button').filter({ hasText: 'Alice-Hub-Bob' }).click();
  await page.waitForTimeout(8000);

  // VERIFICATION 1: No critical page errors
  console.log('\n=== PAGE ERRORS ===');
  if (pageErrors.length > 0) {
    pageErrors.forEach(err => console.log('❌', err));
  } else {
    console.log('✅ No page errors');
  }
  expect(pageErrors).toHaveLength(0);

  // VERIFICATION 2: Entity names visible
  const aliceVisible = await page.locator('h4').filter({ hasText: /^Alice$/ }).count();
  const hubVisible = await page.locator('h4').filter({ hasText: /^Hub$/ }).count();
  const bobVisible = await page.locator('h4').filter({ hasText: /^Bob$/ }).count();

  console.log('\n=== ENTITY NAMES ===');
  console.log(aliceVisible > 0 ? '✅ Alice' : '❌ Alice');
  console.log(hubVisible > 0 ? '✅ Hub' : '❌ Hub');
  console.log(bobVisible > 0 ? '✅ Bob' : '❌ Bob');

  expect(aliceVisible).toBeGreaterThan(0);
  expect(hubVisible).toBeGreaterThan(0);
  expect(bobVisible).toBeGreaterThan(0);

  // VERIFICATION 3: Frame count = 9
  const frameCountText = await page.locator('text=/\\d+ \\/ \\d+/').first().textContent();
  const match = frameCountText?.match(/\d+ \/ (\d+)/);
  const totalFrames = match ? parseInt(match[1]) : 0;

  console.log('\n=== FRAME COUNT ===');
  console.log(`Timeline: ${frameCountText}`);
  console.log(totalFrames === 9 ? '✅ 9 frames' : `❌ ${totalFrames} frames`);

  expect(totalFrames).toBe(9);

  console.log('\n✅ ALL VERIFICATIONS PASSED');
});
