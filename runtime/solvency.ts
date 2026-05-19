import { isLeftEntity } from './entity-id-utils';
import type { Env } from './types';

export interface Solvency {
  reserves: bigint;
  collateral: bigint;
  total: bigint;
  byToken: Map<number, { reserves: bigint; collateral: bigint; total: bigint }>;
}

export const calculateSolvency = (env: Env, snapshot?: Env): Solvency => {
  const targetEnv = snapshot || env;
  const byToken = new Map<number, { reserves: bigint; collateral: bigint; total: bigint }>();

  let reserves = 0n;
  let collateral = 0n;

  for (const [_replicaKey, replica] of targetEnv.eReplicas) {
    for (const [tokenId, amount] of replica.state.reserves) {
      reserves += amount;
      const existing = byToken.get(tokenId) || { reserves: 0n, collateral: 0n, total: 0n };
      existing.reserves += amount;
      existing.total = existing.reserves + existing.collateral;
      byToken.set(tokenId, existing);
    }

    for (const [counterpartyId, account] of replica.state.accounts) {
      if (isLeftEntity(replica.state.entityId, counterpartyId)) {
        for (const [tokenId, delta] of account.deltas) {
          collateral += delta.collateral;
          const existing = byToken.get(tokenId) || { reserves: 0n, collateral: 0n, total: 0n };
          existing.collateral += delta.collateral;
          existing.total = existing.reserves + existing.collateral;
          byToken.set(tokenId, existing);
        }
      }
    }
  }

  return { reserves, collateral, total: reserves + collateral, byToken };
};

export const verifySolvency = (env: Env, expected?: bigint, label?: string): boolean => {
  const solvency = calculateSolvency(env);
  const prefix = label ? `[${label}] ` : '';

  if (expected !== undefined && solvency.total !== expected) {
    console.error(`❌ ${prefix}SOLVENCY VIOLATION: Expected ${expected}, got ${solvency.total}`);
    console.error(`   Reserves: ${solvency.reserves}, Collateral: ${solvency.collateral}`);
    throw new Error(`Solvency check failed: ${solvency.total} !== ${expected}`);
  }

  console.log(`✅ ${prefix}Solvency: ${solvency.total} (R:${solvency.reserves} + C:${solvency.collateral})`);
  return true;
};
