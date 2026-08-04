import { createExternalStore } from '../../../packages/client-core/external-store';
import type { EnvSnapshot, RuntimeReplica, XLNModule } from '@xln/runtime/api/public/runtime-module';
import { loadOpsRuntime } from './ops-runtime-loader';
import { projectOpsGraphFrame, type OpsGraphFrame } from './ops-scenario-graph';

export type OpsScenario = Readonly<{ id: string; runtimeId: string; runner: string; title: string; description: string; tags: readonly string[] }>;
export const OPS_SCENARIOS: readonly OpsScenario[] = Object.freeze([
  Object.freeze({ id: 'hub-collapse', runtimeId: 'dispute-lifecycle', runner: 'disputeLifecycle', title: 'Hub collapse', description: 'Freeze, timeout, finalize, debt evidence, and reopen after non-cooperation.', tags: Object.freeze(['dispute', 'hub']) }),
  Object.freeze({ id: 'ahb', runtimeId: 'ahb', runner: 'ahb', title: 'Alice–Hub–Bob', description: 'Reserves, routed payments, collateral, settlement, and cooperative close.', tags: Object.freeze(['bilateral', 'routing']) }),
  Object.freeze({ id: 'lock-ahb', runtimeId: 'lock-ahb', runner: 'lockAhb', title: 'HTLC route', description: 'Hash-locked multi-hop payment with secret and timeout protection.', tags: Object.freeze(['htlc', 'routing']) }),
  Object.freeze({ id: 'settle', runtimeId: 'settle', runner: 'settle', title: 'Settlement workspace', description: 'Propose, counter, approve, execute, and reject bilateral settlement.', tags: Object.freeze(['settlement']) }),
  Object.freeze({ id: 'swap', runtimeId: 'swap', runner: 'swap', title: 'Swap orderbook', description: 'Limit orders, fills, holds, and cancellation on a bilateral account.', tags: Object.freeze(['swap', 'orderbook']) }),
]);
export type OpsScenarioSnapshot = Readonly<{ status: 'idle' | 'loading' | 'ready' | 'error'; scenarioId: string; frames: readonly EnvSnapshot[]; index: number; graph: OpsGraphFrame | null; playing: boolean; playbackMs: number; error: string | null; diagnostics: readonly string[] }>;

const initial: OpsScenarioSnapshot = Object.freeze({ status: 'idle', scenarioId: OPS_SCENARIOS[0]!.id, frames: Object.freeze([]), index: 0, graph: null, playing: false, playbackMs: 700, error: null, diagnostics: Object.freeze([]) });
const binding = createExternalStore(initial);
export const opsScenarioExternalStore = binding.store;
let owners = 0; let stopTimer: number | null = null; let playbackTimer: number | null = null; let requestVersion = 0; let liveEnv: RuntimeReplica | null = null;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'OPS_SCENARIO_FAILED');
const mapEntries = (value: unknown): Array<[string, Record<string, unknown>]> => value instanceof Map ? Array.from(value.entries()).map(([key, item]) => [String(key), item as Record<string, unknown>]) : value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, Record<string, unknown>>) : [];
const stopInfra = (env: RuntimeReplica | null, label: string): readonly string[] => {
  if (!env) return Object.freeze([]);
  const diagnostics: string[] = [];
  for (const [, replica] of mapEntries(env.state.jReplicas)) {
    const adapter = replica['jadapter'];
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) continue;
    try { if (typeof (adapter as Record<string, unknown>)['stopWatching'] === 'function') ((adapter as Record<string, unknown>)['stopWatching'] as () => void)(); }
    catch (error) { diagnostics.push(`${label}:J_WATCHER_STOP_FAILED:${errorMessage(error)}`); }
  }
  try { env.infrastructure?.stopLoop?.(); } catch (error) { diagnostics.push(`${label}:RUNTIME_LOOP_STOP_FAILED:${errorMessage(error)}`); }
  if (env.infrastructure) { env.infrastructure.loopActive = false; env.infrastructure.stopLoop = null; }
  return Object.freeze(diagnostics);
};
const prepareEnv = (env: RuntimeReplica): RuntimeReplica => {
  env.scenarioMode = true; env.scenarioJAdapterMode = 'browservm'; env.quietRuntimeLogs = true; env.scenarioLogLevel = 'error'; env.state.timestamp ||= 1;
  env.runtimeConfig = { ...env.runtimeConfig, storage: { ...env.runtimeConfig?.storage, enabled: false } };
  if (env.infrastructure) env.infrastructure.persistencePaused = true;
  return env;
};
type ScenarioRuntime = XLNModule & { scenarios?: Record<string, (env: RuntimeReplica) => Promise<RuntimeReplica | void>>; getScenario?: (id: string) => { run(env: RuntimeReplica): Promise<RuntimeReplica | void> } | undefined; SCENARIOS?: Array<{ id: string; run(env: RuntimeReplica): Promise<RuntimeReplica | void> }> };
const runScenario = async (runtime: XLNModule, scenario: OpsScenario, env: RuntimeReplica): Promise<RuntimeReplica> => {
  const api = runtime as ScenarioRuntime; const direct = api.scenarios?.[scenario.runner];
  if (direct) return (await direct(env)) ?? env;
  const registered = api.getScenario?.(scenario.runtimeId) ?? api.SCENARIOS?.find(item => item.id === scenario.runtimeId);
  if (!registered) throw new Error(`OPS_SCENARIO_NOT_FOUND:${scenario.runtimeId}`);
  return (await registered.run(env)) ?? env;
};
const setFrame = (index: number): void => binding.controller.update(state => {
  if (state.frames.length === 0) return state;
  const next = Math.max(0, Math.min(state.frames.length - 1, Math.floor(index))); const frame = state.frames[next];
  if (!frame) throw new Error(`OPS_SCENARIO_FRAME_MISSING:${next}`);
  return Object.freeze({ ...state, index: next, graph: projectOpsGraphFrame(frame) });
});
const focusFrame = (scenario: OpsScenario, frames: readonly EnvSnapshot[]): number => {
  const graphs = frames.map(projectOpsGraphFrame);
  if (scenario.id === 'hub-collapse') {
    const collapse = graphs.findIndex(graph => graph.disputes > 0 || graph.debts > 0 || /dispute|finalize|freeze|debt|reopen|non-cooperative/i.test(`${graph.title} ${graph.description}`));
    if (collapse >= 0) return collapse;
  }
  const populated = graphs.findIndex(graph => graph.nodes.length > 0); return populated >= 0 ? populated : 0;
};
const clearPlayback = (): void => { if (playbackTimer !== null) window.clearInterval(playbackTimer); playbackTimer = null; };
const pause = (): void => { clearPlayback(); binding.controller.update(state => state.playing ? Object.freeze({ ...state, playing: false }) : state); };
const play = (): void => {
  const snapshot = binding.store.getSnapshot(); if (snapshot.playing || snapshot.frames.length < 2) return;
  binding.controller.set(Object.freeze({ ...snapshot, playing: true }));
  playbackTimer = window.setInterval(() => {
    const state = binding.store.getSnapshot(); if (!state.playing || state.index >= state.frames.length - 1) { pause(); return; }
    setFrame(state.index + 1);
  }, snapshot.playbackMs);
};
const load = async (scenarioId: string): Promise<void> => {
  const scenario = OPS_SCENARIOS.find(item => item.id === scenarioId); if (!scenario) throw new Error(`OPS_SCENARIO_UNKNOWN:${scenarioId}`);
  const version = ++requestVersion; pause(); const diagnostics = stopInfra(liveEnv, 'previous'); liveEnv = null;
  binding.controller.set(Object.freeze({ ...initial, status: 'loading', scenarioId, diagnostics }));
  try {
    const runtime = await loadOpsRuntime(); const env = prepareEnv(runtime.createEmptyEnv(`ops-scenario:${scenario.id}`));
    const result = prepareEnv(await runScenario(runtime, scenario, env)); const stopped = stopInfra(result, scenario.id);
    if (version !== requestVersion || owners === 0) return;
    const frames = Array.isArray(result.history) ? Object.freeze([...result.history]) : Object.freeze([]);
    if (frames.length === 0) throw new Error(`OPS_SCENARIO_EMPTY_HISTORY:${scenario.id}`);
    liveEnv = result; const index = focusFrame(scenario, frames); const graph = projectOpsGraphFrame(frames[index]!);
    binding.controller.set(Object.freeze({ ...initial, status: 'ready', scenarioId, frames, index, graph, diagnostics: Object.freeze([...diagnostics, ...stopped]) }));
  } catch (error) {
    if (version !== requestVersion || owners === 0) return;
    binding.controller.set(Object.freeze({ ...initial, status: 'error', scenarioId, error: errorMessage(error), diagnostics }));
  }
};
const teardown = (): void => { requestVersion += 1; pause(); const diagnostics = stopInfra(liveEnv, 'teardown'); liveEnv = null; if (diagnostics.length) console.error('OPS_SCENARIO_TEARDOWN_FAILED', diagnostics); };

export const opsScenarioController = Object.freeze({
  start(scenarioId?: string): void { owners += 1; if (stopTimer !== null) window.clearTimeout(stopTimer); stopTimer = null; const state = binding.store.getSnapshot(); if (state.status === 'idle' && scenarioId !== '') void load(scenarioId ?? state.scenarioId); },
  stop(): void { owners = Math.max(0, owners - 1); if (owners > 0 || stopTimer !== null) return; stopTimer = window.setTimeout(() => { stopTimer = null; if (owners === 0) teardown(); }, 0); },
  load, setFrame, play, pause,
  setPlaybackMs(value: number): void { const playbackMs = Math.max(100, Math.min(5_000, Math.floor(value))); const wasPlaying = binding.store.getSnapshot().playing; pause(); binding.controller.update(state => Object.freeze({ ...state, playbackMs })); if (wasPlaying) play(); },
});
