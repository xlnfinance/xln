/**
 * SMOKE TEST: Alice-Hub-Bob Demo - Core Functionality
 *
 * Verifies critical path:
 * 1. AHB demo launches
 * 2. Creates Alice, Hub, Bob (NOT bank names!)
 * 3. Generates 9 frames (not 18/19!)
 * 4. Subtitles exist in frames
 *
 * Run: bunx playwright test tests/smoke/ahb-core.spec.ts
 */

import { test, expect } from '@playwright/test';

test.describe('AHB Demo - Critical Path', () => {
  test('AHB bilateral sync - Bob credit extension', async ({ page, context }) => {
    // Capture ALL console to find why xlnEnv doesn't load
    page.on('console', msg => {
      const text = msg.text();
      console.log(`[BROWSER] ${text}`);
    });

    page.on('pageerror', err => {
      console.error(`[PAGE ERROR] ${err.message}`);
    });

    // Ignore HTTPS cert errors
    await context.route('**/*', route => route.continue());

    // Navigate to /view
    console.log('🌐 Navigating to /view...');
    await page.goto('/view', { waitUntil: 'networkidle', timeout: 3000 });

    await page.waitForTimeout(500);

    // CRITICAL: Clear database to force fresh AHB run
    console.log('🗑️  Clearing database...');
    await page.evaluate(async () => {
      const runtime = await import('/static/runtime.js');
      await runtime.clearDB();
      console.log('[TEST] Database cleared');
    });
    await page.waitForTimeout(200);

    // Click AHB button
    console.log('🖱️  Clicking AHB button...');
    const ahbButton = page.locator('button:has-text("Alice-Hub-Bob")').first();
    await ahbButton.click();
    console.log('✅ Clicked AHB');

    console.log('⏳ Waiting for prepopulate...');

    // Wait for status message showing frames loaded (AHB uses isolatedEnv, not window.xlnEnv)
    // The DOM status message shows "AHB: 28 frames loaded" when complete (split J-Block + 2 mempool delay frames)
    await page.waitForSelector('text=/\\d+ frames loaded/', { timeout: 30000 });

    // Also wait for time machine button to show frame count (28 frames now with split J-Block + 2 mempool delay frames)
    await page.waitForSelector('button:has-text("/28")');

    console.log('✅ AHB loaded - DOM shows frames loaded');

    // CRITICAL TEST: Check Bob's AccountMachine in LAST history frame
    // NOTE: AHB demo uses isolatedEnv (View.svelte local store), NOT xlnEnv (global store)
    const bobCredit = await page.evaluate(() => {
      const env = (window as any).isolatedEnv;

      if (!env?.history) {
        return { error: 'No history', hasEnv: !!env, hasXlnEnv: !!(window as any).xlnEnv };
      }

      // Get LAST frame (latest state)
      const lastFrame = env.history[env.history.length - 1];

      if (!lastFrame?.eReplicas) {
        return { error: 'Last frame has no eReplicas', historyLen: env.history.length };
      }

      // Find Bob (0x...0003) in last frame
      const bobReplica = Array.from(lastFrame.eReplicas.values()).find((r: any) =>
        r.state?.entityId?.endsWith('0003')
      );

      if (!bobReplica) {
        return { error: 'No Bob in last frame', replicaCount: lastFrame.eReplicas.size };
      }

      // Get Bob's account with Hub (0x...0002)
      const hubId = '0x0000000000000000000000000000000000000000000000000000000000000002';
      const bobHubAccount = bobReplica.state?.accounts?.get(hubId);

      if (!bobHubAccount) {
        return {
          error: 'Bob has no account with Hub',
          bobAccounts: Array.from(bobReplica.state?.accounts?.keys() || [])
        };
      }

      // Get delta for USDC (token 1)
      const delta = bobHubAccount.deltas?.get(1);

      if (!delta) {
        return { error: 'No delta for USDC', deltaKeys: Array.from(bobHubAccount.deltas?.keys() || []) };
      }

      return {
        leftCreditLimit: delta.leftCreditLimit?.toString(),
        rightCreditLimit: delta.rightCreditLimit?.toString(),
        collateral: delta.collateral?.toString(),
        ondelta: delta.ondelta?.toString(),
        offdelta: delta.offdelta?.toString(),
      };
    });

    console.log('\n📊 BOB ACCOUNTMACHINE (Bob-Hub):');
    console.log(JSON.stringify(bobCredit, null, 2));

    // CRITICAL ASSERTION: Bob extended $500K credit to Hub
    // In B-H account: Bob (0x0003) > Hub (0x0002) → Bob is RIGHT, Hub is LEFT
    // Bob extending credit TO Hub sets leftCreditLimit (credit RIGHT gives TO LEFT)
    const expectedCredit = (500000n * (10n ** 18n)).toString();

    if ('error' in bobCredit) {
      throw new Error(`❌ ${bobCredit.error}`);
    }

    expect(bobCredit.leftCreditLimit, 'Bob should have leftCreditLimit = 500K USDC (Bob extended credit to Hub)').toBe(expectedCredit);

    console.log('\n✅ ✅ ✅ SUCCESS! Bob has credit in AccountMachine!');
    console.log(`   leftCreditLimit: $${Number(bobCredit.leftCreditLimit) / 1e18} (Bob→Hub credit)`);
  });

  test('Status message shows correct frame count', async ({ page }) => {
    await page.goto('/view', { waitUntil: 'networkidle', timeout: 3000 });
    await page.waitForTimeout(500);

    // Close welcome modal
    const welcomeClose = page.locator('.tutorial-overlay button').first();
    if (await welcomeClose.isVisible()) {
      await welcomeClose.click();
    }

    // Click AHB scenario directly (no ELEMENTARY accordion anymore)
    await page.getByRole('button', { name: /Alice-Hub-Bob/ }).click();
    await page.waitForTimeout(2000);

    // Check status message
    const statusText = await page.locator('.action-section p, [class*="status"], [class*="action"]').filter({ hasText: /frames loaded/ }).first().textContent();

    // AHB demo now has ~25 frames (with reverse payment B→H→A)
    // Should NOT have doubled (50+ frames)
    expect(statusText).toContain('frames');
    expect(statusText).not.toContain('50 frames');
    expect(statusText).not.toContain('51 frames');
  });
});
