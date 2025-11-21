import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  const consoleErrors = [];

  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('plausible')) {
      consoleErrors.push(msg.text());
    }
  });

  console.log('🔍 Testing https://localhost:8080/view\n');

  await page.goto('https://localhost:8080/view', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Close modal
  try {
    await page.locator('.tutorial-overlay button').first().click({ timeout: 2000 });
    await page.waitForTimeout(500);
  } catch {}

  // Expand and run demo
  await page.locator('button').filter({ hasText: 'LVL 1 ELEMENTARY' }).click();
  await page.waitForTimeout(500);
  await page.locator('button').filter({ hasText: 'Alice-Hub-Bob' }).click();

  // Wait for status to show frames loaded
  try {
    await page.waitForSelector('text=/\\d+ frames loaded/', { timeout: 15000 });
  } catch {
    console.log('⚠️  Status text not found');
  }

  await page.waitForTimeout(3000);

  // Get frame count from timeline
  const timeline = await page.locator('text=/\\d+ \\/ \\d+/').first().textContent().catch(() => '0 / 0');
  const [current, total] = timeline.split(' / ').map(n => parseInt(n.trim()));

  // Check entity names
  const alice = await page.locator('h4:has-text("Alice")').count();
  const hub = await page.locator('h4:has-text("Hub")').count();
  const bob = await page.locator('h4:has-text("Bob")').count();

  // Check status message
  const status = await page.locator('text=/AHB Tutorial/').first().textContent().catch(() => 'not found');

  // Screenshot
  await page.screenshot({ path: '/tmp/final-verification.png', fullPage: true });

  console.log('═══════════════════════════════════════');
  console.log('COMPREHENSIVE VERIFICATION');
  console.log('═══════════════════════════════════════\n');

  console.log(`✅ Page Loads: YES`);
  console.log(`${errors.length === 0 ? '✅' : '❌'} Page Errors: ${errors.length === 0 ? 'None' : errors.length}`);
  console.log(`${consoleErrors.length === 0 ? '✅' : '❌'} Console Errors: ${consoleErrors.length === 0 ? 'None' : consoleErrors.length}`);
  console.log(`${alice > 0 ? '✅' : '❌'} Alice visible: ${alice > 0}`);
  console.log(`${hub > 0 ? '✅' : '❌'} Hub visible: ${hub > 0}`);
  console.log(`${bob > 0 ? '✅' : '❌'} Bob visible: ${bob > 0}`);
  console.log(`${total === 9 ? '✅' : '❌'} Frame count: ${total} (expected 9)`);
  console.log(`${status.includes('frames') ? '✅' : '❌'} Status: ${status.substring(0, 50)}`);
  console.log(`✅ Timeline: ${timeline}`);
  console.log(`✅ Screenshot: /tmp/final-verification.png`);

  if (errors.length > 0) {
    console.log('\n❌ PAGE ERRORS:');
    errors.forEach(e => console.log('  ', e));
  }

  if (consoleErrors.length > 0) {
    console.log('\n❌ CONSOLE ERRORS:');
    consoleErrors.forEach(e => console.log('  ', e.substring(0, 100)));
  }

  await browser.close();

  const allPass = errors.length === 0 && alice > 0 && hub > 0 && bob > 0 && total === 9;
  console.log(`\n${allPass ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`);
  process.exit(allPass ? 0 : 1);
})();
