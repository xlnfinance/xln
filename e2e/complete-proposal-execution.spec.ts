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

async function selectEntityAndSigner(page, panelIndex: number, entityIndex: number, signerIndex: number) {
  const panel = page.locator('.entity-panel').nth(panelIndex);
  
  // Click entity dropdown in specific panel
  const entityDropdown = panel.locator('.unified-dropdown').first();
  await entityDropdown.click();
  await page.waitForTimeout(300);
  
  // Select entity
  const entityOption = page.locator('#dropdownResults .dropdown-item').nth(entityIndex);
  await entityOption.click();
  await page.waitForTimeout(300);
  
  // Click signer dropdown in same panel
  const signerDropdown = panel.locator('.unified-dropdown').nth(1);
  await signerDropdown.click();
  await page.waitForTimeout(300);
  
  // Select signer
  const signerOption = page.locator('#dropdownResults .dropdown-item').nth(signerIndex);
  await signerOption.click();
  await page.waitForTimeout(500);
}

test.describe('Complete Proposal Execution E2E', () => {

test('ALICE CREATES PROPOSAL → BOB VOTES → PROPOSAL EXECUTED + COLLECTIVE MESSAGE', async ({ page }) => {
  console.log('🎬 Starting COMPLETE PROPOSAL EXECUTION workflow...');
  
  // === STEP 1: SETUP ===
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
  await page.screenshot({ path: 'e2e/screenshots/execution-01-start.png', fullPage: true });
  console.log('📸 Screenshot: App started');

  // === STEP 2: CREATE ENTITY ===
  console.log('🏗️ STEP 2: Creating entity with alice and bob');
  
  await page.locator('text=Formation').click();
  await page.fill('#entityNameInput', 'Governance Council');
  
  await addValidator(page);
  await pickSignerInRow(page, 0, 'alice');
  await pickSignerInRow(page, 1, 'bob');
  await setThreshold(page, 2); // Both must vote for execution
  
  await page.screenshot({ path: 'e2e/screenshots/execution-02-entity-form.png', fullPage: true });
  console.log('📸 Screenshot: Entity form filled');
  
  await page.getByRole('button', { name: /Create Entity/i }).click();
  
  // Wait for entity creation and auto-panels
  await page.waitForFunction(() => {
    const env = (window as any).xlnEnv;
    return env?.replicas?.size > 0;
  }, { timeout: 5000 });
  
  await page.waitForTimeout(1000);
  
  await page.screenshot({ path: 'e2e/screenshots/execution-03-entity-created.png', fullPage: true });
  console.log('📸 Screenshot: Entity created + auto panels');

  // === STEP 3: ALICE SELECTS ENTITY AND CREATES PROPOSAL ===
  console.log('👩 STEP 3: Alice selecting entity and creating proposal');
  
  // Select entity and alice in first panel
  const firstPanel = page.locator('.entity-panel').first();
  await selectEntityAndSigner(page, 0, 0, 0); // First panel, first entity, alice
  
  await page.screenshot({ path: 'e2e/screenshots/execution-04-alice-selected.png', fullPage: true });
  console.log('📸 Screenshot: Alice selected in first panel');
  
  // Expand Controls for Alice
  const aliceControlsHeader = firstPanel.locator('.component-header').filter({ hasText: 'Controls' });
  await aliceControlsHeader.click();
  await page.waitForTimeout(300);
  
  // Switch to proposal mode
  const aliceControlsDropdown = firstPanel.locator('.controls-dropdown');
  await aliceControlsDropdown.selectOption('proposal');
  await page.waitForTimeout(200);
  
  // Fill proposal form
  const proposalTitle = 'Q4 Budget Approval';
  const proposalDescription = 'Approve $50K budget for Q4 development and marketing initiatives';
  
  await firstPanel.locator('input[placeholder="Enter proposal title..."]').fill(proposalTitle);
  await firstPanel.locator('textarea[placeholder="Enter proposal description..."]').fill(proposalDescription);
  
  await page.screenshot({ path: 'e2e/screenshots/execution-05-proposal-form.png', fullPage: true });
  console.log('📸 Screenshot: Alice filled proposal form');
  
  // Submit proposal
  await firstPanel.locator('button:has-text("Create Proposal")').click();
  await page.waitForTimeout(1000);
  
  await page.screenshot({ path: 'e2e/screenshots/execution-06-proposal-created.png', fullPage: true });
  console.log('📸 Screenshot: Proposal created by Alice');
  
  // Verify proposal in proposals section
  const aliceProposalsHeader = firstPanel.locator('.component-header').filter({ hasText: 'Proposals' });
  await aliceProposalsHeader.click();
  await page.waitForTimeout(300);
  
  // Check proposal shows as PENDING with 1 vote (Alice auto-voted)
  await expect(firstPanel.locator('.proposal-item')).toBeVisible();
  await expect(firstPanel.locator('text=' + proposalTitle)).toBeVisible();
  
  await page.screenshot({ path: 'e2e/screenshots/execution-07-proposal-pending.png', fullPage: true });
  console.log('📸 Screenshot: Proposal visible and PENDING');

  // === STEP 4: BOB SELECTS ENTITY AND VOTES ===
  console.log('👨 STEP 4: Bob selecting entity and voting YES');
  
  // Select entity and bob in second panel  
  const secondPanel = page.locator('.entity-panel').nth(1);
  await selectEntityAndSigner(page, 1, 0, 1); // Second panel, first entity, bob
  
  await page.screenshot({ path: 'e2e/screenshots/execution-08-bob-selected.png', fullPage: true });
  console.log('📸 Screenshot: Bob selected in second panel');
  
  // Expand Controls for Bob
  const bobControlsHeader = secondPanel.locator('.component-header').filter({ hasText: 'Controls' });
  await bobControlsHeader.click();
  await page.waitForTimeout(300);
  
  // Switch to vote mode
  const bobControlsDropdown = secondPanel.locator('.controls-dropdown');
  await bobControlsDropdown.selectOption('vote');
  await page.waitForTimeout(200);
  
  // Select the proposal to vote on
  const proposalSelectDropdown = secondPanel.locator('select').filter({ hasText: proposalTitle }).first();
  if (await proposalSelectDropdown.count() === 0) {
    // Fallback: select by index
    await secondPanel.locator('select').nth(1).selectOption({ index: 1 });
  } else {
    await proposalSelectDropdown.selectOption({ index: 1 });
  }
  await page.waitForTimeout(200);
  
  // Vote YES
  await secondPanel.locator('select:has(option:has-text("✅ Yes"))').selectOption('yes');
  await secondPanel.locator('textarea[placeholder*="vote comment"]').fill('I approve this budget allocation for Q4');
  
  await page.screenshot({ path: 'e2e/screenshots/execution-09-bob-voting.png', fullPage: true });
  console.log('📸 Screenshot: Bob voting YES with comment');
  
  // Submit vote
  await secondPanel.locator('button:has-text("Submit Vote")').click();
  await page.waitForTimeout(1000);
  
  await page.screenshot({ path: 'e2e/screenshots/execution-10-bob-voted.png', fullPage: true });
  console.log('📸 Screenshot: Bob submitted vote');

  // === STEP 5: VERIFY PROPOSAL EXECUTION ===
  console.log('🎉 STEP 5: Verifying proposal execution and collective message');
  
  // Check proposal status in Alice's panel (should be APPROVED/EXECUTED)
  const aliceProposalStatus = firstPanel.locator('.proposal-item');
  await expect(aliceProposalStatus).toContainText('APPROVED');
  await expect(aliceProposalStatus).toContainText('2 yes'); // Both alice and bob voted yes
  
  await page.screenshot({ path: 'e2e/screenshots/execution-11-proposal-approved.png', fullPage: true });
  console.log('📸 Screenshot: Proposal APPROVED with 2 YES votes');
  
  // Check chat for collective message (proposal execution creates a collective message)
  const aliceChatHeader = firstPanel.locator('.component-header').filter({ hasText: 'Chat' });
  await aliceChatHeader.click();
  await page.waitForTimeout(300);
  
  // Look for collective message containing proposal title
  const chatMessages = firstPanel.locator('.chat-messages');
  await expect(chatMessages).toContainText('[COLLECTIVE]');
  await expect(chatMessages).toContainText(proposalTitle);
  
  await page.screenshot({ path: 'e2e/screenshots/execution-12-collective-message.png', fullPage: true });
  console.log('📸 Screenshot: Collective message in chat');

  // === STEP 6: FINAL SUCCESS STATE ===
  console.log('✅ STEP 6: Capturing final success state');
  
  // Expand all sections to show complete state
  await aliceProposalsHeader.click(); // Show proposals
  await page.waitForTimeout(300);
  
  await page.screenshot({ path: 'e2e/screenshots/execution-13-final-success.png', fullPage: true });
  console.log('📸 Screenshot: FINAL SUCCESS - Complete workflow executed');

  // === STEP 7: VERIFICATION SUMMARY ===
  console.log('🔍 STEP 7: Final verification of complete workflow');
  
  const finalState = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    const replicas = Array.from(env.replicas.values());
    
    const allProposals = [];
    let totalProposals = 0;
    let totalMessages = 0;
    
    for (const replica of replicas) {
      if (replica?.state?.proposals) {
        const proposals = Array.from(replica.state.proposals.entries());
        totalProposals += proposals.length;
        allProposals.push(...proposals.map(([id, prop]) => ({ 
          id, 
          title: prop.action?.data?.message,
          status: prop.status || 'PENDING',
          votes: prop.votes ? Array.from(prop.votes.entries()) : []
        })));
      }
      if (replica?.state?.messages) {
        totalMessages += replica.state.messages.length;
      }
    }
    
    return { 
      totalProposals, 
      totalMessages,
      proposals: allProposals,
      replicaCount: replicas.length
    };
  });
  
  console.log('📊 FINAL STATE SUMMARY:');
  console.log(`   • ${finalState.replicaCount} replicas active`);
  console.log(`   • ${finalState.totalProposals} proposals created`);
  console.log(`   • ${finalState.totalMessages} messages exchanged`);
  console.log(`   • Proposals:`, finalState.proposals);
  
  // Verify success criteria
  expect(finalState.totalProposals).toBeGreaterThan(0);
  expect(finalState.totalMessages).toBeGreaterThan(0);
  
  const ourProposal = finalState.proposals.find(p => p.title === proposalTitle);
  expect(ourProposal).toBeDefined();
  expect(ourProposal?.votes.length).toBeGreaterThan(1); // Both alice and bob voted
  
  console.log('🎉 COMPLETE SUCCESS! Full proposal execution workflow verified:');
  console.log('✅ Alice created proposal');
  console.log('✅ Bob voted YES');
  console.log('✅ Proposal executed (2/2 threshold met)');
  console.log('✅ Collective message generated');
  console.log('✅ All states properly updated');
  console.log('✅ Complete video and screenshots captured');
});

});
