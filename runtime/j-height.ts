import type { Env } from './types';

export function getRuntimeJurisdictionHeight(env: Env, fallbackHeight = 0): number {
  const active = env.activeJurisdiction ? env.jReplicas?.get(env.activeJurisdiction) : undefined;
  const candidates = active
    ? [active, ...Array.from(env.jReplicas?.values?.() || [])]
    : Array.from(env.jReplicas?.values?.() || []);
  let best = Number.isFinite(fallbackHeight) ? Math.max(0, Math.floor(fallbackHeight)) : 0;
  for (const replica of candidates) {
    const blockNumber = Number(replica?.blockNumber ?? 0n);
    if (Number.isFinite(blockNumber) && blockNumber > best) best = Math.floor(blockNumber);
  }
  return best;
}

export function getRuntimeJurisdictionDefaultDisputeDelayBlocks(
  env: Env,
  jurisdictionName?: string,
  fallbackBlocks = 5,
): number {
  const preferred =
    (jurisdictionName && env.jReplicas?.get(jurisdictionName)) ||
    (env.activeJurisdiction ? env.jReplicas?.get(env.activeJurisdiction) : undefined);
  const candidates = preferred
    ? [preferred, ...Array.from(env.jReplicas?.values?.() || [])]
    : Array.from(env.jReplicas?.values?.() || []);
  for (const replica of candidates) {
    const raw = Number(replica?.defaultDisputeDelayBlocks ?? NaN);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  }
  return Number.isFinite(fallbackBlocks) && fallbackBlocks > 0 ? Math.floor(fallbackBlocks) : 5;
}
