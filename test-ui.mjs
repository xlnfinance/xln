import { chromium } from 'playwright';

// Launch browser
const browser = await chromium.launch({
  headless: false,
  slowMo: 500 // Slow down actions so we can see them
});

const context = await browser.newContext();
const page = await context.newPage();

// Navigate to the app
await page.goto('http://localhost:8081');

// Wait for the page to load
await page.waitForTimeout(2000);

// Try to click on the entity dropdown
const entityDropdown = await page.locator('.unified-dropdown-btn').first();
if (await entityDropdown.isVisible()) {
  console.log('Found entity dropdown, clicking...');
  await entityDropdown.click();
  await page.waitForTimeout(1000);

  // Try to select an entity if available
  const entityOption = await page.locator('.tree-item.entity').first();
  if (await entityOption.isVisible()) {
    console.log('Found entity option, clicking...');
    await entityOption.click();
    await page.waitForTimeout(1000);
  }
}

// Now try the account dropdown
const accountDropdown = await page.locator('.unified-dropdown-btn').nth(1);
if (await accountDropdown.isVisible()) {
  console.log('Found account dropdown, clicking...');
  await accountDropdown.click();
  await page.waitForTimeout(1000);

  // Try to select an account
  const accountOption = await page.locator('.tree-item.account').first();
  if (await accountOption.count() > 0) {
    console.log('Found account option, clicking...');
    await accountOption.click();
    await page.waitForTimeout(2000);
  }
}

// Take a screenshot
await page.screenshot({ path: 'ui-test.png', fullPage: true });
console.log('Screenshot saved as ui-test.png');

// Keep browser open for manual interaction
console.log('Browser will stay open for 30 seconds...');
await page.waitForTimeout(30000);

await browser.close();
console.log('Done!');