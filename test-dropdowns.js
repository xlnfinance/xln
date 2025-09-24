const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to the app
  await page.goto('http://localhost:8081');

  // Wait for the page to load
  await page.waitForTimeout(2000);

  console.log('Page loaded, looking for dropdowns...');

  // Try to find and click the entity dropdown
  try {
    // Look for the entity dropdown by various selectors
    const entityDropdown = await page.locator('.unified-dropdown').first();
    if (await entityDropdown.count() > 0) {
      console.log('Found entity dropdown, clicking...');
      await entityDropdown.click();
      await page.waitForTimeout(1000);

      // Check if dropdown opened
      const dropdownContent = await page.locator('.dropdown-content');
      if (await dropdownContent.count() > 0) {
        console.log('Entity dropdown opened successfully');
      } else {
        console.log('Entity dropdown did not open - checking for errors');

        // Check console for errors
        page.on('console', msg => console.log('Browser console:', msg.text()));
        page.on('pageerror', error => console.log('Page error:', error.message));
      }
    } else {
      console.log('Could not find entity dropdown');
    }

    // Try the account dropdown
    const accountDropdown = await page.locator('.account-inspector-dropdown');
    if (await accountDropdown.count() > 0) {
      console.log('Found account dropdown, clicking...');
      await accountDropdown.click();
      await page.waitForTimeout(1000);
      console.log('Clicked account dropdown');
    } else {
      console.log('Could not find account dropdown');
    }

  } catch (error) {
    console.error('Error interacting with dropdowns:', error);
  }

  // Keep browser open for inspection
  await page.waitForTimeout(30000);
  await browser.close();
})();