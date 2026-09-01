import type {
  EnvSnapshot,
  RuntimeReplica,
  XLNModule,
} from '@xln/core/api/public/runtime-module';

import {
  scenarioAsRecord,
  scenarioMapEntries,
  type ScenarioOption,
} from './scenario-player-model';

type ScenarioRunner = (target: RuntimeReplica) => Promise<RuntimeReplica | void>;

type ScenarioRuntimeModule = XLNModule & Readonly<{
  scenarios?: Readonly<Record<string, ScenarioRunner>>;
  getScenario?: (id: string) => Readonly<{ run: ScenarioRunner }> | undefined;
  SCENARIOS?: readonly Readonly<{ id: string; run: ScenarioRunner }>[];
}>;

export type ScenarioRecording = Readonly<{
  env: RuntimeReplica;
  frames: EnvSnapshot[];
}>;

export const formatScenarioError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const prepareScenarioPreviewEnv = (env: RuntimeReplica): RuntimeReplica => {
  env.scenarioMode = true;
  env.scenarioJAdapterMode = 'browservm';
  env.quietRuntimeLogs = true;
  env.scenarioLogLevel = 'error';
  env.state.timestamp = env.state.timestamp || 1;
  env.runtimeConfig = {
    ...env.runtimeConfig,
    storage: { ...env.runtimeConfig?.storage, enabled: false },
  };
  if (env.infrastructure) env.infrastructure.persistencePaused = true;
  return env;
};

const stopJurisdictionWatchers = (env: RuntimeReplica, label: string): string[] => {
  const diagnostics: string[] = [];
  for (const [, jReplica] of scenarioMapEntries<Record<string, unknown>>(env.state.jReplicas)) {
    const adapter = scenarioAsRecord(jReplica['jadapter']);
    try {
      if (typeof adapter['stopWatching'] === 'function') (adapter['stopWatching'] as () => void)();
    } catch (error: unknown) {
      diagnostics.push(`${label}: failed to stop J-watcher: ${formatScenarioError(error)}`);
    }
  }
  return diagnostics;
};

export const stopScenarioPreviewInfra = (
  env: RuntimeReplica | null,
  label = 'preview',
): string[] => {
  if (!env) return [];
  const diagnostics = stopJurisdictionWatchers(env, label);
  try {
    env.infrastructure?.stopLoop?.();
  } catch (error: unknown) {
    diagnostics.push(`${label}: failed to stop runtime loop: ${formatScenarioError(error)}`);
  }
  if (env.infrastructure) {
    env.infrastructure.loopActive = false;
    env.infrastructure.stopLoop = null;
  }
  return diagnostics;
};

const resolveScenarioRunner = (
  runtime: ScenarioRuntimeModule,
  option: ScenarioOption,
): ScenarioRunner => {
  const named = option.runner ? runtime.scenarios?.[option.runner] : undefined;
  if (named) return named;
  const entry = runtime.getScenario?.(option.runtimeId)
    ?? runtime.SCENARIOS?.find(scenario => scenario.id === option.runtimeId);
  if (!entry) throw new Error(`SCENARIO_NOT_FOUND:${option.runtimeId}`);
  return entry.run;
};

export const recordBrowserScenario = async (
  runtime: XLNModule,
  option: ScenarioOption,
): Promise<ScenarioRecording> => {
  const env = prepareScenarioPreviewEnv(runtime.createEmptyEnv(`scenario-preview:${option.id}`));
  try {
    const recording = await runtime.recordRuntimeScenario(
      env,
      resolveScenarioRunner(runtime as ScenarioRuntimeModule, option),
    );
    return {
      env: prepareScenarioPreviewEnv(recording.env),
      frames: recording.frames,
    };
  } catch (error: unknown) {
    stopScenarioPreviewInfra(env, option.title);
    throw error;
  }
};
