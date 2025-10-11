import { expect, test } from '@playwright/test';

test.describe('Final Proposal Execution', () => {
  test('ALICE CREATES PROPOSAL → BOB VOTES → EXECUTED + COLLECTIVE MESSAGE', async ({ page }) => {
    console.log('🎬 Starting FINAL PROPOSAL EXECUTION with runDemo()...');

    // === SETUP: Use runDemo for quick entity creation ===
    await page.goto('http://localhost:8080');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });

    await page.screenshot({ path: 'e2e/screenshots/final-01-start.png', fullPage: true });
    console.log('📸 Screenshot: App started');

    // Run demo to get entities quickly
    await page.locator('button[title="Run Demo"]').click();
    await page.waitForTimeout(500); // Wait for demo to complete

    await page.screenshot({ path: 'e2e/screenshots/final-02-demo-run.png', fullPage: true });
    console.log('📸 Screenshot: Demo entities created');

    // === ALICE CREATES PROPOSAL ===
    console.log('👩 STEP 1: Alice selecting entity and creating proposal');

    await page.locator('.admin-topbar').getByTitle('Add Entity Panel').click();
    // Second panel
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
      .locator('[data-value="Ethereum:alice:0x0000000000000000000000000000000000000000000000000000000000000001"]')
      .first();
    await aliceOption.click();
    await page.waitForTimeout(500);

    await expect(firstPanel.getByText('Entity 0001')).toBeVisible();
    await expect(firstPanel.getByText('Signer: alice')).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/final-03-alice-selected.png', fullPage: true });
    console.log('📸 Screenshot: Alice selected');

    // Expand Controls for Alice
    const aliceControlsHeader = firstPanel.getByRole('button', { name: '⚙️ Controls ▼' });
    await aliceControlsHeader.click();
    await page.waitForTimeout(300);

    // Switch to proposal mode
    await firstPanel.getByRole('combobox').selectOption('proposal');
    await page.waitForTimeout(200);

    // Fill proposal form
    const proposalTitle = 'Executive Budget Decision';
    const proposalDescription = 'Approve emergency budget allocation of $75K for critical infrastructure upgrades';

    await firstPanel.getByRole('textbox', { name: 'Enter proposal title...' }).fill(proposalTitle);
    await firstPanel.getByRole('textbox', { name: 'Enter proposal description...' }).fill(proposalDescription);

    await page.screenshot({ path: 'e2e/screenshots/final-04-proposal-form.png', fullPage: true });
    console.log('📸 Screenshot: Alice filled proposal form');

    // Submit proposal
    await firstPanel.getByRole('button', { name: 'Create Proposal' }).click();
    await page.waitForTimeout(1000);

    await page.screenshot({ path: 'e2e/screenshots/final-05-proposal-created.png', fullPage: true });
    console.log('📸 Screenshot: Proposal created by Alice');

    // Verify proposal appears
    const aliceProposalsHeader = firstPanel.getByRole('button', { name: '📋 Proposals ▼' });
    await aliceProposalsHeader.click();
    await page.waitForTimeout(300);

    await expect(firstPanel.locator('.proposal-item')).toBeVisible();
    await expect(firstPanel.locator('#proposals-tab-1').getByText('Executive Budget Decision:')).toBeVisible();
    await expect(firstPanel.getByText('PENDING')).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/final-06-proposal-visible.png', fullPage: true });
    console.log('📸 Screenshot: Proposal visible and PENDING');

    // === BOB VOTES ===
    console.log('👨 STEP 2: Bob selecting entity and voting YES');

    // Use second panel for Bob
    const secondPanel = page.locator('.entity-panel').nth(1);

    // Select same entity for Bob
    const bobEntityDropdown = secondPanel.locator('.unified-dropdown').first();
    await bobEntityDropdown.click();
    await page.waitForTimeout(300);

    const bobOption = secondPanel
      .locator('[data-value="Ethereum:bob:0x0000000000000000000000000000000000000000000000000000000000000001"]')
      .first();
    await bobOption.click();
    await page.waitForTimeout(500);

    await expect(secondPanel.getByText('Entity 0001')).toBeVisible();
    await expect(secondPanel.getByText('Signer: bob')).toBeVisible();

    await page.screenshot({ path: 'e2e/screenshots/final-07-bob-selected.png', fullPage: true });
    console.log('📸 Screenshot: Bob selected');

    // Expand Controls for Bob
    const bobControlsHeader = secondPanel.getByRole('button', { name: '⚙️ Controls ▼' });
    await bobControlsHeader.click();
    await page.waitForTimeout(300);

    // Switch to vote mode
    await secondPanel.getByRole('combobox').selectOption('vote');
    await page.waitForTimeout(200);

    // Select the proposal to vote on (find one that contains our title)
    await secondPanel.getByRole('combobox').nth(1).selectOption({ index: 1 });
    await page.waitForTimeout(200);

    // Vote YES
    await secondPanel.getByRole('combobox').nth(2).selectOption('yes');
    await page.waitForTimeout(200);

    await secondPanel
      .getByRole('textbox', { name: 'Add a comment to your vote...' })
      .fill('Approved - this budget allocation is critical for our infrastructure');
    await page.waitForTimeout(200);

    await page.screenshot({ path: 'e2e/screenshots/final-08-bob-voting.png', fullPage: true });
    console.log('📸 Screenshot: Bob voting YES');

    // Submit vote
    await secondPanel.getByRole('button', { name: 'Submit Vote' }).click();
    await page.waitForTimeout(1000);

    await page.screenshot({ path: 'e2e/screenshots/final-09-bob-voted.png', fullPage: true });
    console.log('📸 Screenshot: Bob voted');

    // === VERIFY EXECUTION ===
    console.log('🎉 STEP 3: Verifying proposal execution and collective message');

    // Check proposal status in Alice's panel
    await expect(firstPanel.locator('.proposal-item')).toContainText('APPROVED');

    await page.screenshot({ path: 'e2e/screenshots/final-10-proposal-approved.png', fullPage: true });
    console.log('📸 Screenshot: Proposal APPROVED');

    // Check for collective message in chat
    const chatMessages = firstPanel.locator('.chat-messages');

    await expect(chatMessages).toBeVisible();
    await expect(chatMessages).toContainText('[COLLECTIVE]');
    await expect(chatMessages).toContainText(proposalTitle);

    await page.screenshot({ path: 'e2e/screenshots/final-11-collective-message.png', fullPage: true });
    console.log('📸 Screenshot: Collective message in chat');

    // === FINAL SUCCESS STATE ===
    // Show all sections expanded for complete view
    await aliceProposalsHeader.click(); // Expand proposals
    await page.waitForTimeout(300);

    await page.screenshot({ path: 'e2e/screenshots/final-12-complete-success.png', fullPage: true });
    console.log('📸 Screenshot: COMPLETE SUCCESS - All workflow executed');

    console.log('🎉 FINAL SUCCESS! Complete proposal execution verified:');
    console.log('✅ Alice created proposal');
    console.log('✅ Bob voted YES');
    console.log('✅ Proposal executed and approved');
    console.log('✅ Collective message generated');
    console.log('✅ Complete video and screenshots captured');
    console.log('✅ ALL SCREENS AVAILABLE FOR USER REVIEW');
  });
});
