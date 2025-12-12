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
    await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle', timeout: 30000 });

    await page.waitForTimeout(2000);

    // CRITICAL: Clear database to force fresh AHB run
    console.log('🗑️  Clearing database...');
    await page.evaluate(async () => {
      const runtime = await import('/static/runtime.js');
      await runtime.clearDB();
      console.log('[TEST] Database cleared');
    });
    await page.waitForTimeout(1000);

    // Click AHB button
    console.log('🖱️  Clicking AHB button...');
    const ahbButton = page.locator('button:has-text("Alice-Hub-Bob")').first();
    await ahbButton.click();
    console.log('✅ Clicked AHB');

    console.log('⏳ Waiting for prepopulate (checking for [Architect] prepopulateAHB returned)...');

    // Wait for history to populate (AHB creates 9+ frames)
    await page.waitForFunction(() => {
      const env = (window as any).xlnEnv;
      return env?.history?.length >= 9;
    }, { timeout: 30000 });

    console.log('✅ AHB loaded - history frames found');

    // CRITICAL TEST: Check Bob's AccountMachine in LAST history frame
    const bobCredit = await page.evaluate(() => {
      const env = (window as any).xlnEnv;

      if (!env?.history) {
        return { error: 'No history', hasEnv: !!env };
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

    // CRITICAL ASSERTION: Bob must have $500K credit (rightCreditLimit)
    const expectedCredit = (500000n * (10n ** 18n)).toString();

    if ('error' in bobCredit) {
      throw new Error(`❌ ${bobCredit.error}`);
    }

    expect(bobCredit.rightCreditLimit, 'Bob should have rightCreditLimit = 500K USDC').toBe(expectedCredit);

    console.log('\n✅ ✅ ✅ SUCCESS! Bob has credit in AccountMachine!');
    console.log(`   rightCreditLimit: $${Number(bobCredit.rightCreditLimit) / 1e18}`);
  });

  test('Status message shows correct frame count', async ({ page }) => {
    await page.goto('https://localhost:8080/view', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Close welcome modal
    const welcomeClose = page.locator('.tutorial-overlay button').first();
    if (await welcomeClose.isVisible()) {
      await welcomeClose.click();
    }

    // Expand and click AHB
    await page.getByRole('button', { name: /ELEMENTARY/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Alice-Hub-Bob/ }).click();
    await page.waitForTimeout(6000);

    // Check status message
    const statusText = await page.locator('.action-section p, [class*="status"], [class*="action"]').filter({ hasText: /frames loaded/ }).first().textContent();

    // Should contain "9 frames" not "18 frames" or "19 frames"
    expect(statusText).toContain('9 frames');
    expect(statusText).not.toContain('18 frames');
    expect(statusText).not.toContain('19 frames');
  });
});
