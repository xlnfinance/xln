import { test, expect } from '@playwright/test';

// Helper functions
async function setThreshold(page, value: number) {
  const slider = page.locator('#thresholdSlider');
  await slider.evaluate((el: HTMLInputElement, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function addValidator(page) {
  await page.getByRole('button', { name: '➕ Add Validator' }).click();
}

async function pickSignerInRow(page, rowIndex: number, signerText: string) {
  const row = page.locator('.validator-row').nth(rowIndex);
  const select = row.locator('.validator-name');
  await select.selectOption(signerText);
}

test.describe('Zero Panels Start Test', () => {

test('START WITH 0 PANELS → CREATE ENTITY → GET SIGNER PANELS', async ({ page }) => {
  console.log('🎬 Testing zero panels start workflow...');
  
  // Navigate and wait for app
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
  await page.screenshot({ path: 'e2e/screenshots/zero-01-loaded.png', fullPage: true });
  console.log('📸 Screenshot: App loaded');

  // === STEP 1: VERIFY 0 PANELS BY DEFAULT ===
  console.log('🔍 STEP 1: Verifying 0 panels by default');
  
  const initialPanels = await page.locator('.entity-panel').count();
  console.log(`📊 Initial panels count: ${initialPanels}`);
  
  expect(initialPanels).toBe(0);
  console.log('✅ Confirmed: Started with 0 panels');
  
  await page.screenshot({ path: 'e2e/screenshots/zero-02-no-panels.png', fullPage: true });
  console.log('📸 Screenshot: No panels initially');

  // === STEP 2: CREATE ENTITY WITH 3 SIGNERS ===
  console.log('🏗️ STEP 2: Creating entity with 3 signers');
  
  await page.locator('text=Formation').click();
  await page.fill('#entityNameInput', 'Multi-Signer Entity');
  
  // Add 2 more validators (starts with 1)
  await addValidator(page);
  await addValidator(page);
  
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await pickSignerInRow(page, 2, 'carol');
  await setThreshold(page, 2);
  
  await page.screenshot({ path: 'e2e/screenshots/zero-03-form-filled.png', fullPage: true });
  console.log('📸 Screenshot: Form filled with 3 signers');
  
  // Create entity
  await page.getByRole('button', { name: /Create Entity/i }).click();
  
  // Wait for entity creation
  await page.waitForFunction(() => {
    const env = (window as any).xlnEnv;
    return env?.replicas?.size > 0;
  }, { timeout: 5000 });
  
  await page.waitForTimeout(1000); // Wait for panels to be created
  
  await page.screenshot({ path: 'e2e/screenshots/zero-04-entity-created.png', fullPage: true });
  console.log('📸 Screenshot: Entity created');

  // === STEP 3: VERIFY 3 PANELS WERE CREATED ===
  console.log('🎯 STEP 3: Verifying panels were auto-created');
  
  const finalPanels = await page.locator('.entity-panel').count();
  console.log(`📊 Final panels count: ${finalPanels}`);
  
  expect(finalPanels).toBe(3);
  console.log('✅ Confirmed: 3 panels created for 3 signers');

  // === STEP 4: VERIFY EMPTY STATE IN PANELS ===
  console.log('📋 STEP 4: Verifying empty state messages');
  
  const emptyStates = await page.locator('.empty-panel-state').count();
  console.log(`📊 Empty state messages: ${emptyStates}`);
  
  expect(emptyStates).toBeGreaterThan(0);
  
  // Check that the empty message contains correct text
  const firstEmptyState = page.locator('.empty-panel-state').first();
  await expect(firstEmptyState).toContainText('Select Entity to View Profile');
  
  console.log('✅ Confirmed: Empty states show correct message');
  
  await page.screenshot({ path: 'e2e/screenshots/zero-05-empty-states.png', fullPage: true });
  console.log('📸 Screenshot: Empty states in panels');

  // === STEP 5: SELECT ENTITY IN FIRST PANEL ===
  console.log('🎯 STEP 5: Selecting entity in first panel');
  
  // Click the first entity dropdown
  const firstDropdown = page.locator('.unified-dropdown').first();
  await firstDropdown.click();
  await page.waitForTimeout(200);
  
  // Select the entity
  const entityOption = page.locator('#dropdownResults .dropdown-item').first();
  await entityOption.click();
  await page.waitForTimeout(200);
  
  // Select alice as signer (second dropdown)
  const signerDropdown = page.locator('.unified-dropdown').nth(1);
  await signerDropdown.click();
  await page.waitForTimeout(200);
  
  const aliceOption = page.locator('#dropdownResults .dropdown-item').first();
  await aliceOption.click();
  await page.waitForTimeout(500);
  
  await page.screenshot({ path: 'e2e/screenshots/zero-06-first-panel-selected.png', fullPage: true });
  console.log('📸 Screenshot: First panel with entity selected');

  // === STEP 6: VERIFY CONTENT APPEARS ===
  console.log('🔍 STEP 6: Verifying content appears after selection');
  
  // Check if consensus section is visible
  const consensusSection = page.locator('.component-header').filter({ hasText: 'Consensus State' }).first();
  await expect(consensusSection).toBeVisible();
  
  // Check if other sections exist
  const chatSection = page.locator('.component-header').filter({ hasText: 'Chat' }).first();
  const proposalsSection = page.locator('.component-header').filter({ hasText: 'Proposals' }).first();
  const controlsSection = page.locator('.component-header').filter({ hasText: 'Controls' }).first();
  
  await expect(chatSection).toBeVisible();
  await expect(proposalsSection).toBeVisible();
  await expect(controlsSection).toBeVisible();
  
  console.log('✅ Confirmed: All sections visible after entity selection');
  
  await page.screenshot({ path: 'e2e/screenshots/zero-07-content-visible.png', fullPage: true });
  console.log('📸 Screenshot: Content sections visible');

  console.log('🎉 ZERO PANELS WORKFLOW SUCCESS!');
  console.log('✅ Started with 0 panels');
  console.log('✅ Entity creation auto-created 3 panels');
  console.log('✅ Empty states show proper messages');
  console.log('✅ Content appears after entity selection');
  console.log('✅ All panel sections work correctly');
});

});
