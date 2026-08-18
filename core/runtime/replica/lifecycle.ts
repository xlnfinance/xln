import type { RuntimeReplica } from '../types';

export type RuntimeLifecyclePhase = 'booting' | 'running' | 'quiescing' | 'stopped' | 'halted';

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;

const ALLOWED_TRANSITIONS: Record<RuntimeLifecyclePhase, ReadonlySet<RuntimeLifecyclePhase>> = {
  booting: new Set(['running', 'quiescing', 'stopped', 'halted']),
  running: new Set(['quiescing', 'stopped', 'halted']),
  quiescing: new Set(['running', 'stopped', 'halted']),
  stopped: new Set(['running', 'quiescing', 'halted']),
  halted: new Set(),
};

export const inferRuntimeLifecyclePhase = (state: RuntimeLifecycleState): RuntimeLifecyclePhase => {
  if (state.lifecyclePhase) return state.lifecyclePhase;
  if (state.halted) return 'halted';
  if (state.persistenceQuiescing) return 'quiescing';
  if (state.loopActive) return 'running';
  return 'booting';
};

export const transitionRuntimeLifecycle = (
  state: RuntimeLifecycleState,
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

export const haltRuntimeRequiresOperator = (
  env: RuntimeReplica,
  error: unknown,
): void => {
  const state = env.infrastructure ??= {};
  const cause = error instanceof Error ? error : new Error(String(error));
  transitionRuntimeLifecycle(state, 'halted');
  state.operatorStatus = 'HALTED_REQUIRES_OPERATOR';
  state.fatalDebugPayload = {
    message: cause.message,
    ...(cause.stack ? { stack: cause.stack } : {}),
    height: Math.max(0, env.state.height ?? 0),
    timestamp: Math.max(0, env.state.timestamp ?? 0),
  };
  state.stopLoop?.();
};

export type RuntimeCommandReadiness =
  | { ready: true; reason: null }
  | { ready: false; reason: string };

export const getRuntimeCommandReadiness = (env: RuntimeReplica): RuntimeCommandReadiness => {
  const state = env.infrastructure ?? {};
  if (state.operatorStatus === 'HALTED_REQUIRES_OPERATOR') {
    return { ready: false, reason: 'HALTED_REQUIRES_OPERATOR' };
  }
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase !== 'running') return { ready: false, reason: `phase=${phase}` };
  if (state.persistencePaused === true || state.persistenceQuiescing === true) {
    return { ready: false, reason: 'persistence-fenced' };
  }
  return { ready: true, reason: null };
};

export const assertRuntimeCommandReady = (env: RuntimeReplica): void => {
  const readiness = getRuntimeCommandReadiness(env);
  if (!readiness.ready) throw new Error(`RUNTIME_COMMAND_NOT_READY:${readiness.reason}`);
};
