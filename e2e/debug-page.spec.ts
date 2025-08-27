import { test, expect } from '@playwright/test';

test('debug page content', async ({ page }) => {
  await page.goto('/');
  
  // Wait for page to load
  await page.waitForLoadState('networkidle');
  
  // Take a screenshot to see what's on the page
  await page.screenshot({ path: 'debug-page.png', fullPage: true });
  
  // Get page title and log it
  const title = await page.title();
  console.log('Page title:', title);
  
  // Get the body content and log it
  const bodyText = await page.locator('body').textContent();
  console.log('Body text (first 500 chars):', bodyText?.substring(0, 500));
  
  // Check if there are any error messages
  const errorElements = await page.locator('.error-container, .error-text, [class*="error"]').all();
  for (const el of errorElements) {
    const text = await el.textContent();
    console.log('Error element:', text);
  }
  
  // Check if loading elements are present
  const loadingElements = await page.locator('.loading-container, .loading-text, [class*="loading"]').all();
  for (const el of loadingElements) {
    const text = await el.textContent();
    console.log('Loading element:', text);
  }
  
  // Check what tabs are available
  const tabs = await page.locator('.tab-button, [id*="Tab"]').all();
  for (const tab of tabs) {
    const text = await tab.textContent();
    const id = await tab.getAttribute('id');
    console.log('Tab found:', text, 'ID:', id);
  }
  
  // Wait a bit longer to see if content loads
  await page.waitForTimeout(3000);
  
  // Take another screenshot
  await page.screenshot({ path: 'debug-page-after-wait.png', fullPage: true });
});
