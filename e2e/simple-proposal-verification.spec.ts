import { test, expect } from '@playwright/test';

test.describe('Simple Proposal Verification', () => {

test('VERIFY: Proposal creation adds to backend state', async ({ page }) => {
  console.log('🔍 Testing proposal creation in backend...');
  
  // Navigate
  await page.goto('http://localhost:8080');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => (window as any).xlnEnv !== undefined, { timeout: 5000 });
  
  // Run demo to get entities quickly
  await page.getByRole('button', { name: '▶️' }).click();
  await page.waitForTimeout(1000);
  
  console.log('✅ Demo run - entities created');
  
  // Check backend state before proposal
  const beforeProposals = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    const replicas = Array.from(env.replicas.values());
    const totalProposals = replicas.reduce((sum, r) => sum + (r?.state?.proposals?.size || 0), 0);
    return { totalProposals, replicaCount: replicas.length };
  });
  
  console.log(`📊 BEFORE: ${beforeProposals.totalProposals} proposals across ${beforeProposals.replicaCount} replicas`);
  
  // Select first entity and alice
  await page.locator('.unified-dropdown').first().click();
  await page.locator('#dropdownResults .dropdown-item').first().click();
  await page.waitForTimeout(200);
  
  await page.locator('.unified-dropdown').nth(1).click();
  await page.locator('#dropdownResults .dropdown-item').first().click();
  await page.waitForTimeout(200);
  
  // Expand controls
  await page.locator('.component-header').filter({ hasText: 'Controls' }).first().click();
  await page.waitForTimeout(300);
  
  // Select proposal mode
  await page.selectOption('.controls-dropdown', 'proposal');
  await page.waitForTimeout(200);
  
  // Fill and submit proposal  
  await page.fill('input[placeholder="Enter proposal title..."]', 'Backend Test Proposal');
  await page.fill('textarea[placeholder="Enter proposal description..."]', 'Testing backend state');
  
  await page.click('button:has-text("Create Proposal")');
  await page.waitForTimeout(1000);
  
  // Check backend state after proposal
  const afterProposals = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    const replicas = Array.from(env.replicas.values());
    const allProposals = [];
    let totalProposals = 0;
    
    for (const replica of replicas) {
      if (replica?.state?.proposals) {
        const proposals = Array.from(replica.state.proposals.entries());
        totalProposals += proposals.length;
        allProposals.push(...proposals.map(([id, prop]) => ({ 
          replicaId: replica.entityId, 
          id, 
          title: prop.action?.data?.message,
          proposer: prop.proposer 
        })));
      }
    }
    
    return { 
      totalProposals, 
      replicaCount: replicas.length,
      proposals: allProposals
    };
  });
  
  console.log(`📊 AFTER: ${afterProposals.totalProposals} proposals across ${afterProposals.replicaCount} replicas`);
  console.log('📋 Proposals found:', afterProposals.proposals);
  
  // Verify proposal was created
  expect(afterProposals.totalProposals).toBeGreaterThan(beforeProposals.totalProposals);
  
  const newProposal = afterProposals.proposals.find(p => p.title === 'Backend Test Proposal');
  expect(newProposal).toBeDefined();
  
  console.log('✅ SUCCESS: Proposal created in backend!');
  console.log(`📝 Found: "${newProposal?.title}" by ${newProposal?.proposer}`);
  
  await page.screenshot({ path: 'e2e/screenshots/backend-proposal-success.png', fullPage: true });
});

});
