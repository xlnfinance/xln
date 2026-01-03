/**
 * Deep verification of scenario correctness
 * Loads JSON dumps and checks invariants
 */

import { safeStringify } from './serialization-utils';

async function verifyScenario(jsonPath: string, scenarioName: string) {
  console.log(`\n🔍 DEEP VERIFICATION: ${scenarioName}`);
  console.log('═'.repeat(60));

  const fs = await import('fs');
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  const checks = {
    passed: 0,
    failed: 0,
    warnings: 0
  };

  // Extract entities
  const entities = data.eReplicas || [];
  console.log(`\n📊 Entities: ${entities.length}`);

  // Check 1: Solvency (reserves + collateral = constant)
  let totalReserves = 0n;
  let totalCollateral = 0n;

  for (const [key, replica] of entities) {
    const state = replica.state;

    // Sum reserves
    if (state.reserves) {
      for (const [, amountStr] of Object.entries(state.reserves)) {
        const amount = parseBigInt(amountStr as string);
        totalReserves += amount;
      }
    }

    // Sum collateral (only count once per bilateral account - left entity only)
    if (state.accounts) {
      for (const [counterpartyId, account] of Object.entries(state.accounts as any)) {
        if (state.entityId < counterpartyId) { // Only count from left side
          if (account.deltas) {
            for (const [, delta] of Object.entries(account.deltas as any)) {
              totalCollateral += parseBigInt((delta as any).collateral);
            }
          }
        }
      }
    }
  }

  const totalValue = totalReserves + totalCollateral;
  const EXPECTED_SOLVENCY = 10_000_000n * 10n ** 18n; // $10M

  if (totalValue === EXPECTED_SOLVENCY) {
    console.log(`✅ SOLVENCY: ${formatBigInt(totalValue)} (reserves + collateral)`);
    checks.passed++;
  } else {
    console.log(`❌ SOLVENCY FAIL: ${formatBigInt(totalValue)} != ${formatBigInt(EXPECTED_SOLVENCY)}`);
    checks.failed++;
  }

  // Check 2: No remaining locks (all HTLCs settled)
  let totalLocks = 0;
  for (const [, replica] of entities) {
    const state = replica.state;
    if (state.accounts) {
      for (const [, account] of Object.entries(state.accounts as any)) {
        totalLocks += Object.keys((account as any).locks || {}).length;
      }
    }
  }

  if (totalLocks === 0) {
    console.log(`✅ LOCKS: All settled (0 remaining)`);
    checks.passed++;
  } else {
    console.log(`⚠️  LOCKS: ${totalLocks} still active (may be intentional)`);
    checks.warnings++;
  }

  // Check 3: Bilateral sync (both sides have identical deltas)
  let syncChecks = 0;
  let syncFails = 0;

  for (const [key1, replica1] of entities) {
    const state1 = replica1.state;

    if (state1.accounts) {
      for (const [counterpartyId, account1] of Object.entries(state1.accounts as any)) {
        // Find counterparty's replica
        const replica2Entry = entities.find(([k]) => k.startsWith(counterpartyId + ':'));
        if (!replica2Entry) continue;

        const state2 = replica2Entry[1].state;
        const account2 = state2.accounts?.[state1.entityId];

        if (!account2) {
          console.log(`❌ BILATERAL SYNC: ${state1.entityId.slice(-4)} has account with ${counterpartyId.slice(-4)}, but counterparty doesn't have reverse account`);
          syncFails++;
          continue;
        }

        // Compare deltas
        const deltas1 = (account1 as any).deltas || {};
        const deltas2 = (account2 as any).deltas || {};

        for (const [tokenId, delta1] of Object.entries(deltas1)) {
          const delta2 = deltas2[tokenId];
          if (!delta2) continue;

          const fields = ['collateral', 'ondelta', 'offdelta', 'leftCreditLimit', 'rightCreditLimit'];
          for (const field of fields) {
            const val1 = parseBigInt((delta1 as any)[field]);
            const val2 = parseBigInt((delta2 as any)[field]);

            if (val1 !== val2) {
              console.log(`❌ SYNC FAIL: ${state1.entityId.slice(-4)}↔${counterpartyId.slice(-4)} token ${tokenId} ${field}: ${val1} != ${val2}`);
              syncFails++;
            }
          }
        }

        syncChecks++;
      }
    }
  }

  if (syncFails === 0) {
    console.log(`✅ BILATERAL SYNC: All ${syncChecks} accounts synchronized`);
    checks.passed++;
  } else {
    console.log(`❌ BILATERAL SYNC: ${syncFails} mismatches found`);
    checks.failed++;
  }

  // Check 4: HTLC fees earned (if applicable)
  let totalFees = 0n;
  for (const [, replica] of entities) {
    const fees = parseBigInt(replica.state.htlcFeesEarned || 'BigInt(0)');
    if (fees > 0n) {
      console.log(`💰 ${replica.state.entityId.slice(-4)} earned fees: ${formatBigInt(fees)}`);
      totalFees += fees;
    }
  }

  if (totalFees > 0n) {
    console.log(`✅ HTLC FEES: Total ${formatBigInt(totalFees)} collected`);
    checks.passed++;
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log(`VERIFICATION SUMMARY:`);
  console.log(`  ✅ Passed: ${checks.passed}`);
  console.log(`  ❌ Failed: ${checks.failed}`);
  console.log(`  ⚠️  Warnings: ${checks.warnings}`);
  console.log('═'.repeat(60) + '\n');

  return checks.failed === 0;
}

// Helper: Parse BigInt from serialized string
function parseBigInt(str: any): bigint {
  if (typeof str === 'bigint') return str;
  if (typeof str === 'number') return BigInt(str);
  if (typeof str !== 'string') return 0n;

  // Handle "BigInt(123)" format
  const match = str.match(/BigInt\((-?\d+)\)/);
  if (match) return BigInt(match[1]);

  // Handle plain number string
  if (/^-?\d+$/.test(str)) return BigInt(str);

  return 0n;
}

// Helper: Format BigInt for display
function formatBigInt(amount: bigint, decimals: number = 18): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const absWhole = whole < 0n ? -whole : whole;

  if (absWhole >= 1000n) {
    return `$${(Number(absWhole) / 1000).toFixed(0)}k`;
  }

  return `$${absWhole}`;
}

// Run verifications
if (import.meta.main) {
  const ahbOk = await verifyScenario('/tmp/ahb-final.json', 'ahb.ts');
  const lockAhbOk = await verifyScenario('/tmp/lock-ahb-final.json', 'lock-ahb.ts');

  if (ahbOk && lockAhbOk) {
    console.log('🎉 ALL SCENARIOS VERIFIED ✅\n');
    process.exit(0);
  } else {
    console.log('❌ VERIFICATION FAILED - see errors above\n');
    process.exit(1);
  }
}
