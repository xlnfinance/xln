/**
 * Account Bilateral Sync Test
 * Verifies Entity #3's view of account #3←→#2 matches Entity #2's view of #2←→#3
 */

import { test, expect } from '@playwright/test';

test('account bilateral sync on frame 12', async ({ page }) => {
  await page.goto('https://localhost:8080/view?scenario=ahb');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(6000); // Wait for AHB to complete

  // Get account data from both perspectives
  const accountData = await page.evaluate(() => {
    const env = (window as any).xlnEnv;
    if (!env?.eReplicas) return { error: 'No eReplicas', hasEnv: !!env };

    // Find Bob (0x...0003) and Hub (0x...0002)
    const bobReplica = Array.from(env.eReplicas.values()).find((r: any) =>
      r.state?.entityId?.endsWith('0003')
    );
    const hubReplica = Array.from(env.eReplicas.values()).find((r: any) =>
      r.state?.entityId?.endsWith('0002')
    );

    if (!bobReplica || !hubReplica) {
      return {
        error: 'Entities not found',
        hasBob: !!bobReplica,
        hasHub: !!hubReplica,
        replicaCount: env.eReplicas.size
      };
    }

    const hubId = '0x0000000000000000000000000000000000000000000000000000000000000002';
    const bobId = '0x0000000000000000000000000000000000000000000000000000000000000003';

    // Get Bob's view of Bob-Hub account
    const bobHubAccount = bobReplica.state?.accounts?.get(hubId);
    // Get Hub's view of Hub-Bob account
    const hubBobAccount = hubReplica.state?.accounts?.get(bobId);

    const bobDelta = bobHubAccount?.deltas?.get(1);
    const hubDelta = hubBobAccount?.deltas?.get(1);

    return {
      bob: {
        hasAccount: !!bobHubAccount,
        hasDelta: !!bobDelta,
        leftCredit: bobDelta?.leftCreditLimit?.toString() || '0',
        rightCredit: bobDelta?.rightCreditLimit?.toString() || '0',
        collateral: bobDelta?.collateral?.toString() || '0',
      },
      hub: {
        hasAccount: !!hubBobAccount,
        hasDelta: !!hubDelta,
        leftCredit: hubDelta?.leftCreditLimit?.toString() || '0',
        rightCredit: hubDelta?.rightCreditLimit?.toString() || '0',
        collateral: hubDelta?.collateral?.toString() || '0',
      }
    };
  });

  console.log('\n📊 ACCOUNT DATA:');
  console.log('Bob view:', accountData.bob);
  console.log('Hub view:', accountData.hub);

  // CRITICAL ASSERTIONS: Both sides must have accounts
  expect(accountData.bob.hasAccount, 'Bob should have account with Hub').toBe(true);
  expect(accountData.hub.hasAccount, 'Hub should have account with Bob').toBe(true);

  expect(accountData.bob.hasDelta, 'Bob should have delta for USDC').toBe(true);
  expect(accountData.hub.hasDelta, 'Hub should have delta for USDC').toBe(true);

  // CRITICAL ASSERTIONS: Bilateral sync - both sides must have IDENTICAL delta values
  expect(accountData.bob.leftCredit, 'Bob.leftCredit must equal Hub.leftCredit').toBe(accountData.hub.leftCredit);
  expect(accountData.bob.rightCredit, 'Bob.rightCredit must equal Hub.rightCredit').toBe(accountData.hub.rightCredit);
  expect(accountData.bob.collateral, 'Bob.collateral must equal Hub.collateral').toBe(accountData.hub.collateral);

  // CRITICAL: Bob extended $500K credit to Hub → rightCreditLimit should be 500K (500000e18)
  const expectedCredit = (500000n * (10n ** 18n)).toString();
  expect(accountData.bob.rightCredit, 'Bob should see $500K credit extended to Hub').toBe(expectedCredit);
  expect(accountData.hub.rightCredit, 'Hub should see $500K credit from Bob').toBe(expectedCredit);

  console.log('\n✅ ✅ ✅ ALL BILATERAL SYNC ASSERTIONS PASSED!');
  console.log(`✅ Bob extended $500K credit to Hub`);
  console.log(`✅ Both sides see rightCreditLimit = ${accountData.bob.rightCredit}`);
});
