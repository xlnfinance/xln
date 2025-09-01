import { test, expect } from '@playwright/test';

test('DEBUG: Entity Selection State', async ({ page }) => {
  console.log('🔍 Debugging entity selection...');
  
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
  // Quick entity creation
  await page.locator('text=Formation').click();
  await page.fill('#entityNameInput', 'Debug Entity');
  await page.locator('#thresholdSlider').evaluate((el: HTMLInputElement) => {
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  
  await page.getByRole('button', { name: /Create Entity/i }).click();
  await page.waitForTimeout(2000);
  
  console.log('✅ Entity created, checking panel state...');
  
  // Check panel count
  const panelCount = await page.locator('.entity-panel').count();
  console.log(`📊 Panel count: ${panelCount}`);
  
  if (panelCount > 0) {
    const firstPanel = page.locator('.entity-panel').first();
    
    // Check what's in the first panel
    const hasEmptyState = await firstPanel.locator('.empty-panel-state').count();
    const hasControlsHeader = await firstPanel.locator('.component-header').filter({ hasText: 'Controls' }).count();
    
    console.log(`📊 Empty state count: ${hasEmptyState}`);
    console.log(`📊 Controls header count: ${hasControlsHeader}`);
    
    // Get tab state
    const tabState = await firstPanel.evaluate(() => {
      // Try to find tab data
      const tabElement = document.querySelector('[data-panel-id]');
      return {
        hasTabElement: !!tabElement,
        panelId: tabElement?.getAttribute('data-panel-id'),
        textContent: tabElement?.textContent?.substring(0, 200)
      };
    });
    
    console.log('📊 Tab state:', tabState);
    
    // Try entity selection
    console.log('🎯 Attempting entity selection...');
    
    const entityDropdown = firstPanel.locator('.unified-dropdown').first();
    if (await entityDropdown.count() > 0) {
      await entityDropdown.click();
      await page.waitForTimeout(500);
      
      const dropdownOptions = await page.locator('#dropdownResults .dropdown-item').count();
      console.log(`📊 Dropdown options: ${dropdownOptions}`);
      
      if (dropdownOptions > 0) {
        await page.locator('#dropdownResults .dropdown-item').first().click();
        await page.waitForTimeout(500);
        
        // Try signer selection
        const signerDropdown = firstPanel.locator('.unified-dropdown').nth(1);
        if (await signerDropdown.count() > 0) {
          await signerDropdown.click();
          await page.waitForTimeout(500);
          
          const signerOptions = await page.locator('#dropdownResults .dropdown-item').count();
          console.log(`📊 Signer options: ${signerOptions}`);
          
          if (signerOptions > 0) {
            await page.locator('#dropdownResults .dropdown-item').first().click();
            await page.waitForTimeout(1000);
            
            // Check state after selection
            const afterEmptyState = await firstPanel.locator('.empty-panel-state').count();
            const afterControlsHeader = await firstPanel.locator('.component-header').filter({ hasText: 'Controls' }).count();
            
            console.log(`📊 After selection - Empty state: ${afterEmptyState}`);
            console.log(`📊 After selection - Controls header: ${afterControlsHeader}`);
            
            if (afterControlsHeader > 0) {
              console.log('✅ SUCCESS: Controls header found after selection');
            } else {
              console.log('❌ PROBLEM: Controls header still not found');
            }
          }
        }
      }
    }
  }
  
  await page.screenshot({ path: 'e2e/screenshots/debug-final-state.png', fullPage: true });
  console.log('📸 Screenshot: Debug final state');
});
