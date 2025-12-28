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

// Token helpers
const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;
export const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

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
