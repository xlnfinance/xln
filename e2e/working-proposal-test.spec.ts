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

async function selectEntityAndSigner(page, signerIndex: number) {
  // Wait for entity panels to be visible
  await page.waitForSelector('.entity-panel', { timeout: 5000 });
  
  // Click the first entity dropdown to select the entity
  const entityDropdown = page.locator('.unified-dropdown').first();
  await entityDropdown.click();
  await page.waitForTimeout(200);
  
  // Select the first entity that appears
  const firstEntity = page.locator('#dropdownResults .dropdown-item').first();
  await expect(firstEntity).toBeVisible();
  await firstEntity.click();
  await page.waitForTimeout(200);
  
  // Now select the signer (second dropdown)
  const signerDropdown = page.locator('.unified-dropdown').nth(1);
  await signerDropdown.click();
  await page.waitForTimeout(200);
  
  // Select the signer by index
  const signerOption = page.locator('#dropdownResults .dropdown-item').nth(signerIndex);
  await expect(signerOption).toBeVisible();
  await signerOption.click();
  await page.waitForTimeout(200);
}

test.describe('Working Proposal Test', () => {

test('CREATE ENTITY -> PROPOSAL -> VOTING WORKFLOW', async ({ page }) => {
  console.log('🎬 Starting COMPLETE proposal workflow...');
  
  // Step 1: Navigate and wait for app
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
  await page.screenshot({ path: 'e2e/screenshots/working-01-loaded.png', fullPage: true });
  console.log('📸 Screenshot: App loaded');

  // Step 2: Create entity with validators
  console.log('🏗️ STEP 2: Creating entity with alice and bob');
  
  await page.locator('text=Formation').click();
  await page.fill('#entityNameInput', 'Governance Entity');
  
  await addValidator(page);
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await setThreshold(page, 2); // Both must vote
  
  await page.screenshot({ path: 'e2e/screenshots/working-02-entity-form.png', fullPage: true });
  console.log('📸 Screenshot: Entity form filled');
  
  // Track state before creation
  const beforeState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      replicas: env?.replicas?.size ?? 0,
      height: env?.height ?? 0
    };
  });
  
  // Create entity
  await page.getByRole('button', { name: /Create Entity/i }).click();
  
  // Wait for entity creation (fast timeout)
  await page.waitForFunction((prev) => {
    const env = (window as any).xlnEnv;
    const newReplicas = env?.replicas?.size ?? 0;
    const newHeight = env?.height ?? 0;
    return newReplicas > prev.replicas && newHeight > prev.height;
  }, beforeState, { timeout: 5000 });
  
  await page.screenshot({ path: 'e2e/screenshots/working-03-entity-created.png', fullPage: true });
  console.log('✅ Entity created successfully');

  // Step 3: Select entity and Alice as signer
  console.log('🎯 STEP 3: Selecting entity and Alice as signer');
  await selectEntityAndSigner(page, 0); // alice = index 0
  
  await page.screenshot({ path: 'e2e/screenshots/working-04-alice-selected.png', fullPage: true });
  console.log('📸 Screenshot: Alice selected as signer');

  // Step 4: Open entity panel and expand Controls
  console.log('📝 STEP 4: Opening controls for proposal creation');
  
  // Wait for entity panel to be visible
  await expect(page.locator('.entity-panel').first()).toBeVisible();
  
  // Find and click the Controls section header to expand it
  const controlsHeader = page.locator('.entity-panel').first().locator('.component-header').filter({ hasText: 'Controls' });
  await expect(controlsHeader).toBeVisible();
  await controlsHeader.click();
  await page.waitForTimeout(300);
  
  await page.screenshot({ path: 'e2e/screenshots/working-05-controls-expanded.png', fullPage: true });
  console.log('📸 Screenshot: Controls section expanded');

  // Step 5: Fill and submit proposal
  console.log('✍️ STEP 5: Creating proposal');
  
  // First, select "proposal" from the controls dropdown
  await page.selectOption('.controls-dropdown', 'proposal');
  await page.waitForTimeout(200);
  
  // Wait for proposal form fields to be visible
  await expect(page.locator('input[placeholder="Enter proposal title..."]')).toBeVisible();
  await expect(page.locator('textarea[placeholder="Enter proposal description..."]')).toBeVisible();
  
  // Fill proposal form
  await page.fill('input[placeholder="Enter proposal title..."]', 'Q4 Budget Allocation');
  await page.fill('textarea[placeholder="Enter proposal description..."]', 'Approve $100K budget for Q4 marketing campaign');
  
  await page.screenshot({ path: 'e2e/screenshots/working-06-proposal-form-filled.png', fullPage: true });
  console.log('📸 Screenshot: Proposal form filled');
  
  // Submit proposal
  await page.getByRole('button', { name: 'Create Proposal' }).click();
  await page.waitForTimeout(500);
  
  await page.screenshot({ path: 'e2e/screenshots/working-07-proposal-created.png', fullPage: true });
  console.log('📸 Screenshot: Proposal created');

  // Step 6: Verify proposal appears
  console.log('🔍 STEP 6: Verifying proposal appears');
  
  // Expand Proposals section to see the proposal
  const proposalsHeader = page.locator('.entity-panel').first().locator('.component-header').filter({ hasText: 'Proposals' });
  if (await proposalsHeader.isVisible()) {
    await proposalsHeader.click();
    await page.waitForTimeout(300);
  }
  
  // Check that proposal appears
  await expect(page.locator('.proposal-item')).toBeVisible();
  await expect(page.locator('text=Q4 Budget Allocation')).toBeVisible();
  
  console.log('✅ Proposal visible in UI');

  // Step 7: Switch to Bob and vote
  console.log('🗳️ STEP 7: Switching to Bob for voting');
  await selectEntityAndSigner(page, 1); // bob = index 1
  
  await page.screenshot({ path: 'e2e/screenshots/working-08-bob-selected.png', fullPage: true });
  console.log('📸 Screenshot: Bob selected as signer');
  
  // Expand Bob's controls
  const bobControlsHeader = page.locator('.entity-panel').first().locator('.component-header').filter({ hasText: 'Controls' });
  await bobControlsHeader.click();
  await page.waitForTimeout(300);
  
  // Vote on the proposal
  console.log('✅ Bob voting YES on the proposal...');
  
  // First, select "vote" from the controls dropdown
  await page.selectOption('.controls-dropdown', 'vote');
  await page.waitForTimeout(200);
  
  // Select the proposal in voting section
  const proposalSelects = page.locator('.form-input').filter({ has: page.locator('option:has-text("Q4 Budget Allocation")') });
  if (await proposalSelects.count() > 0) {
    await proposalSelects.first().selectOption({ label: 'Q4 Budget Allocation' });
  } else {
    // Fallback: select by index
    await page.locator('select:has(option:has-text("Q4 Budget Allocation"))').selectOption({ index: 1 });
  }
  await page.waitForTimeout(200);
  
  // Choose YES vote
  await page.selectOption('select:has(option:has-text("✅ Yes"))', 'yes');
  await page.fill('textarea[placeholder*="vote comment"]', 'I approve this budget allocation');
  
  // Submit vote
  await page.getByRole('button', { name: 'Submit Vote' }).click();
  await page.waitForTimeout(500);
  
  await page.screenshot({ path: 'e2e/screenshots/working-09-bob-voted.png', fullPage: true });
  console.log('📸 Screenshot: Bob voted');

  // Step 8: Verify final state
  console.log('🎉 STEP 8: Verifying final proposal state');
  
  // Expand proposals section to check final status
  if (await proposalsHeader.isVisible()) {
    await proposalsHeader.click();
    await page.waitForTimeout(300);
  }
  
  // Check that proposal is approved
  await expect(page.locator('.proposal-item:has-text("APPROVED")')).toBeVisible();
  await expect(page.locator('text=2 yes')).toBeVisible(); // Both alice and bob voted yes
  
  // Check for collective message
  const chatHeader = page.locator('.entity-panel').first().locator('.component-header').filter({ hasText: 'Chat' });
  if (await chatHeader.isVisible()) {
    await chatHeader.click();
    await page.waitForTimeout(300);
  }
  
  // Verify collective message appears
  await expect(page.locator('.chat-messages')).toContainText('[COLLECTIVE]');
  await expect(page.locator('.chat-messages')).toContainText('Q4 Budget Allocation');
  
  await page.screenshot({ path: 'e2e/screenshots/working-10-final-success.png', fullPage: true });
  console.log('📸 Screenshot: Final success state');

  console.log('🎉 COMPLETE SUCCESS!');
  console.log('✅ Entity created with validators');
  console.log('✅ Alice created proposal');
  console.log('✅ Bob voted and approved proposal');
  console.log('✅ Collective message executed');
  console.log('✅ Full workflow completed successfully!');
});

});
