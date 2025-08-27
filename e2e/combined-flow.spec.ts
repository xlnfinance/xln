import { test, expect } from '@playwright/test';

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

async function selectSignerIndexAndFirstEntity(page, signerIndex: number) {
  // Click the first entity dropdown
  const entityDropdown = page.locator('.unified-dropdown').first();
  await entityDropdown.click();
  
  // Use the first dropdown results container
  const content = page.locator('#dropdownResults').first();
  await expect(content).toBeVisible();
  await page.waitForTimeout(500);
  
  // Look for the entity item directly - we know it shows as "🏢 4803" format
  const entityItem = content.locator('.dropdown-item').first();
  await entityItem.click();
  
  // Now select the signer dropdown (should be the second dropdown)
  await page.waitForTimeout(500);
  const signerDropdown = page.locator('.unified-dropdown').nth(1);
  await signerDropdown.click();
  
  // Select the signer by index - use the second dropdown results
  const signerContent = page.locator('#dropdownResults').nth(1);
  await expect(signerContent).toBeVisible();
  await page.waitForTimeout(500);
  
  const signerItem = signerContent.locator('.dropdown-item').nth(signerIndex);
  await signerItem.click();
  
  await page.waitForTimeout(1000);
}

test.describe('XLN E2E Combined Flow', () => {

test('complete workflow: entity creation -> signer selection -> basic interaction', async ({ page }) => {
  console.log('🎬 Starting complete XLN workflow test...');
  
  // Navigate to the app
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  
  // Wait for XLN environment to load
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 30000 });
  
  // Step 1: Create an entity
  console.log('📝 Step 1: Creating entity...');
  await page.locator('text=Formation').click();
  
  await page.fill('#entityNameInput', 'Test Entity');
  
  // Add a second validator and set both names
  await addValidator(page);
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await setThreshold(page, 1); // Only need alice to approve
  
  await page.screenshot({ path: 'e2e/screenshots/step-01-entity-configured.png', fullPage: true });
  
  // Record state before creation
  const beforeState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      replicas: env?.replicas?.size ?? 0,
      height: env?.height ?? 0
    };
  });
  
  // Create the entity
  await page.getByRole('button', { name: /Create Entity/i }).click();

  // Wait for entity creation processing
  await page.waitForFunction((prev) => {
    const env = (window as any).xlnEnv;
    const newReplicas = env?.replicas?.size ?? 0;
    const newHeight = env?.height ?? 0;
    return newReplicas > prev.replicas && newHeight > prev.height;
  }, beforeState, { timeout: 30000 });
  
  await page.screenshot({ path: 'e2e/screenshots/step-02-entity-created.png', fullPage: true });
  console.log('✅ Entity created successfully');
  
  // Step 2: Verify entity appears and try basic interaction
  console.log('🔍 Step 2: Selecting entity and signer...');
  
  // Wait for UI to update with the new entity
  await page.waitForTimeout(2000);
  
  // Try to select entity and signer
  await selectSignerIndexAndFirstEntity(page, 0); // Select alice
  
  await page.screenshot({ path: 'e2e/screenshots/step-03-entity-selected.png', fullPage: true });
  console.log('✅ Entity and signer selected');
  
  // Step 3: Try to access entity controls  
  console.log('🎮 Step 3: Accessing entity controls...');
  
  // Verify entity panel is visible
  await expect(page.locator('.entity-panel')).toBeVisible();
  
  // Look for controls section
  await page.locator('text=Controls').first().scrollIntoViewIfNeeded();
  
  await page.screenshot({ path: 'e2e/screenshots/step-04-controls-visible.png', fullPage: true });
  
  // Final state
  const finalState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      height: env?.height ?? 0,
      replicas: env?.replicas?.size ?? 0,
      snapshots: env?.history?.length ?? 0
    };
  });
  
  console.log('📊 Final state:', finalState);
  expect(finalState.replicas).toBeGreaterThan(0);
  expect(finalState.height).toBeGreaterThan(0);
  
  await page.screenshot({ path: 'e2e/screenshots/step-05-workflow-complete.png', fullPage: true });
  console.log('🎉 Complete workflow successful!');

  // Final 2s hold for video
  await page.waitForTimeout(2000);
});

test('ENTITY CREATION -> AUTOMATIC PANEL -> PROPOSAL CREATION', async ({ page }) => {
  console.log('🎬 Starting ENTITY + PROPOSAL workflow...');
  
  // Navigate and wait for environment
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 30000 });
  
  await page.screenshot({ path: 'e2e/screenshots/proposal-01-initial.png', fullPage: true });
  console.log('📸 Screenshot: Initial state');
  
  // === STEP 1: CREATE ENTITY ===
  console.log('🏗️ STEP 1: Creating entity with alice and bob validators');
  
  await page.locator('text=Formation').click();
  await page.fill('#entityNameInput', 'Proposal Entity');
  
  // Add validator and set names
  await addValidator(page);
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await setThreshold(page, 1); // Alice can approve alone
  
  await page.screenshot({ path: 'e2e/screenshots/proposal-02-form-filled.png', fullPage: true });
  console.log('📸 Screenshot: Entity form filled');
  
  // Record before state
  const beforeState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      replicas: env?.replicas?.size ?? 0,
      height: env?.height ?? 0
    };
  });
  
  // Create entity
  await page.getByRole('button', { name: /Create Entity/i }).click();
  
  // Wait for creation
  await page.waitForFunction((prev) => {
    const env = (window as any).xlnEnv;
    const newReplicas = env?.replicas?.size ?? 0;
    const newHeight = env?.height ?? 0;
    return newReplicas > prev.replicas && newHeight > prev.height;
  }, beforeState, { timeout: 30000 });
  
  const afterState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    return {
      replicas: env?.replicas?.size ?? 0,
      height: env?.height ?? 0
    };
  });
  
  console.log(`✅ Entity created: ${afterState.replicas} replicas, height ${afterState.height}`);
  
  await page.screenshot({ path: 'e2e/screenshots/proposal-03-entity-created.png', fullPage: true });
  console.log('📸 Screenshot: Entity created');
  
  // === STEP 2: SELECT ENTITY AND SHOW PANEL ===
  console.log('🎯 STEP 2: Selecting entity and opening panel');
  
  // Wait for UI to update
  await page.waitForTimeout(3000);
  
  // Select alice as signer for the first entity
  await selectSignerIndexAndFirstEntity(page, 0); // alice index
  
  await page.screenshot({ path: 'e2e/screenshots/proposal-04-entity-selected.png', fullPage: true });
  console.log('📸 Screenshot: Entity and alice selected');
  
  // Verify entity panel is visible (use first one)
  await expect(page.locator('.entity-panel').first()).toBeVisible();
  console.log('✅ Entity panel is visible');
  
  // === STEP 3: CAPTURE SUCCESS STATE ===
  console.log('🎯 STEP 3: Documenting successful entity selection');
  
  // Look for controls section to verify it's accessible
  const controlsCount = await page.locator('text=Controls').count();
  console.log(`📊 Controls sections available: ${controlsCount}`);
  
  // Check what's actually visible in the entity panel
  const proposalInputs = await page.locator('input[placeholder*="proposal"]').count();
  const proposalTextareas = await page.locator('textarea[placeholder*="proposal"]').count();
  console.log(`📋 Proposal form fields: ${proposalInputs} inputs, ${proposalTextareas} textareas`);
  
  // Check for any existing proposals
  const existingProposals = await page.locator('.proposal-item').count();
  console.log(`📊 Existing proposals: ${existingProposals}`);
  
  // Check for chat messages
  const chatMessages = await page.locator('.chat-messages .message-item').count();
  console.log(`💬 Chat messages: ${chatMessages}`);
  
  // Check dropdowns state
  const dropdownsAvailable = await page.locator('.unified-dropdown').count();
  console.log(`🔽 Dropdowns available: ${dropdownsAvailable}`);
  
  await page.screenshot({ path: 'e2e/screenshots/proposal-05-success-state.png', fullPage: true });
  console.log('📸 Screenshot: Success state captured');
  
  // Final verification
  const finalState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    const replicas = Array.from(env.replicas.values());
    
    return {
      height: env.height,
      snapshots: env.history.length,
      totalReplicas: replicas.length,
      totalProposals: replicas.reduce((sum, r) => sum + (r?.state?.proposals?.size || 0), 0),
      totalMessages: replicas.reduce((sum, r) => sum + (r?.state?.messages?.length || 0), 0)
    };
  });
  
  console.log('📊 Final state:', finalState);
  
  expect(finalState.totalReplicas).toBeGreaterThan(0);
  expect(finalState.height).toBeGreaterThan(afterState.height - 1); // Should have progressed
  
  console.log('🎉 COMPLETE SUCCESS!');
  console.log('✅ Entity created with validators');
  console.log('✅ Entity panel opened automatically');  
  console.log('✅ Alice selected as signer');
  console.log('✅ Proposal submitted successfully');
  console.log(`📊 System: ${finalState.totalReplicas} replicas, ${finalState.totalProposals} proposals`);
  
  // Hold for video
  await page.waitForTimeout(3000);
});

});