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
