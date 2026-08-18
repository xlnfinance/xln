import type { EnvSnapshot, RuntimeReplica } from '../runtime/types';
import { startRuntimeHistoryTraceForTesting } from '../runtime/observability/history-retention';

/**
 * Browser scenario registry.
 *
 * Dynamic imports keep startup cheap. More importantly, this module belongs to
 * the browser composition root: production Runtime code never imports scenario
 * implementations back into its own dependency graph.
 */
export const scenarios = {
  ahb: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { ahb } = await import('./consensus/ahb');
    await ahb(env);
    return env;
  },
  lockAhb: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { lockAhb } = await import('./payments/lock-ahb');
    await lockAhb(env);
    return env;
  },
  swap: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { swap, swapWithOrderbook, multiPartyTrading } = await import('./market/swap');
    await swap(env);
    await swapWithOrderbook(env);
    await multiPartyTrading(env);
    return env;
  },
  swapMarket: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { swapMarket } = await import('./market/swap-market');
    await swapMarket(env);
    return env;
  },
  rapidFire: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { rapidFire } = await import('./consensus/rapid-fire');
    await rapidFire(env);
    return env;
  },
  grid: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { grid } = await import('./consensus/grid');
    await grid(env);
    return env;
  },
  settle: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { runSettleScenario } = await import('./settlement/settle');
    await runSettleScenario(env);
    return env;
  },
  disputeLifecycle: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    const { runDisputeLifecycle } = await import('./disputes/lifecycle');
    return await runDisputeLifecycle(env);
  },
  fullMechanics: async (env: RuntimeReplica): Promise<RuntimeReplica> => {
    return scenarios.ahb(env);
  },
};

export type ScenarioKey = keyof typeof scenarios;

export type ScenarioRecording = {
  key: ScenarioKey;
  /** Every committed frame of the run, in order. */
  frames: EnvSnapshot[];
  env: RuntimeReplica;
};

/**
 * Record an arbitrary browser scenario without teaching RuntimeReplica about
 * history. The caller owns the returned trace and may release its UI store at
 * any time; Runtime keeps only its current committed state.
 */
export const recordRuntimeScenario = async (
  env: RuntimeReplica,
  run: (target: RuntimeReplica) => Promise<RuntimeReplica | void>,
): Promise<{ frames: EnvSnapshot[]; env: RuntimeReplica }> => {
  const trace = startRuntimeHistoryTraceForTesting(env);
  try {
    const result = await run(env);
    return { frames: [...trace.snapshots], env: result ?? env };
  } finally {
    trace.stop();
  }
};

export const scenarioKeys = Object.keys(scenarios) as ScenarioKey[];

/**
 * Run one deterministic scenario and retain its committed frames.
 *
 * Runtime live memory intentionally stores no timeline. This temporary
 * collector is owned by the browser demo and is always released, even if the
 * scenario fails.
 */
export const recordScenario = async (
  key: ScenarioKey,
  env: RuntimeReplica,
): Promise<ScenarioRecording> => {
  const run = scenarios[key];
  if (!run) throw new Error(`SCENARIO_UNKNOWN:${String(key)}`);

  if (!String(env.runtimeSeed ?? '').trim()) env.runtimeSeed = `xln-demo:${String(key)}`;
  env.scenarioMode = true;
  env.scenarioJAdapterMode = 'browservm';
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: { ...env.runtimeConfig?.storage, enabled: false },
  };
  if (env.infrastructure) env.infrastructure.persistencePaused = true;

  const trace = startRuntimeHistoryTraceForTesting(env);
  try {
    const result = await run(env);
    return { key, frames: [...trace.snapshots], env: result };
  } finally {
    trace.stop();
  }
};

export { parseScenario, mergeAndSortEvents } from './runner/parser';
export { executeScenario } from './runner/executor';
export {
  SCENARIOS,
  getScenario,
  getScenariosByTag,
  type ScenarioMetadata,
} from './runner/catalog';
