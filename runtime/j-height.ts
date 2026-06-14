import type { Env } from './types';
import { getJReplicaByJurisdictionRef } from './jurisdiction-runtime';

export const PRODUCTION_DISPUTE_DELAY_BLOCKS = 5_760;

export function getRuntimeJurisdictionHeight(env: Env, fallbackHeight = 0, jurisdictionName?: string): number {
  const fallback = Number.isFinite(fallbackHeight) ? Math.max(0, Math.floor(fallbackHeight)) : 0;
  if (jurisdictionName) {
    const requested = getJReplicaByJurisdictionRef(env, jurisdictionName);
    if (!requested) return fallback;
    const blockNumber = Number(requested?.blockNumber ?? 0n);
    return Number.isFinite(blockNumber) ? Math.max(0, Math.floor(blockNumber)) : fallback;
  }

  const active = env.activeJurisdiction ? env.jReplicas?.get(env.activeJurisdiction) : undefined;
  const candidates = active
    ? [active, ...Array.from(env.jReplicas?.values?.() || [])]
    : Array.from(env.jReplicas?.values?.() || []);
  let best = fallback;
  for (const replica of candidates) {
    const blockNumber = Number(replica?.blockNumber ?? 0n);
    if (Number.isFinite(blockNumber) && blockNumber > best) best = Math.floor(blockNumber);
  }
  return best;
}

export function getRuntimeJurisdictionDefaultDisputeDelayBlocks(
  env: Env,
  jurisdictionName?: string,
  fallbackBlocks = PRODUCTION_DISPUTE_DELAY_BLOCKS,
): number {
  const preferred =
    getJReplicaByJurisdictionRef(env, jurisdictionName) ||
    (env.activeJurisdiction ? env.jReplicas?.get(env.activeJurisdiction) : undefined);
  const candidates = preferred
    ? [preferred, ...Array.from(env.jReplicas?.values?.() || [])]
    : Array.from(env.jReplicas?.values?.() || []);
  for (const replica of candidates) {
    const raw = Number(replica?.defaultDisputeDelayBlocks ?? NaN);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  }
  return Number.isFinite(fallbackBlocks) && fallbackBlocks > 0
    ? Math.floor(fallbackBlocks)
    : PRODUCTION_DISPUTE_DELAY_BLOCKS;
}

export function requireRuntimeJurisdictionBlockTimeMs(env: Env, jurisdictionName?: string): number {
  const preferred =
    getJReplicaByJurisdictionRef(env, jurisdictionName) ||
    (env.activeJurisdiction ? env.jReplicas?.get(env.activeJurisdiction) : undefined);
  const raw = Number(preferred?.blockTimeMs ?? NaN);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  throw new Error(`JURISDICTION_BLOCK_TIME_MISSING:${jurisdictionName || env.activeJurisdiction || 'active'}`);
}

export function requireRuntimeJurisdictionDisputeDelayMs(
  env: Env,
  jurisdictionName?: string,
  fallbackBlocks = PRODUCTION_DISPUTE_DELAY_BLOCKS,
): number {
  const blocks = getRuntimeJurisdictionDefaultDisputeDelayBlocks(env, jurisdictionName, fallbackBlocks);
  const blockTimeMs = requireRuntimeJurisdictionBlockTimeMs(env, jurisdictionName);
  return blocks * blockTimeMs;
}
