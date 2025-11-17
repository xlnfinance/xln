/**
 * VERIFY: Check for console errors on /view load
 */
import { test, expect } from '@playwright/test';

test('View loads without console errors', async ({ page }) => {
  const errors: string[] = [];

  page.on('pageerror', err => {
    errors.push(err.message);
  });

  await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Filter out known non-critical errors
  const criticalErrors = errors.filter(err =>
    !err.includes('WebSocket') &&
    !err.includes('plausible.io') &&
    !err.includes('ERR_BLOCKED_BY_CLIENT')
  );

  console.log('\n=== CONSOLE ERRORS ===');
  if (criticalErrors.length === 0) {
    console.log('✅ No critical errors');
  } else {
    criticalErrors.forEach(err => console.log('❌', err));
  }

  expect(criticalErrors).toHaveLength(0);
});
