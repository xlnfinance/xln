/**
 * DEBUG: Capture console logs to find why 18 frames instead of 9
 */
import { test, expect } from '@playwright/test';

test('Debug frame count with console logs', async ({ page }) => {
  const logs: string[] = [];

  // Capture all console messages
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[Architect]') || text.includes('[AHB]') || text.includes('Snapshot')) {
      logs.push(text);
    }
  });

  await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Close welcome modal
  const welcomeClose = page.locator('.tutorial-overlay button').first();
  if (await welcomeClose.isVisible()) {
    await welcomeClose.click();
  }

  // Expand LVL 1
  await page.getByRole('button', { name: /ELEMENTARY/ }).click();
  await page.waitForTimeout(500);

  // Click Alice-Hub-Bob
  console.log('DEBUG: Clicking Alice-Hub-Bob button...');
  const ahbButton = page.locator('button').filter({ hasText: 'Alice-Hub-Bob' });
  await ahbButton.click();
  console.log('DEBUG: Button clicked, waiting...');
  await page.waitForTimeout(8000);

  // Take screenshot for debugging
  await page.screenshot({ path: '/tmp/debug-ahb.png', fullPage: true });
  console.log('DEBUG: Screenshot saved to /tmp/debug-ahb.png');

  // Check actual frame count via DOM inspection
  const statusText = await page.locator('p').filter({ hasText: /frames loaded/ }).first().textContent().catch(() => 'not found');
  console.log(`DEBUG: Status text: ${statusText}`);

  // Print all captured logs
  console.log('\n=== CAPTURED CONSOLE LOGS ===');
  logs.forEach(log => console.log(log));
  console.log('=== END LOGS ===\n');

  // Count how many times prepopulateAHB was called
  const prepopulateCalls = logs.filter(l => l.includes('Calling prepopulateAHB')).length;
  const returnCalls = logs.filter(l => l.includes('prepopulateAHB returned')).length;
  const snapshotCalls = logs.filter(l => l.includes('📸 Snapshot:')).length;

  console.log(`\n📊 STATISTICS:`);
  console.log(`   prepopulateAHB called: ${prepopulateCalls} times`);
  console.log(`   prepopulateAHB returned: ${returnCalls} times`);
  console.log(`   Snapshots created: ${snapshotCalls}`);

  // Get final frame count
  const frameCount = logs
    .filter(l => l.includes('AFTER prepopulate: replicas'))
    .pop()
    ?.match(/history = (\d+)/)?.[1];

  console.log(`   Final history length: ${frameCount || 'unknown'}`);
});
