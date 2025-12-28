/**
 * Solvency Check Utility
 * Verifies total reserves + collateral equals expected value
 */

import type { Env } from '../types';

export function checkSolvency(env: Env, expected: bigint, label: string, optional: boolean = false): void {
  let reserves = 0n;
  let collateral = 0n;

  console.log(`[SOLVENCY ${label}] Checking ${env.eReplicas.size} replicas...`);

  for (const [replicaKey, replica] of env.eReplicas) {
    let replicaReserves = 0n;
    for (const [, amount] of replica.state.reserves) {
      replicaReserves += amount;
      reserves += amount;
    }
    console.log(`  [${replicaKey.slice(0,20)}] reserves=${replicaReserves / 10n**18n}M`);

    for (const [counterpartyId, account] of replica.state.accounts) {
      if (replica.state.entityId < counterpartyId) {
        for (const [, delta] of account.deltas) {
          collateral += delta.collateral;
        }
      }
    }
  }

  const total = reserves + collateral;
  console.log(`[SOLVENCY ${label}] Total: reserves=${reserves / 10n**18n}M, collateral=${collateral / 10n**18n}M, sum=${total / 10n**18n}M`);

  if (total !== expected) {
    console.error(`❌ [${label}] SOLVENCY FAIL: ${total} !== ${expected}`);
    if (!optional) {
      throw new Error(`SOLVENCY VIOLATION at "${label}": got ${total}, expected ${expected}`);
    } else {
      console.warn(`⚠️  [${label}] Solvency check failed but continuing (optional mode)`);
    }
  } else {
    console.log(`✅ [${label}] Solvency OK`);
  }
}
