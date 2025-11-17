/**
 * INSPECT: Direct page state examination
 */
import { test } from '@playwright/test';

test('Inspect actual frame array', async ({ page }) => {
  await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Close modal
  const welcomeClose = page.locator('.tutorial-overlay button').first();
  if (await welcomeClose.isVisible()) {
    await welcomeClose.click();
  }

  // Run demo
  await page.getByRole('button', { name: /ELEMENTARY/ }).click();
  await page.waitForTimeout(500);
  await page.locator('button').filter({ hasText: 'Alice-Hub-Bob' }).click();
  await page.waitForTimeout(8000);

  // Get frame descriptions from actual history
  const frameData = await page.evaluate(() => {
    // Access the Svelte component's internal store
    // We need to find the actual isolated history
    const scripts = Array.from(document.querySelectorAll('script'));

    // Try to get from window if exposed
    if ((window as any).debugHistory) {
      return (window as any).debugHistory;
    }

    // Fallback: inspect DOM for frame count
    const timeline = document.querySelector('[class*="time"]');
    const timelineText = timeline?.textContent || '';

    return {
      timelineText,
      note: 'Could not access internal stores'
    };
  });

  console.log('\n=== FRAME DATA ===');
  console.log(JSON.stringify(frameData, null, 2));
});
