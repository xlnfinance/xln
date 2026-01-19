/**
 * Solvency Check Utility
 * Verifies total reserves + collateral equals expected value
 */

import type { Env } from '../types';
import { isLeftEntity } from '../entity-id-utils';

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
      if (isLeftEntity(replica.state.entityId, counterpartyId)) {
        for (const [, delta] of account.deltas) {
          collateral += delta.collateral;
        }
      }
    }
  }

  const total = reserves + collateral;
  console.log(`[SOLVENCY ${label}] Total: reserves=${reserves / 10n**18n}M, collateral=${collateral / 10n**18n}M, sum=${total / 10n**18n}M`);

  if (total !== expected) {
    if (!optional) {
      console.error(`❌ [${label}] SOLVENCY FAIL: ${total} !== ${expected}`);
      throw new Error(`SOLVENCY VIOLATION at "${label}": got ${total}, expected ${expected}`);
    } else {
      console.warn(`⚠️  [${label}] SOLVENCY MISMATCH (optional): ${total} !== ${expected} - continuing`);
    }
  } else {
    console.log(`✅ [${label}] Solvency OK`);
  }
}
