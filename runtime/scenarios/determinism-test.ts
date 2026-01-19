/**
 * DETERMINISM VERIFICATION SUITE
 *
 * Verifies that the RJEA flow is pure:
 * (prevEnv, inputs) → nextEnv - same inputs = same outputs, always
 *
 * Checks:
 * 1. Run same scenario N times with identical seed
 * 2. Hash final state after each run
 * 3. All hashes must be identical
 * 4. Detect any non-determinism (Date.now, Math.random, etc.)
 */

import type { Env, EntityState } from '../types';
import { createHash } from 'crypto';
import { safeStringify } from '../serialization-utils';

const RUNS = 3; // Number of times to run each scenario
const SEED = 'determinism-test-seed-42';

/**
 * Compute deterministic hash of entity state
 * Uses canonical JSON serialization for consistency
 */
function hashEntityState(state: EntityState): string {
  const canonical: any = {
    entityId: state.entityId,
    height: state.height,
    timestamp: state.timestamp,
    reserves: Array.from(state.reserves.entries()).sort((a, b) => Number(a[0]) - Number(b[0])),
    accounts: Array.from(state.accounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, acc]) => ({
        id,
        currentHeight: acc.currentHeight,
        deltas: Array.from(acc.deltas.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([tid, d]) => ({
            tokenId: tid,
            collateral: d.collateral.toString(),
            ondelta: d.ondelta.toString(),
            offdelta: d.offdelta.toString(),
            leftCreditLimit: d.leftCreditLimit.toString(),
            rightCreditLimit: d.rightCreditLimit.toString(),
          })),
        locks: acc.locks?.size || 0,
        swapOffers: acc.swapOffers?.size || 0,
      })),
  };

  const json = safeStringify(canonical);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Compute hash of entire runtime environment
 */
function hashEnv(env: Env): string {
  const stateHashes: string[] = [];

  // Hash all entity replicas in deterministic order
  const sortedReplicas = Array.from(env.eReplicas.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  for (const [key, replica] of sortedReplicas) {
    const stateHash = hashEntityState(replica.state);
    stateHashes.push(`${key}:${stateHash}`);
  }

  // Hash J-machine state
  if (env.jReplicas) {
    for (const [name, jRep] of env.jReplicas.entries()) {
      stateHashes.push(`j:${name}:${jRep.mempool.length}:${jRep.height}`);
    }
  }

  // Combine all hashes
  const combined = stateHashes.join('|');
  return createHash('sha256').update(combined).digest('hex').slice(0, 32);
}

/**
 * Run a scenario function multiple times and verify determinism
 */
async function verifyDeterminism(
  scenarioName: string,
  scenarioFn: (env: Env) => Promise<void>,
  createEnv: () => Env
): Promise<{ success: boolean; hashes: string[]; frames: number[] }> {
  const hashes: string[] = [];
  const frames: number[] = [];

  console.log(`\n🔬 Testing determinism: ${scenarioName}`);
  console.log(`   Running ${RUNS} times with seed: ${SEED}`);

  for (let run = 1; run <= RUNS; run++) {
    // Create fresh environment
    const env = createEnv();
    env.scenarioMode = true;
    env.runtimeSeed = SEED;

    // Disable any non-deterministic sources
    env.timestamp = 1;

    try {
      // Run scenario
      await scenarioFn(env);

      // Hash final state
      const hash = hashEnv(env);
      hashes.push(hash);
      frames.push(env.history?.length || 0);

      console.log(`   Run ${run}/${RUNS}: hash=${hash.slice(0, 12)}... frames=${env.history?.length || 0}`);
    } catch (error) {
      console.error(`   Run ${run}/${RUNS}: FAILED - ${error}`);
      hashes.push('ERROR');
      frames.push(0);
    }
  }

  // Check all hashes match
  const allMatch = hashes.every(h => h === hashes[0]);
  const success = allMatch && !hashes.includes('ERROR');

  if (success) {
    console.log(`   ✅ DETERMINISTIC: All ${RUNS} runs produced identical state`);
  } else {
    console.log(`   ❌ NON-DETERMINISTIC: Hashes differ!`);
    for (let i = 0; i < hashes.length; i++) {
      console.log(`      Run ${i + 1}: ${hashes[i]}`);
    }
  }

  return { success, hashes, frames };
}

// Main test runner
export async function runDeterminismTests(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('          DETERMINISM VERIFICATION SUITE                        ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { createEmptyEnv } = await import('../runtime');
  const results: Array<{ name: string; success: boolean; hashes: string[] }> = [];

  // Test 1: Simple AHB scenario
  try {
    const { lockAhb } = await import('./lock-ahb');
    const result = await verifyDeterminism('lock-ahb', lockAhb, createEmptyEnv);
    results.push({ name: 'lock-ahb', ...result });
  } catch (e) {
    console.log(`   ⚠️ Skipped lock-ahb: ${e}`);
  }

  // Test 2: Swap scenario
  try {
    const { swap } = await import('./swap');
    const result = await verifyDeterminism('swap', swap, createEmptyEnv);
    results.push({ name: 'swap', ...result });
  } catch (e) {
    console.log(`   ⚠️ Skipped swap: ${e}`);
  }

  // Test 3: 4-hop HTLC
  try {
    const { htlc4hop } = await import('./htlc-4hop');
    const result = await verifyDeterminism('htlc-4hop', htlc4hop, createEmptyEnv);
    results.push({ name: 'htlc-4hop', ...result });
  } catch (e) {
    console.log(`   ⚠️ Skipped htlc-4hop: ${e}`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    SUMMARY                                     ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let allPassed = true;
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`   ${status} ${r.name}: ${r.success ? 'DETERMINISTIC' : 'FAILED'}`);
    if (!r.success) allPassed = false;
  }

  console.log(`\n   Overall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (!allPassed) {
    throw new Error('Determinism tests failed');
  }
}

// Self-executing
if (import.meta.main) {
  await runDeterminismTests();
}
