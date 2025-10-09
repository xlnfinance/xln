import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  console.log('📸 Taking screenshots to debug reserves UI...');
  
  // Take screenshot of initial page
  await page.goto('http://localhost:8080');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-01-initial.png', fullPage: true });
  console.log('✅ Screenshot 1: Initial page');
  
  // Check what buttons actually exist
  const buttons = await page.locator('button').allTextContents();
  console.log('📋 Available buttons:', buttons);
  
  // Check for any demo-related text
  const demoElements = await page.locator('text=/demo/i').allTextContents();
  console.log('📋 Demo-related text:', demoElements);
  
  // Demo entities already exist, no need to run demo
  console.log('📋 Demo entities already exist, proceeding to test reserves...');
  
  // Check what selectors actually exist
  const allSelectors = await page.evaluate(() => {
    const elements = document.querySelectorAll('select, .dropdown, [class*="dropdown"], [class*="entity"]');
    return Array.from(elements).map(el => ({ 
      tagName: el.tagName, 
      className: el.className, 
      id: el.id,
      textContent: el.textContent?.substring(0, 50) 
    }));
  });
  console.log('📋 Available dropdowns/selects:', allSelectors);
  
  // Try to find entity dropdown with different selectors
  const possibleDropdowns = ['select', '.entity-dropdown', '[class*="entity"]', '[class*="dropdown"]'];
  let foundDropdown = null;
  
  for (const selector of possibleDropdowns) {
    try {
      const dropdown = await page.locator(selector).first();
      if (await dropdown.isVisible()) {
        console.log(`✅ Found dropdown with selector: ${selector}`);
        foundDropdown = dropdown;
        break;
      }
    } catch (e) {
      // Continue to next selector
    }
  }
  
  if (foundDropdown) {
      await foundDropdown.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'debug-03-dropdown-opened.png', fullPage: true });
      console.log('✅ Screenshot 3: Dropdown opened');
      
      // Try to select Alice
      const options = await page.locator('option').allTextContents();
      console.log('📋 Available options:', options);
      
      if (options.some(opt => opt.includes('alice'))) {
        await page.selectOption(foundDropdown, { label: /alice/ });
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'debug-04-alice-selected.png', fullPage: true });
        console.log('✅ Screenshot 4: Alice selected');
        
        // Check all component headers
        const componentHeaders = await page.locator('.component-header .component-title').allTextContents();
        console.log('📋 Available components:', componentHeaders);
        
        // Look for reserves section
        const reservesSection = await page.locator('.component-header:has(.component-title:has-text("Reserves"))').first();
        if (await reservesSection.isVisible()) {
          await reservesSection.click();
          await page.waitForTimeout(500);
          await page.screenshot({ path: 'debug-05-reserves-expanded.png', fullPage: true });
          console.log('✅ Screenshot 5: Reserves section found and expanded!');
          
          // Check if reserves data exists
          const reservesData = await page.locator('.asset-row').allTextContents();
          console.log('💰 Reserves data:', reservesData);
        } else {
          console.log('❌ Reserves section not found');
          await page.screenshot({ path: 'debug-05-no-reserves.png', fullPage: true });
        }
      }
    }
  } catch (e) {
    console.log('❌ Entity dropdown not found:', e.message);
    await page.screenshot({ path: 'debug-03-no-dropdown.png', fullPage: true });
  }
  
  await browser.close();
  console.log('🎉 Debug screenshots complete! Check debug-*.png files');
})();
