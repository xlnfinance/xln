import type { EnvSnapshot, RuntimeReplica } from '../runtime/types';
import { startRuntimeTraceForTesting } from '../runtime/observability/runtime-trace';
import { getBrowserScenarios } from './runner/catalog';

/**
 * Browser scenario registry.
 *
 * Dynamic imports keep startup cheap. More importantly, this module belongs to
 * the browser composition root: production Runtime code never imports scenario
 * implementations back into its own dependency graph.
 */
export type BrowserScenarioRunner = (env: RuntimeReplica) => Promise<RuntimeReplica>;

/** Browser runners are a view over the canonical hyphenated scenario catalog. */
export const scenarios: Readonly<Record<string, BrowserScenarioRunner>> = Object.freeze(
  Object.fromEntries(getBrowserScenarios().map((scenario) => [
    scenario.id,
    async (env: RuntimeReplica): Promise<RuntimeReplica> => (await scenario.run(env)) ?? env,
  ])),
);

export type ScenarioKey = string;

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
  const trace = startRuntimeTraceForTesting(env);
  try {
    const result = await run(env);
    return { frames: [...trace.snapshots], env: result ?? env };
  } finally {
    trace.stop();
  }
};

export const scenarioKeys = Object.keys(scenarios);

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

  const trace = startRuntimeTraceForTesting(env);
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
