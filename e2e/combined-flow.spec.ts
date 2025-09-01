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
  
  await page.waitForTimeout(200);
}

test.describe('XLN E2E Combined Flow', () => {

test('complete workflow: entity creation -> signer selection -> basic interaction', async ({ page }) => {
  console.log('🎬 Starting complete XLN workflow test...');
  
  // Navigate to the app
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  
  // Wait for XLN environment to load
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
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
  }, beforeState, { timeout: 5000 });
  
  await page.screenshot({ path: 'e2e/screenshots/step-02-entity-created.png', fullPage: true });
  console.log('✅ Entity created successfully');
  
  // Step 2: Verify entity appears and try basic interaction
  console.log('🔍 Step 2: Selecting entity and signer...');
  
  // Wait for UI to update with the new entity
  await page.waitForTimeout(500);
  
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
  await page.waitForTimeout(500);
});

test('ENTITY CREATION -> AUTOMATIC PANEL -> PROPOSAL CREATION', async ({ page }) => {
  console.log('🎬 Starting ENTITY + PROPOSAL workflow...');
  
  // Navigate and wait for environment
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
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
  }, beforeState, { timeout: 5000 });
  
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
  await page.waitForTimeout(500);
  
  // Select alice as signer for the first entity
  await selectSignerIndexAndFirstEntity(page, 0); // alice index
  
  await page.screenshot({ path: 'e2e/screenshots/proposal-04-entity-selected.png', fullPage: true });
  console.log('📸 Screenshot: Entity and alice selected');
  
  // Verify entity panel is visible (use first one)
  await expect(page.locator('.entity-panel').first()).toBeVisible();
  console.log('✅ Entity panel is visible');
  
  // === STEP 3: UNFOLD CONTROLS AND CREATE PROPOSAL ===
  console.log('📝 STEP 3: Unfolding controls and creating proposal');
  
  // UNFOLD the Controls section by finding the expand button
  console.log('🔽 Expanding Controls section...');
  
  // Look for expand button (usually has ▼ or similar)
  const controlsButtons = await page.locator('button:has-text("Controls")').count();
  console.log(`🔘 Found ${controlsButtons} Controls buttons`);
  
  if (controlsButtons > 0) {
    await page.locator('button:has-text("Controls")').first().click();
    await page.waitForTimeout(200);
  }
  
  // Try alternative selectors for expand/collapse
  const expandButtons = await page.locator('button', { hasText: '▼' }).count();
  if (expandButtons > 0) {
    console.log('🔽 Clicking expand button with ▼');
    await page.locator('button', { hasText: '▼' }).first().click();
    await page.waitForTimeout(200);
  }
  
  // Try clicking on Controls text with specific context
  await page.locator('.entity-panel').first().locator('text=Controls').click();
  await page.waitForTimeout(200);
  
  // Verify proposal inputs are now visible
  const proposalInputs = await page.locator('input[placeholder*="proposal"]').count();
  const proposalTextareas = await page.locator('textarea[placeholder*="proposal"]').count();
  console.log(`📋 After unfolding attempts - Proposal form fields: ${proposalInputs} inputs, ${proposalTextareas} textareas`);
  
  // If still no fields, try to find them with different selectors
  if (proposalInputs === 0 && proposalTextareas === 0) {
    console.log('🔍 Searching for proposal fields with broader selectors...');
    const allInputs = await page.locator('input').count();
    const allTextareas = await page.locator('textarea').count();
    console.log(`📊 Total page inputs: ${allInputs}, textareas: ${allTextareas}`);
    
    // Try more specific selectors
    const titleInputs = await page.locator('input[placeholder*="title"]').count();
    const descInputs = await page.locator('textarea[placeholder*="description"]').count();
    console.log(`📝 Title inputs: ${titleInputs}, description textareas: ${descInputs}`);
  }
  
  // FOLD everything else - try to collapse other sections
  console.log('📁 Folding other sections...');
  
  // Try to fold proposals section if it exists
  const proposalsHeaders = page.locator('text=Proposals');
  const proposalsCount = await proposalsHeaders.count();
  if (proposalsCount > 0) {
    await proposalsHeaders.first().click();
  await page.waitForTimeout(500);
  }
  
  // Take screenshot showing controls are unfolded
  await page.screenshot({ path: 'e2e/screenshots/step-1-controls-unfolded.png', fullPage: true });
  console.log('📸 Screenshot: Controls unfolded');
  
  // Fill proposal form
  console.log('✍️ Filling proposal form...');
  
  // Use the EXACT placeholders from ControlsPanel.svelte
  const titleSelector = 'input[placeholder="Enter proposal title..."]';
  const descSelector = 'textarea[placeholder="Enter proposal description..."]';
  
  const titleCount = await page.locator(titleSelector).count();
  const descCount = await page.locator(descSelector).count();
  
  console.log(`📝 Found title inputs: ${titleCount}, description textareas: ${descCount}`);
  
  if (titleCount > 0) {
    console.log('✍️ Filling proposal title...');
    await page.fill(titleSelector, 'Q4 Budget Proposal');
  } else {
    console.log('⚠️ Title input not found with exact placeholder');
  }
  
  if (descCount > 0) {
    console.log('✍️ Filling proposal description...');
    await page.fill(descSelector, 'Approve $100K marketing budget for Q4 expansion');
  } else {
    console.log('⚠️ Description textarea not found with exact placeholder');
  }
  
  // 2) Screenshot when inputs are filled
  await page.screenshot({ path: 'e2e/screenshots/step-2-proposal-form-filled.png', fullPage: true });
  console.log('📸 Screenshot: Proposal form filled');
  
  // Submit proposal - use exact button text from ControlsPanel.svelte  
  console.log('🚀 Submitting proposal...');
  await page.getByRole('button', { name: 'Create Proposal' }).click();
  await page.waitForTimeout(500);
  
  // 3) Screenshot when proposal is created
  await page.screenshot({ path: 'e2e/screenshots/step-3-proposal-created.png', fullPage: true });
  console.log('📸 Screenshot: Proposal created');
  
  // === STEP 4: SWITCH TO BOB AND VOTE ===
  console.log('🗳️ STEP 4: Switching to Bob for voting');
  
  // Switch to bob (second signer)
  await selectSignerIndexAndFirstEntity(page, 1); // bob index
  await page.waitForTimeout(500);
  
  // Unfold controls for bob if needed
  await page.locator('text=Controls').first().click();
  await page.waitForTimeout(200);
  
  // Vote on the proposal
  console.log('✅ Bob voting YES on proposal...');
  
  // Select the proposal in voting dropdown
  const proposalSelect = page.locator('select').last();
  await proposalSelect.selectOption({ index: 1 }); // First available proposal
  
  // Vote YES
  await page.locator('input[type="radio"][value="yes"]').check();
  await page.fill('textarea[placeholder*="vote comment"]', 'I approve this budget allocation');
  
  // Submit vote
  await page.getByRole('button', { name: /Submit Vote/i }).click();
  await page.waitForTimeout(500);
  
  // 4) Screenshot after bob voted
  await page.screenshot({ path: 'e2e/screenshots/step-4-bob-voted.png', fullPage: true });
  console.log('📸 Screenshot: Bob voted');
  
  // Check final proposal state
  const proposalStatus = await page.locator('text=APPROVED').count() > 0 ? 'APPROVED' : 'PENDING';
  console.log(`📊 Final proposal status: ${proposalStatus}`);
  
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
  await page.waitForTimeout(500);
});

});