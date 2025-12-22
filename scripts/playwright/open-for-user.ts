#!/usr/bin/env bun
import { chromium } from 'playwright';

console.log('🚀 Opening browser for user...\n');

const browser = await chromium.launch({
  headless: false,
  slowMo: 1000,
  args: ['--ignore-certificate-errors']
});

const page = await browser.newPage({ ignoreHTTPSErrors: true });

// Log everything
page.on('console', msg => {
  const text = msg.text();
  if (text.includes('BILATERAL-SYNC') || text.includes('❌') || text.includes('[AHB]') || text.includes('[Architect]')) {
    console.log(`[BROWSER] ${text}`);
  }
});

page.on('pageerror', err => {
  console.error(`[ERROR] ${err.message}`);
});

try {
  console.log('📂 Opening https://localhost:8080/view...');
  await page.goto('https://localhost:8080/view', { timeout: 30000 });

  console.log('⏳ Waiting 5s for page load...');
  await page.waitForTimeout(5000);

  console.log('🖱️  Clicking AHB button...');
  const ahbButton = page.locator('button:has-text("Alice-Hub-Bob")').first();
  await ahbButton.click();

  console.log('✅ AHB clicked. Waiting for prepopulate (15s)...');
  await page.waitForTimeout(15000);

  console.log('🖱️  Looking for Bob entity to click...');

  // Try to find and click Bob in 3D view or entity list
  // For now, just leave browser open

  console.log('\n✅ Browser ready. Bob entity should be visible in 3D view.');
  console.log('👁️  WAITING FOR YOU - click Bob entity yourself');
  console.log('🔍 Check Bob-Hub account for red credit line');
  console.log('\n⏸️  Browser will stay open. Press Ctrl+C when done.\n');

  // Keep browser open indefinitely
  await new Promise(() => {});

} catch (error) {
  console.error('Failed:', error);
  await browser.close();
}
