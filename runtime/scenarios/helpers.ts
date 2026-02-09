/**
 * Shared scenario helpers
 */

import type { Env, RoutedEntityInput, EntityReplica, Delta, RuntimeInput } from '../types';
import type { AccountKey, TokenId } from '../ids';
import { formatRuntime } from '../runtime-ascii';
import { setFailFastErrors } from '../logger';
import { getCachedSignerPrivateKey, deriveSignerKeySync, registerSignerKey } from '../account-crypto';

// Lazy-loaded process to avoid circular deps
let _process: ((env: Env, inputs?: RoutedEntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
let _applyRuntimeInput: ((env: Env, runtimeInput: RuntimeInput) => Promise<{ entityOutbox: RoutedEntityInput[]; mergedInputs: RoutedEntityInput[] }>) | null = null;

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

export function requireRuntimeSeed(env: Env, label: string): string {
  const envSeed = env.runtimeSeed ?? null;
  const processSeed = (typeof process !== 'undefined' && process.env)
    ? (process.env['XLN_RUNTIME_SEED'] || process.env['RUNTIME_SEED'] || null)
    : null;
  const seed = envSeed ?? processSeed;
  if (seed === null || seed === undefined) {
    throw new Error(`${label}: runtimeSeed missing - unlock vault or set XLN_RUNTIME_SEED`);
  }
  if (env.runtimeSeed === undefined || env.runtimeSeed === null) {
    env.runtimeSeed = seed;
  }
  return seed;
}

export function ensureSignerKeysFromSeed(env: Env, signerIds: string[], label: string): void {
  const seed = requireRuntimeSeed(env, label);
  for (const signerId of signerIds) {
    if (getCachedSignerPrivateKey(signerId)) {
      continue;
    }
    const privateKey = deriveSignerKeySync(seed, signerId);
    registerSignerKey(signerId, privateKey);
  }
}

type ScenarioLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<ScenarioLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let strictScenarioDepth = 0;
let strictScenarioLogLevel: ScenarioLogLevel = 'info';
let strictScenarioOriginalLog: typeof console.log | null = null;
let strictScenarioOriginalInfo: typeof console.info | null = null;
let strictScenarioOriginalWarn: typeof console.warn | null = null;
let strictScenarioOriginalDebug: typeof console.debug | null = null;
let strictScenarioOriginalError: typeof console.error | null = null;

const getScenarioTickMs = (env: Env): number => {
  if (!env.jReplicas || env.jReplicas.size === 0) return 1;
  let maxDelay = 0;
  for (const replica of env.jReplicas.values()) {
    const delay = typeof replica.blockDelayMs === 'number' ? replica.blockDelayMs : 0;
    if (delay > maxDelay) maxDelay = delay;
  }
  return Math.max(1, maxDelay);
};

export const advanceScenarioTime = (env: Env, stepMs?: number, force: boolean = false): void => {
  if (!force && !env.scenarioMode) return;
  const step = Math.max(1, stepMs ?? getScenarioTickMs(env));
  // env.timestamp is typed as number - add step directly
  env.timestamp = (env.timestamp || 0) + step;
};

export async function waitScenario(env: Env, ms: number): Promise<void> {
  if (ms <= 0) return;
  // Always simulate time for scenarios; avoid real sleeps.
  advanceScenarioTime(env, ms, true);
}

function shouldEmitScenarioLog(level: ScenarioLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[strictScenarioLogLevel];
}

export function enableStrictScenario(env: Env, label: string): () => void {
  env.strictScenario = true;
  env.strictScenarioLabel = label;
  if (!env.scenarioLogLevel) {
    env.scenarioLogLevel = env.quietRuntimeLogs ? 'warn' : 'info';
  }
  strictScenarioLogLevel = env.scenarioLogLevel;
  setFailFastErrors(true);

  if (strictScenarioDepth === 0) {
    strictScenarioOriginalLog = console.log;
    strictScenarioOriginalInfo = console.info;
    strictScenarioOriginalWarn = console.warn;
    strictScenarioOriginalDebug = console.debug;
    strictScenarioOriginalError = console.error;
    const formatConsoleArg = (arg: unknown): string => {
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'bigint') return `${arg.toString()}n`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    };
    console.log = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('info')) {
        strictScenarioOriginalLog?.(...args);
      }
    };
    console.info = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('info')) {
        strictScenarioOriginalInfo?.(...args);
      }
    };
    console.warn = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('warn')) {
        strictScenarioOriginalWarn?.(...args);
      }
    };
    console.debug = (...args: unknown[]) => {
      if (shouldEmitScenarioLog('debug')) {
        strictScenarioOriginalDebug?.(...args);
      }
    };
    console.error = (...args: unknown[]) => {
      strictScenarioOriginalError?.(...args);
      throw new Error(`[${label}] console.error: ${args.map(formatConsoleArg).join(' ')}`);
    };
  }

  strictScenarioDepth += 1;

  return () => {
    strictScenarioDepth = Math.max(0, strictScenarioDepth - 1);
    if (strictScenarioDepth === 0) {
      env.strictScenario = false;
      delete env.strictScenarioLabel;
      if (strictScenarioOriginalLog) {
        console.log = strictScenarioOriginalLog;
        strictScenarioOriginalLog = null;
      }
      if (strictScenarioOriginalInfo) {
        console.info = strictScenarioOriginalInfo;
        strictScenarioOriginalInfo = null;
      }
      if (strictScenarioOriginalWarn) {
        console.warn = strictScenarioOriginalWarn;
        strictScenarioOriginalWarn = null;
      }
      if (strictScenarioOriginalDebug) {
        console.debug = strictScenarioOriginalDebug;
        strictScenarioOriginalDebug = null;
      }
      if (strictScenarioOriginalError) {
        console.error = strictScenarioOriginalError;
        strictScenarioOriginalError = null;
      }
      setFailFastErrors(false);
    }
  };
}

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
  const account = leftRep.state.accounts.get(rightId as AccountKey);
  return account?.deltas.get(tokenId as TokenId)?.offdelta || 0n;
}

// ============================================================================
// CONVERGENCE HELPERS
// ============================================================================

function filterOfflineInputs(
  inputs: RoutedEntityInput[],
  offlineSigners: Set<string>,
): { filtered: RoutedEntityInput[]; dropped: RoutedEntityInput[] } {
  if (offlineSigners.size === 0) {
    return { filtered: inputs, dropped: [] };
  }

  const filtered: RoutedEntityInput[] = [];
  const dropped: RoutedEntityInput[] = [];

  for (const input of inputs) {
    if (offlineSigners.has(input.signerId)) {
      dropped.push(input);
    } else {
      filtered.push(input);
    }
  }

  return { filtered, dropped };
}

export async function processWithOffline(
  env: Env,
  inputs: RoutedEntityInput[] | undefined,
  offlineSigners: Set<string>,
  reason: string = 'offline',
): Promise<Env> {
  const process = await getProcess();

  if (offlineSigners.size === 0) {
    return process(env, inputs);
  }

  const pending = env.pendingOutputs || [];
  const { filtered: filteredPending, dropped: droppedPending } = filterOfflineInputs(pending, offlineSigners);
  if (droppedPending.length > 0) {
    env.info('network', 'OFFLINE_SIGNER_DROP', {
      reason,
      source: 'pendingOutputs',
      signers: Array.from(new Set(droppedPending.map(i => i.signerId))),
      count: droppedPending.length,
      entities: Array.from(new Set(droppedPending.map(i => i.entityId))),
    });
  }
  env.pendingOutputs = filteredPending;

  const { filtered: filteredInputs, dropped: droppedInputs } = filterOfflineInputs(inputs || [], offlineSigners);
  if (droppedInputs.length > 0) {
    env.info('network', 'OFFLINE_SIGNER_DROP', {
      reason,
      source: 'inputs',
      signers: Array.from(new Set(droppedInputs.map(i => i.signerId))),
      count: droppedInputs.length,
      entities: Array.from(new Set(droppedInputs.map(i => i.entityId))),
    });
  }

  return process(env, filteredInputs);
}

/**
 * Process frames until all mempools empty and no pending frames
 * Standard convergence - used in all scenarios
 */
export async function converge(env: Env, maxCycles = 10): Promise<void> {
  const process = await getProcess();
  for (let i = 0; i < maxCycles; i++) {
    await process(env);
    advanceScenarioTime(env);
    let hasWork = false;
    const pendingOutputs = env.pendingOutputs?.length || 0;
    const pendingNetwork = env.pendingNetworkOutputs?.length || 0;
    const pendingInbox = env.networkInbox?.length || 0;
    const pendingInputs = env.runtimeInput?.entityInputs?.length || 0;
    if (pendingOutputs > 0 || pendingNetwork > 0 || pendingInbox > 0 || pendingInputs > 0) {
      hasWork = true;
    }
    for (const [, replica] of env.eReplicas) {
      // Check entity-level work (multi-signer consensus)
      if (replica.mempool.length > 0 || replica.proposal || replica.lockedFrame) {
        hasWork = true;
        break;
      }
      // Check account-level work (bilateral consensus)
      for (const [, account] of replica.state.accounts) {
        if (account.mempool.length > 0 || account.proposal) {
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
  label: string = 'condition',
  onTick?: (round: number) => void,
  onFail?: () => void
): Promise<void> {
  const process = await getProcess();
  for (let round = 0; round < maxRounds; round++) {
    // Check first
    if (predicate()) return;

    // Process local state
    await process(env);
    onTick?.(round + 1);
    advanceScenarioTime(env, undefined, true);

    // Yield to event loop to allow WS messages to be received
    await new Promise(resolve => setTimeout(resolve, 10));

    // Check again after processing
    if (predicate()) return;
  }
  if (!predicate()) {
    onFail?.();
    throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
  }
}

/**
 * Converge with offline signers (drops inputs to specified signerIds)
 * Checks BOTH entity-level AND account-level work (like regular converge)
 */
export async function convergeWithOffline(
  env: Env,
  offlineSigners: Set<string>,
  maxCycles = 10,
  reason: string = 'offline',
): Promise<void> {
  for (let i = 0; i < maxCycles; i++) {
    await processWithOffline(env, undefined, offlineSigners, reason);
    advanceScenarioTime(env);
    let hasWork = false;
    const pendingOutputs = env.pendingOutputs?.length || 0;
    const pendingNetwork = env.pendingNetworkOutputs?.length || 0;
    const pendingInbox = env.networkInbox?.length || 0;
    const pendingInputs = env.runtimeInput?.entityInputs?.length || 0;
    if (pendingOutputs > 0 || pendingNetwork > 0 || pendingInbox > 0 || pendingInputs > 0) {
      hasWork = true;
    }
    for (const [, replica] of env.eReplicas) {
      // Check entity-level work (multi-signer consensus) - CRITICAL for multi-sig
      if (replica.mempool.length > 0 || replica.proposal || replica.lockedFrame) {
        hasWork = true;
        break;
      }
      // Check account-level work (bilateral consensus)
      for (const [, account] of replica.state.accounts) {
        if (account.mempool.length > 0 || account.proposal) {
          hasWork = true;
          break;
        }
      }
      if (hasWork) break;
    }
    if (!hasWork) return;
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

  const accountFromA = replicaA?.state?.accounts?.get(entityB as AccountKey);
  const accountFromB = replicaB?.state?.accounts?.get(entityA as AccountKey);

  if (!accountFromA || !accountFromB) {
    throw new Error(`BILATERAL-SYNC FAIL: Missing account at ${label}`);
  }

  const deltaFromA = accountFromA.deltas?.get(tokenId as TokenId);
  const deltaFromB = accountFromB.deltas?.get(tokenId as TokenId);

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

/** Format bigint as USD string (e.g. "$1,234.56") */
export const formatUSD = (amount: bigint): string => {
  const whole = amount / ONE_TOKEN;
  const frac = (amount % ONE_TOKEN) * 100n / ONE_TOKEN;
  return `$${whole.toLocaleString()}.${frac.toString().padStart(2, '0')}`;
};

/**
 * Drain runtime - keep processing until all pending work is done
 * Used before assertRuntimeIdle to ensure everything is flushed
 */
export async function drainRuntime(env: Env, maxIterations: number = 20): Promise<Env> {
  const process = await getProcess();
  let iterations = 0;

  while (iterations < maxIterations) {
    const pendingOutputs = env.pendingOutputs?.length || 0;
    const pendingInputs = env.runtimeInput?.entityInputs?.length || 0;
    const pendingInbox = env.networkInbox?.length || 0;
    const pendingNetwork = env.pendingNetworkOutputs?.length || 0;

    const totalPending = pendingOutputs + pendingInputs + pendingInbox + pendingNetwork;
    if (totalPending === 0) break;

    env = await process(env);
    iterations++;
  }

  return env;
}

export function assertRuntimeIdle(env: Env, label: string = 'runtime'): void {
  const errors: string[] = [];

  const pendingOutputs = env.pendingOutputs?.length || 0;
  const pendingInputs = env.runtimeInput?.entityInputs?.length || 0;
  const pendingInbox = env.networkInbox?.length || 0;
  const pendingNetwork = env.pendingNetworkOutputs?.length || 0;

  if (pendingOutputs > 0) errors.push(`pendingOutputs=${pendingOutputs}`);
  if (pendingInputs > 0) errors.push(`runtimeInput.entityInputs=${pendingInputs}`);
  if (pendingInbox > 0) errors.push(`networkInbox=${pendingInbox}`);
  if (pendingNetwork > 0) errors.push(`pendingNetworkOutputs=${pendingNetwork}`);

  for (const jReplica of env.jReplicas?.values() || []) {
    if (jReplica.mempool.length > 0) {
      errors.push(`jReplica:${jReplica.name} mempool=${jReplica.mempool.length}`);
    }
  }

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    for (const [counterpartyId, account] of replica.state.accounts.entries()) {
      if (account.proposal) {
        errors.push(`pendingFrame ${replicaKey}↔${counterpartyId.slice(-4)}`);
      }
      if (account.mempool.length > 0) {
        errors.push(`accountMempool ${replicaKey}↔${counterpartyId.slice(-4)}=${account.mempool.length}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`RUNTIME NOT IDLE (${label}): ${errors.join('; ')}`);
  }
}

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
    subtitle: {
      title,
      ...(opts.what ? { what: opts.what } : {}),
      ...(opts.why ? { why: opts.why } : {}),
      ...(opts.tradfiParallel ? { tradfiParallel: opts.tradfiParallel } : {}),
      ...(opts.keyMetrics ? { keyMetrics: opts.keyMetrics } : {}),
    },
    ...(opts.expectedSolvency !== undefined ? { expectedSolvency: opts.expectedSolvency } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}
