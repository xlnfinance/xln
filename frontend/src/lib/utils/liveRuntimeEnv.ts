import type { RuntimeState, EnvSnapshot } from '@xln/runtime/xln-api';

const LIVE_RUNTIME_ENV_KEY = '__xlnLiveEnv';

type RuntimeViewEnv = RuntimeState & { [LIVE_RUNTIME_ENV_KEY]?: RuntimeState };

export function isRuntimeLikeEnv(value: unknown): value is RuntimeState {
  if (!value || typeof value !== 'object') return false;
  const env = value as { eReplicas?: unknown; jReplicas?: unknown; history?: unknown };
  return env.eReplicas instanceof Map && env.jReplicas instanceof Map && Array.isArray(env.history);
}

export function attachLiveRuntimeEnv<T extends object>(viewEnv: T, liveEnv: RuntimeState): T {
  Object.defineProperty(viewEnv, LIVE_RUNTIME_ENV_KEY, {
    value: liveEnv,
    enumerable: false,
    configurable: true,
  });
  return viewEnv;
}

export function createDetachedRuntimeViewEnv(liveEnv: RuntimeState): RuntimeState {
  return {
    ...liveEnv,
    eReplicas: new Map(liveEnv.eReplicas),
    jReplicas: new Map(liveEnv.jReplicas),
  };
}

export function createRuntimeViewEnv(liveEnv: RuntimeState): RuntimeState {
  return attachLiveRuntimeEnv(createDetachedRuntimeViewEnv(liveEnv), liveEnv);
}

export function unwrapLiveRuntimeEnv(env: RuntimeState | EnvSnapshot | null | undefined): RuntimeState | null {
  if (!env || typeof env !== 'object') return null;
  const liveEnv = (env as RuntimeViewEnv)[LIVE_RUNTIME_ENV_KEY];
  if (isRuntimeLikeEnv(liveEnv)) return liveEnv;
  return isRuntimeLikeEnv(env) ? env : null;
}
