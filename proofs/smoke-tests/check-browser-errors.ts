import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

// Capture console messages
page.on('console', msg => {
  console.log(`[BROWSER ${msg.type()}]:`, msg.text());
});

// Capture errors
page.on('pageerror', error => {
  console.error('[PAGE ERROR]:', error.message);
});

await page.goto('http://localhost:3000/test-browser-evm.html');

// Wait a bit to see what happens
await page.waitForTimeout(5000);

await browser.close();
