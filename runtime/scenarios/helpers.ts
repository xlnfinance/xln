/**
 * Shared scenario helpers
 */

import type { Env, EntityInput } from '../types';

// Lazy-loaded process to avoid circular deps
let _process: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
let _applyRuntimeInput: ((env: Env, runtimeInput: any) => Promise<Env>) | null = null;

export const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../runtime');
    _process = runtime.process;
  }
  return _process;
};

export const getApplyRuntimeInput = async () => {
  if (!_applyRuntimeInput) {
    const runtime = await import('../runtime');
    _applyRuntimeInput = runtime.applyRuntimeInput;
  }
  return _applyRuntimeInput;
};

export { checkSolvency } from './solvency-check';

// ============================================================================
// ENTITY LOOKUP HELPERS
// ============================================================================

/**
 * Find entity replica by ID prefix (handles "entityId:signerId" composite keys)
 */
export function findReplica(env: Env, entityId: string): [string, EntityReplica] {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`Replica for entity ${entityId} not found`);
  }
  return entry as [string, EntityReplica];
}

/**
 * Get offdelta from LEFT entity's perspective (canonical bilateral view)
 */
export function getOffdelta(env: Env, leftId: string, rightId: string, tokenId: number): bigint {
  const [, leftRep] = findReplica(env, leftId);
  const account = leftRep.state.accounts.get(rightId);
  return account?.deltas.get(tokenId)?.offdelta || 0n;
}

// ============================================================================
// CONVERGENCE HELPERS
// ============================================================================

/**
 * Process frames until all mempools empty and no pending frames
 * Standard convergence - used in all scenarios
 */
export async function converge(env: Env, maxCycles = 10): Promise<void> {
  const process = await getProcess();
  for (let i = 0; i < maxCycles; i++) {
    await process(env);
    let hasWork = false;
    for (const [, replica] of env.eReplicas) {
      for (const [, account] of replica.state.accounts) {
        if (account.mempool.length > 0 || account.pendingFrame) {
          hasWork = true;
          break;
        }
      }
      if (hasWork) break;
    }
    if (!hasWork) return;
  }
}

/**
 * Process until predicate condition met (conditional convergence)
 * Useful for waiting on specific state changes
 */
export async function processUntil(
  env: Env,
  predicate: () => boolean,
  maxRounds: number = 10,
  label: string = 'condition'
): Promise<void> {
  const process = await getProcess();
  for (let round = 0; round < maxRounds; round++) {
    if (predicate()) return;
    await process(env);
  }
  if (!predicate()) {
    throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
  }
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert with full runtime state dump on failure (critical debugging tool)
 */
export function assert(condition: unknown, message: string, env?: Env): asserts condition {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED - FULL RUNTIME STATE:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20, maxSwaps: 20 }));
      console.log('='.repeat(80) + '\n');
    }
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`[OK] ${message}`);
}

/**
 * Verify bilateral consensus - both sides have identical delta state
 * CRITICAL for bilateral correctness testing
 */
export function assertBilateralSync(
  env: Env,
  entityA: string,
  entityB: string,
  tokenId: number,
  label: string
): void {
  console.log(`\n[BILATERAL-SYNC ${label}] Checking ${entityA.slice(-4)}←→${entityB.slice(-4)} for token ${tokenId}...`);

  const [, replicaA] = findReplica(env, entityA);
  const [, replicaB] = findReplica(env, entityB);

  const accountFromA = replicaA?.state?.accounts?.get(entityB);
  const accountFromB = replicaB?.state?.accounts?.get(entityA);

  if (!accountFromA || !accountFromB) {
    throw new Error(`BILATERAL-SYNC FAIL: Missing account at ${label}`);
  }

  const deltaFromA = accountFromA.deltas?.get(tokenId);
  const deltaFromB = accountFromB.deltas?.get(tokenId);

  if (!deltaFromA || !deltaFromB) {
    throw new Error(`BILATERAL-SYNC FAIL: Missing delta at ${label}`);
  }

  // Check all 7 delta fields match exactly
  const fieldsToCheck: Array<keyof Delta> = [
    'collateral',
    'ondelta',
    'offdelta',
    'leftCreditLimit',
    'rightCreditLimit',
    'leftAllowance',
    'rightAllowance',
  ];

  const errors: string[] = [];
  for (const field of fieldsToCheck) {
    const valueAB = deltaFromA[field];
    const valueBA = deltaFromB[field];

    if (valueAB !== valueBA) {
      const msg = `${field}: ${entityA.slice(-4)} has ${valueAB}, ${entityB.slice(-4)} has ${valueBA}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
    }
  }

  if (errors.length > 0) {
    throw new Error(`BILATERAL-SYNC VIOLATION at "${label}":\n${errors.join('\n')}`);
  }

  console.log(`✅ [${label}] Bilateral sync OK: ${entityA.slice(-4)}←→${entityB.slice(-4)} token ${tokenId} - all 7 fields match\n`);
}

// ============================================================================
// TOKEN CONVERSION HELPERS
// ============================================================================

const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;
export const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;
export const eth = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;
export const btc = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;
export const dai = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

// Set snapshot extras before process() - call this, then call process()
export function snap(
  env: Env,
  title: string,
  opts: {
    what?: string;
    why?: string;
    tradfiParallel?: string;
    keyMetrics?: string[];
    expectedSolvency?: bigint;
    description?: string;
  } = {}
) {
  env.extra = {
    subtitle: { title, what: opts.what, why: opts.why, tradfiParallel: opts.tradfiParallel, keyMetrics: opts.keyMetrics },
    expectedSolvency: opts.expectedSolvency,
    description: opts.description,
  };
}
