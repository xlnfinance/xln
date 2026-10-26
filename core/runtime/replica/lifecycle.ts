import type { RuntimeInput, RuntimeReplica } from '../types';

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
  for (const callback of state.runtimeHaltCallbacks ?? []) callback();
};

export type RuntimeCommandReadiness =
  | { ready: true; reason: null }
  | { ready: false; reason: string };

/**
 * Joining a jurisdiction or importing an Entity replica reads no J state and
 * creates no obligation, so the j-catchup fence admits exactly these: a
 * wallet joins every chain first and then waits for all of them at once.
 */
const isJCatchupBootstrapInput = (input: RuntimeInput): boolean =>
  input.entityInputs.length === 0 && (input.jInputs?.length ?? 0) === 0 && input.runtimeTxs.length > 0 &&
  input.runtimeTxs.every(tx => tx.type === 'importJ' || tx.type === 'importReplica');

export const getRuntimeCommandReadiness = (env: RuntimeReplica, input?: RuntimeInput): RuntimeCommandReadiness => {
  const state = env.infrastructure ?? {};
  if (state.operatorStatus === 'HALTED_REQUIRES_OPERATOR') {
    return { ready: false, reason: 'HALTED_REQUIRES_OPERATOR' };
  }
  const phase = inferRuntimeLifecyclePhase(state);
  if (phase !== 'running') return { ready: false, reason: `phase=${phase}` };
  if (state.persistencePaused === true || state.persistenceQuiescing === true) {
    return { ready: false, reason: 'persistence-fenced' };
  }
  if (state.entityInputsReady === false && !(input && isJCatchupBootstrapInput(input))) {
    return { ready: false, reason: 'j-catchup' };
  }
  return { ready: true, reason: null };
};

export const assertRuntimeCommandReady = (env: RuntimeReplica, input?: RuntimeInput): void => {
  const readiness = getRuntimeCommandReadiness(env, input);
  if (!readiness.ready) throw new Error(`RUNTIME_COMMAND_NOT_READY:${readiness.reason}`);
};
