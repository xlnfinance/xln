import type { Env } from '../types';

export type RuntimeLifecyclePhase = 'booting' | 'running' | 'quiescing' | 'stopped' | 'halted';

type RuntimeState = NonNullable<Env['runtimeState']>;

const ALLOWED_TRANSITIONS: Record<RuntimeLifecyclePhase, ReadonlySet<RuntimeLifecyclePhase>> = {
  booting: new Set(['running', 'quiescing', 'stopped', 'halted']),
  running: new Set(['quiescing', 'stopped', 'halted']),
  quiescing: new Set(['running', 'stopped', 'halted']),
  stopped: new Set(['running', 'quiescing', 'halted']),
  halted: new Set(),
};

export const inferRuntimeLifecyclePhase = (state: RuntimeState): RuntimeLifecyclePhase => {
  if (state.lifecyclePhase) return state.lifecyclePhase;
  if (state.halted) return 'halted';
  if (state.persistenceQuiescing) return 'quiescing';
  if (state.loopActive) return 'running';
  return 'booting';
};

export const transitionRuntimeLifecycle = (
  state: RuntimeState,
  next: RuntimeLifecyclePhase,
): RuntimeLifecyclePhase => {
  const current = inferRuntimeLifecyclePhase(state);
  if (current !== next && !ALLOWED_TRANSITIONS[current].has(next)) {
    throw new Error(`RUNTIME_LIFECYCLE_INVALID_TRANSITION: ${current}->${next}`);
  }
  state.lifecyclePhase = next;
  state.halted = next === 'halted';
  state.loopActive = next === 'running';
  state.persistenceQuiescing = next === 'quiescing';
  return next;
};

export const runtimeCanScheduleWork = (state: RuntimeState): boolean =>
  inferRuntimeLifecyclePhase(state) === 'running';

export type RuntimeCommandReadiness =
  | { ready: true; reason: null }
  | { ready: false; reason: string };

export const getRuntimeCommandReadiness = (env: Env): RuntimeCommandReadiness => {
  const state = env.runtimeState ?? {};
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase !== 'running') return { ready: false, reason: `phase=${phase}` };
  if (state.persistencePaused === true || state.persistenceQuiescing === true) {
    return { ready: false, reason: 'persistence-fenced' };
  }
  return { ready: true, reason: null };
};

export const assertRuntimeCommandReady = (env: Env): void => {
  const readiness = getRuntimeCommandReadiness(env);
  if (!readiness.ready) throw new Error(`RUNTIME_COMMAND_NOT_READY:${readiness.reason}`);
};
