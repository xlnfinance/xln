import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', err => errors.push(err.message));

try {
  await page.goto('https://localhost:8080/view', { 
    waitUntil: 'networkidle',
    timeout: 30000
  });
  
  console.log('Page loaded');
  await page.waitForTimeout(2000);
  
  const ahb = page.locator('text=Alice-Hub-Bob').first();
  if (await ahb.isVisible()) {
    console.log('Clicking AHB...');
    await ahb.click();
    await page.waitForTimeout(4000);
  } else {
    console.log('AHB not visible');
  }
  
  console.log('\n=== ERRORS ===');
  errors.forEach(e => console.log('ERR:', e));
  if (!errors.length) console.log('ZERO ERRORS');
  
} catch (e) {
  console.log('FAIL:', e.message);
}

await browser.close();
