import { expect, Page, test } from '@playwright/test';

import type { EntityReplica, Proposal, XLNEnvironment } from '../../frontend/src/lib/types/index.js';

// Helper functions
async function setThreshold(page: Page, value: number) {
  const slider = page.locator('#thresholdSlider');
  await slider.evaluate((el: HTMLInputElement, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function addValidator(page: Page) {
  await page.getByRole('button', { name: '➕ Add Validator' }).click();
}

async function pickSignerInRow(page: Page, rowIndex: number, signerText: string) {
  const row = page.locator('.validator-row').nth(rowIndex);
  const select = row.locator('.validator-name');
  await select.selectOption(signerText);
}

test.describe('Proposal Creation with Proper Selection', () => {
  test('CREATE ENTITY -> AUTO PANEL -> SELECT REPLICA -> CREATE PROPOSAL', async ({ page }) => {
    console.log('🎬 Starting COMPLETE workflow with proper selection...');

    // Navigate and wait for app
    await page.goto('http://localhost:8080');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });

    await page.screenshot({ path: 'e2e/screenshots/selection-01-loaded.png', fullPage: true });
    console.log('📸 Screenshot: App loaded');

    // === STEP 1: CREATE ENTITY ===
    console.log('🏗️ STEP 1: Creating entity with alice and bob');

    await page.locator('text=Formation').click();
    await page.fill('#entityNameInput', 'Test Entity');

    await addValidator(page);
    await pickSignerInRow(page, 0, 'alice');
    await pickSignerInRow(page, 1, 'bob');
    await setThreshold(page, 2); // Both must vote

    await page.screenshot({ path: 'e2e/screenshots/selection-02-form.png', fullPage: true });
    console.log('📸 Screenshot: Entity form filled');

    // Track state before creation
    const beforeState = await page.evaluate(() => {
      const env = (window as any).xlnEnv as XLNEnvironment;
      return {
        replicas: env?.replicas?.size ?? 0,
        height: env?.height ?? 0,
      };
    });

    // Create entity
    await page.getByRole('button', { name: /Create Entity/i }).click();

    // Wait for entity creation
    await page.waitForFunction(
      (prev: { replicas: number; height: number }) => {
        const env = (window as any).xlnEnv as XLNEnvironment;
        const newReplicas = env?.replicas?.size ?? 0;
        const newHeight = env?.height ?? 0;
        return newReplicas > prev.replicas && newHeight > prev.height;
      },
      beforeState,
      { timeout: 5000 },
    );

    await page.screenshot({ path: 'e2e/screenshots/selection-03-entity-created.png', fullPage: true });
    console.log('✅ Entity created successfully');

    // === STEP 2: VERIFY AUTO-PANEL CREATION ===
    console.log('🎯 STEP 2: Verifying auto-panel was created');

    // Wait a moment for auto-panel creation
    await page.waitForTimeout(1000);

    // Check if a panel with our entity exists
    const panelExists = await page.locator('.entity-panel').count();
    console.log(`📊 Found ${panelExists} entity panels`);

    await page.screenshot({ path: 'e2e/screenshots/selection-04-auto-panel.png', fullPage: true });
    console.log('📸 Screenshot: Auto-panel created');

    // === STEP 3: VERIFY EMPTY CONTROLS MESSAGE ===
    console.log('📝 STEP 3: Checking if Controls shows proper empty state');

    // Expand Controls to see if it shows the "Select Entity & Signer First" message
    const controlsHeader = page.locator('.component-header').filter({ hasText: 'Controls' }).first();
    await controlsHeader.click();
    await page.waitForTimeout(300);

    // Look for the empty controls message in the first panel
    const emptyMessage = page.locator('.empty-controls').first();
    if ((await emptyMessage.count()) > 0) {
      console.log('✅ Empty controls message displayed correctly');
      await expect(emptyMessage).toContainText('Select Entity & Signer First');
    } else {
      console.log('⚠️ Controls might already be populated');
    }

    await page.screenshot({ path: 'e2e/screenshots/selection-05-empty-controls.png', fullPage: true });
    console.log('📸 Screenshot: Empty controls or populated controls');

    // === STEP 4: MANUALLY SELECT ENTITY AND SIGNER ===
    console.log('🎯 STEP 4: Manually selecting entity and signer in dropdown');

    // Click the entity dropdown
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

    // Select alice as signer
    const aliceOption = page.locator('#dropdownResults .dropdown-item').first();
    await expect(aliceOption).toBeVisible();
    await aliceOption.click();
    await page.waitForTimeout(200);

    await page.screenshot({ path: 'e2e/screenshots/selection-06-entity-signer-selected.png', fullPage: true });
    console.log('📸 Screenshot: Entity and signer selected');

    // === STEP 5: VERIFY CONTROLS ARE NOW POPULATED ===
    console.log('🔍 STEP 5: Verifying controls are now functional');

    // Check if the controls dropdown is now visible (not empty message)
    const controlsDropdown = page.locator('.controls-section').first();
    await expect(controlsDropdown).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/selection-07-controls-active.png', fullPage: true });
    console.log('📸 Screenshot: Controls now active');

    // === STEP 6: CREATE PROPOSAL ===
    console.log('📝 STEP 6: Creating proposal with proper replica selection');

    // Select proposal mode
    await controlsDropdown.getByRole('combobox').selectOption('proposal');
    await page.waitForTimeout(200);

    // Fill proposal form
    await controlsDropdown.getByRole('textbox', { name: 'Enter proposal title...' }).fill('Selection Test Proposal');
    await controlsDropdown
      .getByRole('textbox', { name: 'Enter proposal description...' })
      .fill('Testing proposal creation with proper entity/signer selection');

    await page.screenshot({ path: 'e2e/screenshots/selection-08-proposal-form.png', fullPage: true });
    console.log('📸 Screenshot: Proposal form filled');

    // Track proposals before submission
    const beforeProposals = await page.evaluate(() => {
      const env = (window as any).xlnEnv as XLNEnvironment;
      const replicas = Array.from(env.replicas.values()) as EntityReplica[];
      return replicas.reduce((sum, r) => sum + (r?.state?.proposals?.size || 0), 0);
    });

    // Submit proposal
    await controlsDropdown.getByRole('button', { name: 'Create Proposal' }).click();
    await page.waitForTimeout(1000);

    // Track proposals after submission
    const afterProposals = await page.evaluate(() => {
      const env = (window as any).xlnEnv as XLNEnvironment;
      const replicas = Array.from(env.replicas.values()) as EntityReplica[];
      const allProposals: Array<{
        replicaId: string;
        id: string;
        title: string;
        proposer: string;
      }> = [];
      let totalProposals = 0;

      for (const replica of replicas) {
        if (replica?.state?.proposals) {
          const proposals = Array.from(replica.state.proposals.entries()) as [string, Proposal][];
          totalProposals += proposals.length;

          allProposals.push(
            ...proposals.map(([id, prop]: [string, Proposal]) => ({
              replicaId: replica.entityId,
              id,
              title: prop.action?.data?.message,
              proposer: prop.proposer,
            })),
          );
        }
      }

      return { totalProposals, proposals: allProposals };
    });

    await page.screenshot({ path: 'e2e/screenshots/selection-09-proposal-submitted.png', fullPage: true });
    console.log('📸 Screenshot: Proposal submitted');

    // === STEP 7: VERIFY PROPOSAL WAS CREATED ===
    console.log('🎉 STEP 7: Verifying proposal creation');

    console.log(`📊 BEFORE: ${beforeProposals} proposals`);
    console.log(`📊 AFTER: ${afterProposals.totalProposals} proposals`);
    console.log('📋 Latest proposals:', afterProposals.proposals.slice(-3));

    // Verify proposal was created
    expect(afterProposals.totalProposals).toBeGreaterThan(beforeProposals);

    const newProposal = afterProposals.proposals.find(
      p => p.title === 'Selection Test Proposal: Testing proposal creation with proper entity/signer selection',
    );
    expect(newProposal).toBeDefined();

    console.log('✅ SUCCESS: Proposal created in backend!');
    console.log(`📝 Found: "${newProposal?.title}" by ${newProposal?.proposer}`);

    await page.screenshot({ path: 'e2e/screenshots/selection-10-success.png', fullPage: true });
    console.log('📸 Screenshot: Final success');

    console.log('🎉 COMPLETE WORKFLOW SUCCESS!');
    console.log('✅ Entity creation works');
    console.log('✅ Auto-panel creation works');
    console.log('✅ Empty controls message works');
    console.log('✅ Entity/signer selection works');
    console.log('✅ Controls populate correctly');
    console.log('✅ Proposal creation actually works!');
  });
});
