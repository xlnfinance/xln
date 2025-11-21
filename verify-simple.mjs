import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Close tutorial modal if present
  const closeButton = page.locator('.tutorial-overlay button').first();
  if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeButton.click();
    await page.waitForTimeout(500);
  }

  // Click through to AHB demo
  await page.locator('button').filter({ hasText: 'LVL 1 ELEMENTARY' }).click();
  await page.waitForTimeout(500);
  await page.locator('button').filter({ hasText: 'Alice-Hub-Bob' }).click();

  // Wait for demo to complete (status text changes)
  await page.waitForSelector('text=/AHB Tutorial.*frames loaded/', { timeout: 12000 });
  await page.waitForTimeout(2000);

  // Check entity names
  const alice = await page.locator('h4').filter({ hasText: /^Alice$/ }).count();
  const hub = await page.locator('h4').filter({ hasText: /^Hub$/ }).count();
  const bob = await page.locator('h4').filter({ hasText: /^Bob$/ }).count();

  // Check frame count
  const timeline = await page.locator('text=/\\d+ \\/ \\d+/').first().textContent();
  const frames = timeline?.match(/\/ (\d+)/)?.[1];

  console.log('\n══════════════════════════════════════');
  console.log('VERIFICATION RESULTS');
  console.log('══════════════════════════════════════');
  console.log(`Entity Names: Alice=${alice > 0 ? '✅' : '❌'} Hub=${hub > 0 ? '✅' : '❌'} Bob=${bob > 0 ? '✅' : '❌'}`);
  console.log(`Frame Count: ${frames} (expected 9) ${frames === '9' ? '✅' : '❌'}`);
  console.log(`Page Errors: ${errors.length === 0 ? '✅ None' : '❌ ' + errors.length}`);

  if (errors.length > 0) {
    console.log('\nERRORS:');
    errors.forEach(e => console.log('  -', e.substring(0, 100)));
  }

  await browser.close();

  const allPassed = alice > 0 && hub > 0 && bob > 0 && frames === '9' && errors.length === 0;
  process.exit(allPassed ? 0 : 1);
})();
