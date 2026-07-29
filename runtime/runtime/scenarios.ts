import type { EnvSnapshot, RuntimeState } from '../types';
import { startRuntimeFrameTrace } from './history-retention';

export const scenarios = {
  ahb: async (env: RuntimeState): Promise<RuntimeState> => {
    const { ahb } = await import('../scenarios/ahb');
    await ahb(env);
    return env;
  },
  lockAhb: async (env: RuntimeState): Promise<RuntimeState> => {
    const { lockAhb } = await import('../scenarios/lock-ahb');
    await lockAhb(env);
    return env;
  },
  swap: async (env: RuntimeState): Promise<RuntimeState> => {
    const { swap, swapWithOrderbook, multiPartyTrading } = await import('../scenarios/swap');
    await swap(env);
    await swapWithOrderbook(env);
    await multiPartyTrading(env);
    return env;
  },
  swapMarket: async (env: RuntimeState): Promise<RuntimeState> => {
    const { swapMarket } = await import('../scenarios/swap-market');
    await swapMarket(env);
    return env;
  },
  rapidFire: async (env: RuntimeState): Promise<RuntimeState> => {
    const { rapidFire } = await import('../scenarios/rapid-fire');
    await rapidFire(env);
    return env;
  },
  grid: async (env: RuntimeState): Promise<RuntimeState> => {
    const { grid } = await import('../scenarios/grid');
    await grid(env);
    return env;
  },
  settle: async (env: RuntimeState): Promise<RuntimeState> => {
    const { runSettleScenario } = await import('../scenarios/settle');
    await runSettleScenario(env);
    return env;
  },
  disputeLifecycle: async (env: RuntimeState): Promise<RuntimeState> => {
    const { runDisputeLifecycle } = await import('../scenarios/dispute-lifecycle');
    return await runDisputeLifecycle(env);
  },
  fullMechanics: async (env: RuntimeState): Promise<RuntimeState> => {
    const { getScenario } = await import('../scenarios');
    const scenario = getScenario('ahb');
    if (!scenario) throw new Error('FULL_MECHANICS_SCENARIO_MISSING');
    await scenario.run(env);
    return env;
  },
};

export type ScenarioKey = keyof typeof scenarios;

export type ScenarioRecording = {
  key: ScenarioKey;
  /** Every committed frame of the run, in order. Empty means the scenario committed nothing. */
  frames: EnvSnapshot[];
  env: RuntimeState;
  /**
   * Why the run stopped early, or null when it completed.
   *
   * A failed scenario still produced real frames, and those frames are how you see what the
   * run did before it broke. Throwing them away turns every scenario failure into a blind
   * debugging session.
   */
  failure: string | null;
};

export const scenarioKeys = Object.keys(scenarios) as ScenarioKey[];

/**
 * Run a scenario and keep every frame it commits.
 *
 * Frames are what a viewer scrubs through, but RuntimeState deliberately keeps no history
 * (RECENT_RUNTIME_HISTORY_LIMIT = 0), so a demo has to own the trace for the length of the
 * run. The collector is always released, including on failure.
 */
export const recordScenario = async (
  key: ScenarioKey,
  env: RuntimeState,
): Promise<ScenarioRecording> => {
  const run = scenarios[key];
  if (!run) throw new Error(`SCENARIO_UNKNOWN:${String(key)}`);
  // A recording must be self-contained and identical on every run:
  //  - a seed derived from the scenario name, so it never depends on an unlocked vault
  //  - deterministic scenario time instead of wall clock
  //  - the in-process EVM, so it never depends on (or floods) an external RPC endpoint
  if (!String(env.runtimeSeed ?? '').trim()) env.runtimeSeed = `xln-demo:${String(key)}`;
  //  - no persistence: the frames live in the trace, and writing them would collide with
  //    whatever runtime already owns that storage namespace
  env.scenarioMode = true;
  env.scenarioJAdapterMode = 'browservm';
  env.quietRuntimeLogs = true;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: { ...env.runtimeConfig?.storage, enabled: false },
  };
  if (env.runtimeState) env.runtimeState.persistencePaused = true;
  const trace = startRuntimeFrameTrace(env);
  try {
    const result = await run(env);
    return { key, frames: [...trace.snapshots], env: result, failure: null };
  } catch (error) {
    // Keep what the run produced. The frames leading up to a failure are the most useful
    // ones there are — they show the state that broke the assertion.
    return {
      key,
      frames: [...trace.snapshots],
      env,
      failure: error instanceof Error ? error.message : String(error || 'scenario failed'),
    };
  } finally {
    trace.stop();
  }
};
