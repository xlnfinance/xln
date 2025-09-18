import { expect, test } from '@playwright/test';

import type { EntityReplica, Proposal, XLNEnvironment } from '../../frontend/src/lib/types/index.js';

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
      const env = (window as any).xlnEnv as XLNEnvironment;
      const replicas = Array.from(env.replicas.values()) as EntityReplica[];
      const totalProposals = replicas.reduce((sum, r) => sum + (r?.state?.proposals?.size || 0), 0);
      return { totalProposals, replicaCount: replicas.length };
    });

    console.log(
      `📊 BEFORE: ${beforeProposals.totalProposals} proposals across ${beforeProposals.replicaCount} replicas`,
    );

    // Select first entity and alice
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

    // Expand controls
    await page.getByRole('button', { name: '⚙️ Controls ▼' }).click();
    await page.waitForTimeout(300);

    // Select proposal mode
    await page.locator('#controls-tab-1').getByRole('combobox').selectOption('proposal');
    await page.waitForTimeout(200);

    // Fill and submit proposal
    await page
      .locator('#controls-tab-1')
      .getByRole('textbox', { name: 'Enter proposal title...' })
      .fill('Backend Test Proposal');
    await page
      .locator('#controls-tab-1')
      .getByRole('textbox', { name: 'Enter proposal description...' })
      .fill('Testing backend state');

    await page.locator('#controls-tab-1').getByRole('button', { name: 'Create Proposal' }).click();
    await page.waitForTimeout(1000);

    // Check backend state after proposal
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

      return {
        totalProposals,
        replicaCount: replicas.length,
        proposals: allProposals,
      };
    });

    console.log(`📊 AFTER: ${afterProposals.totalProposals} proposals across ${afterProposals.replicaCount} replicas`);
    console.log('📋 Proposals found:', afterProposals.proposals);

    // Verify proposal was created
    expect(afterProposals.totalProposals).toBeGreaterThan(beforeProposals.totalProposals);

    const newProposal = afterProposals.proposals.find(p => p.title === 'Backend Test Proposal: Testing backend state');
    expect(newProposal).toBeDefined();

    console.log('✅ SUCCESS: Proposal created in backend!');
    console.log(`📝 Found: "${newProposal?.title}" by ${newProposal?.proposer}`);

    await page.screenshot({ path: 'e2e/screenshots/backend-proposal-success.png', fullPage: true });
  });
});
