import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';

const LIVE_RUNTIME_ENV_KEY = '__xlnLiveEnv';

type RuntimeViewEnv = Env & { [LIVE_RUNTIME_ENV_KEY]?: Env };

export function isRuntimeLikeEnv(value: unknown): value is Env {
  if (!value || typeof value !== 'object') return false;
  const env = value as { eReplicas?: unknown; jReplicas?: unknown; history?: unknown };
  return env.eReplicas instanceof Map && env.jReplicas instanceof Map && Array.isArray(env.history);
}

export function attachLiveRuntimeEnv<T extends object>(viewEnv: T, liveEnv: Env): T {
  Object.defineProperty(viewEnv, LIVE_RUNTIME_ENV_KEY, {
    value: liveEnv,
    enumerable: false,
    configurable: true,
  });
  return viewEnv;
}

export function createRuntimeViewEnv(liveEnv: Env): Env {
  return attachLiveRuntimeEnv({
    ...liveEnv,
    eReplicas: new Map(liveEnv.eReplicas),
    jReplicas: new Map(liveEnv.jReplicas),
  }, liveEnv);
}

export function unwrapLiveRuntimeEnv(env: Env | EnvSnapshot | null | undefined): Env | null {
  if (!env || typeof env !== 'object') return null;
  const liveEnv = (env as RuntimeViewEnv)[LIVE_RUNTIME_ENV_KEY];
  if (isRuntimeLikeEnv(liveEnv)) return liveEnv;
  return isRuntimeLikeEnv(env) ? env : null;
}
