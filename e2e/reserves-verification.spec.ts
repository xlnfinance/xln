import { expect, test } from './global-setup';

test.describe('Entity Reserves Verification', () => {
  test('should display entity reserves with portfolio bars after demo', async ({ page }) => {
    test.setTimeout(20000);

    // Navigate to XLN
    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);

    // Run demo to create entities with financial data
    await page.locator('button[title="Run Demo"]').click();
    await page.waitForTimeout(1000); // Wait for demo to complete

    await page.locator('.admin-topbar').getByTitle('Add Entity Panel').click();

    // Select first entity in first panel
    const firstPanel = page.locator('.entity-panel').first();

    const entityDropdown = firstPanel.locator('.unified-dropdown').first();
    await entityDropdown.click();
    await page.waitForTimeout(300);

    const firstEntity = page.locator('#dropdownResults .dropdown-item').first();
    await firstEntity.click();
    await page.waitForTimeout(300);

    const aliceOption = firstPanel
      .locator('[data-value="Ethereum:alice:0x2bd72c34b6cf4dc3580ab7b8c06319fa71b23df11c016e9d834f8f5222104803"]')
      .first();
    await aliceOption.click();
    await page.waitForTimeout(500);

    await expect(firstPanel.getByText('Entity 4803')).toBeVisible();
    await expect(firstPanel.getByText('Signer: alice')).toBeVisible();

    // Find and expand the Reserves section
    const reservesHeader = page.getByRole('button', { name: '💰 Reserves ▼' });
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
    await expect(ethRow.locator('.asset-percentage')).toContainText('56.6%');

    // Take screenshot for verification
    await page.screenshot({ path: 'e2e/screenshots/reserves-verification.png' });
  });

  test('should show different reserves for different signers', async ({ page }) => {
    test.setTimeout(15000);

    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);

    // Run demo
    await page.locator('button[title="Run Demo"]').click();
    await page.waitForTimeout(1000);

    await page.locator('.admin-topbar').getByTitle('Add Entity Panel').click();

    // Select Alice first
    const firstPanel = page.locator('.entity-panel').first();
    const entityDropdown = firstPanel.locator('.unified-dropdown').first();
    await entityDropdown.click();
    await page.waitForTimeout(300);

    const aliceOption = firstPanel
      .locator('[data-value="Ethereum:alice:0x2bd72c34b6cf4dc3580ab7b8c06319fa71b23df11c016e9d834f8f5222104803"]')
      .first();
    await aliceOption.click();
    await page.waitForTimeout(500);

    // Expand reserves
    const reservesHeader = firstPanel.getByRole('button', { name: '💰 Reserves ▼' });
    await reservesHeader.click();
    await page.waitForTimeout(300);

    // Verify Alice has 3 assets
    await expect(firstPanel.locator('.asset-row')).toHaveCount(3);
    await expect(firstPanel.locator('.asset-symbol:text("ETH")')).toBeVisible();
    await expect(firstPanel.locator('.asset-symbol:text("USDT")')).toBeVisible();
    await expect(firstPanel.locator('.asset-symbol:text("ACME-SHARES")')).toBeVisible();

    // Switch to Bob - select Bob option from dropdown
    await entityDropdown.click();
    await page.waitForTimeout(300);

    const bobOption = firstPanel
      .locator('[data-value="Ethereum:bob:0x37214fa5196f5bba427e84b86e317c1b1829fe5010069dce10cd795cbc48dd66"]')
      .first();
    await bobOption.click();
    await page.waitForTimeout(500);

    // Verify Bob has different assets
    await expect(firstPanel.locator('.asset-row')).toHaveCount(3);
    await expect(firstPanel.locator('.asset-symbol:text("ETH")')).toBeVisible();
    await expect(firstPanel.locator('.asset-symbol:text("USDC")')).toBeVisible(); // Bob has USDC, not USDT
    await expect(firstPanel.locator('.asset-symbol:text("BTC-SHARES")')).toBeVisible(); // Bob has BTC-SHARES

    // Verify Bob's ETH amount is different (5 ETH vs Alice's 10 ETH)
    const bobEthRow = firstPanel.locator('.asset-row:has(.asset-symbol:text("ETH"))');
    await expect(bobEthRow.locator('.asset-amount')).toContainText('5 ETH');

    await page.screenshot({ path: 'e2e/screenshots/reserves-bob-verification.png' });
  });

  test('should show empty state when entity has no reserves', async ({ page }) => {
    test.setTimeout(10000);

    await page.goto('http://localhost:8080');
    await page.waitForTimeout(500);

    // Create a new entity without running demo (no financial data)
    await page.locator('text=Formation').click();
    await page.waitForTimeout(300);

    // Fill entity form
    await page.fill('#entityNameInput', 'EmptyEntity');

    const firstValidatorSelect = page.locator('.validator-name').first();
    await firstValidatorSelect.selectOption('carol');

    await page.getByRole('button', { name: /Create Entity/i }).click();
    await page.waitForTimeout(1000);

    // Add entity panel and select the new entity
    await page.locator('.admin-topbar').getByTitle('Add Entity Panel').click();

    const firstPanel = page.locator('.entity-panel').first();
    const entityDropdown = firstPanel.locator('.unified-dropdown').first();
    await entityDropdown.click();
    await page.waitForTimeout(300);

    const carolOption = firstPanel.locator('[data-value*="carol"]').first();
    await carolOption.click();
    await page.waitForTimeout(500);

    // Expand reserves
    const reservesHeader = firstPanel.getByRole('button', { name: '💰 Reserves ▼' });
    await reservesHeader.click();
    await page.waitForTimeout(300);

    // Should show empty state
    await expect(firstPanel.locator('#reserves-tab-1 .empty-state')).toBeVisible();
    await expect(firstPanel.locator('#reserves-tab-1 .empty-state')).toContainText(
      'No reserves yet - deposit assets via Depository.sol',
    );

    await page.screenshot({ path: 'e2e/screenshots/reserves-empty-state.png' });
  });
});
