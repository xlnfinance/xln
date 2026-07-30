import type { RuntimeReplica, EnvSnapshot } from '@xln/runtime/api/runtime-module';

const LIVE_RUNTIME_ENV_KEY = '__xlnLiveEnv';

type RuntimeViewEnv = RuntimeReplica & { [LIVE_RUNTIME_ENV_KEY]?: RuntimeReplica };

export function isRuntimeLikeEnv(value: unknown): value is RuntimeReplica {
  if (!value || typeof value !== 'object') return false;
  const env = value as { eReplicas?: unknown; jReplicas?: unknown; history?: unknown };
  return env.eReplicas instanceof Map && env.jReplicas instanceof Map && Array.isArray(env.history);
}

export function attachLiveRuntimeEnv<T extends object>(viewEnv: T, liveEnv: RuntimeReplica): T {
  Object.defineProperty(viewEnv, LIVE_RUNTIME_ENV_KEY, {
    value: liveEnv,
    enumerable: false,
    configurable: true,
  });
  return viewEnv;
}

export function createDetachedRuntimeViewEnv(liveEnv: RuntimeReplica): RuntimeReplica {
  return {
    ...liveEnv,
    eReplicas: new Map(liveEnv.eReplicas),
    jReplicas: new Map(liveEnv.jReplicas),
  };
}

export function createRuntimeViewEnv(liveEnv: RuntimeReplica): RuntimeReplica {
  return attachLiveRuntimeEnv(createDetachedRuntimeViewEnv(liveEnv), liveEnv);
}

export function unwrapLiveRuntimeEnv(env: RuntimeReplica | EnvSnapshot | null | undefined): RuntimeReplica | null {
  if (!env || typeof env !== 'object') return null;
  const liveEnv = (env as RuntimeViewEnv)[LIVE_RUNTIME_ENV_KEY];
  if (isRuntimeLikeEnv(liveEnv)) return liveEnv;
  return isRuntimeLikeEnv(env) ? env : null;
}
