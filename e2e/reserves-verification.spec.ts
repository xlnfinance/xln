import { test, expect } from '@playwright/test';

test.describe('Entity Reserves Verification', () => {
  test('should display entity reserves with portfolio bars after demo', async ({ page }) => {
    test.setTimeout(20000);
    
    // Navigate to XLN
    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);
    
    // Run demo to create entities with financial data
    await page.click('button:has-text("Run Demo")');
    await page.waitForTimeout(3000); // Wait for demo to complete
    
    // Verify entities are created
    await expect(page.locator('.entity-dropdown')).toBeVisible();
    
    // Select Alice from entity #1 (should have 10 ETH, 23 USDT, 1235 ACME-SHARES)
    await page.selectOption('.entity-dropdown', { label: /Entity #1.*alice/ });
    await page.waitForTimeout(500);
    
    // Find and expand the Reserves section
    const reservesHeader = page.locator('.component-header:has(.component-title:has-text("Reserves"))');
    await expect(reservesHeader).toBeVisible();
    
    // Click to expand reserves
    await reservesHeader.click();
    await page.waitForTimeout(300);
    
    // Verify reserves are displayed
    const reservesContent = page.locator('.component-content:has(.reserves-container)');
    await expect(reservesContent).toBeVisible();
    
    // Check portfolio summary
    const portfolioSummary = page.locator('.portfolio-summary');
    await expect(portfolioSummary).toBeVisible();
    await expect(portfolioSummary).toContainText('Portfolio Value: $');
    
    // Verify Alice's assets are displayed
    const assetRows = page.locator('.asset-row');
    await expect(assetRows).toHaveCount(3); // ETH, USDT, ACME-SHARES
    
    // Check ETH asset
    const ethRow = page.locator('.asset-row:has(.asset-symbol:text("ETH"))');
    await expect(ethRow).toBeVisible();
    await expect(ethRow.locator('.asset-amount')).toContainText('10 ETH');
    await expect(ethRow.locator('.asset-value')).toContainText('$25000'); // 10 ETH * $2500
    
    // Check USDT asset
    const usdtRow = page.locator('.asset-row:has(.asset-symbol:text("USDT"))');
    await expect(usdtRow).toBeVisible();
    await expect(usdtRow.locator('.asset-amount')).toContainText('23 USDT');
    await expect(usdtRow.locator('.asset-value')).toContainText('$23'); // 23 USDT * $1
    
    // Check ACME-SHARES asset
    const acmeRow = page.locator('.asset-row:has(.asset-symbol:text("ACME-SHARES"))');
    await expect(acmeRow).toBeVisible();
    await expect(acmeRow.locator('.asset-amount')).toContainText('1235 ACME-SHARES');
    await expect(acmeRow.locator('.asset-value')).toContainText('$19142.50'); // 1235 * $15.50
    
    // Verify portfolio bars exist and have correct widths
    const portfolioBars = page.locator('.portfolio-fill');
    await expect(portfolioBars).toHaveCount(3);
    
    // ETH should be the largest percentage (~56.5% of $44,165.50 total)
    const ethBar = ethRow.locator('.portfolio-fill');
    const ethWidth = await ethBar.getAttribute('style');
    expect(ethWidth).toContain('width: 56.'); // Should be around 56.5%
    
    // Check percentage text
    await expect(ethRow.locator('.asset-percentage')).toContainText('56.5%');
    
    // Take screenshot for verification
    await page.screenshot({ path: 'e2e/screenshots/reserves-verification.png' });
  });

  test('should show different reserves for different signers', async ({ page }) => {
    test.setTimeout(15000);
    
    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);
    
    // Run demo
    await page.click('button:has-text("Run Demo")');
    await page.waitForTimeout(3000);
    
    // Select Alice first
    await page.selectOption('.entity-dropdown', { label: /Entity #1.*alice/ });
    await page.waitForTimeout(500);
    
    // Expand reserves
    const reservesHeader = page.locator('.component-header:has(.component-title:has-text("Reserves"))');
    await reservesHeader.click();
    await page.waitForTimeout(300);
    
    // Verify Alice has 3 assets
    await expect(page.locator('.asset-row')).toHaveCount(3);
    await expect(page.locator('.asset-symbol:text("ETH")')).toBeVisible();
    await expect(page.locator('.asset-symbol:text("USDT")')).toBeVisible();
    await expect(page.locator('.asset-symbol:text("ACME-SHARES")')).toBeVisible();
    
    // Switch to Bob
    await page.selectOption('.entity-dropdown', { label: /Entity #1.*bob/ });
    await page.waitForTimeout(500);
    
    // Verify Bob has different assets
    await expect(page.locator('.asset-row')).toHaveCount(3);
    await expect(page.locator('.asset-symbol:text("ETH")')).toBeVisible();
    await expect(page.locator('.asset-symbol:text("USDC")')).toBeVisible(); // Bob has USDC, not USDT
    await expect(page.locator('.asset-symbol:text("BTC-SHARES")')).toBeVisible(); // Bob has BTC-SHARES
    
    // Verify Bob's ETH amount is different (5 ETH vs Alice's 10 ETH)
    const bobEthRow = page.locator('.asset-row:has(.asset-symbol:text("ETH"))');
    await expect(bobEthRow.locator('.asset-amount')).toContainText('5 ETH');
    
    await page.screenshot({ path: 'e2e/screenshots/reserves-bob-verification.png' });
  });

  test('should show empty state when no reserves exist', async ({ page }) => {
    test.setTimeout(10000);
    
    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);
    
    // Create a new entity without running demo (no financial data)
    await page.click('button:text("Formation")');
    await page.waitForTimeout(300);
    
    // Fill entity form
    await page.fill('input[placeholder="Entity name"]', 'EmptyEntity');
    await page.fill('input[placeholder="alice"]', 'charlie');
    await page.click('button:text("Create Entity")');
    await page.waitForTimeout(1000);
    
    // Select the new entity
    await page.selectOption('.entity-dropdown', { label: /EmptyEntity.*charlie/ });
    await page.waitForTimeout(500);
    
    // Expand reserves
    const reservesHeader = page.locator('.component-header:has(.component-title:has-text("Reserves"))');
    await reservesHeader.click();
    await page.waitForTimeout(300);
    
    // Should show empty state
    await expect(page.locator('.empty-state')).toBeVisible();
    await expect(page.locator('.empty-state')).toContainText('No reserves yet - deposit assets via Depository.sol');
    
    await page.screenshot({ path: 'e2e/screenshots/reserves-empty-state.png' });
  });
});
