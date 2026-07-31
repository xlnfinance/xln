import type { RuntimeReplica, EnvSnapshot } from '@xln/runtime/api/public/runtime-module';

const LIVE_RUNTIME_ENV_KEY = '__xlnLiveEnv';

type RuntimeViewEnv = RuntimeReplica & { [LIVE_RUNTIME_ENV_KEY]?: RuntimeReplica };

export function isRuntimeLikeEnv(value: unknown): value is RuntimeReplica {
  if (!value || typeof value !== 'object') return false;
  const env = value as {
    state?: { eReplicas?: unknown; jReplicas?: unknown };
    history?: unknown;
  };
  return env.state?.eReplicas instanceof Map && env.state.jReplicas instanceof Map && Array.isArray(env.history);
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
    // Runtime mutates the H+1 candidate in place for hub-scale performance.
    // A shallow Map copy would still alias every nested Entity/Account and let
    // an unrelated Svelte render expose candidate balances before WAL commit.
    // This UI-only projection is published after commit; cloning it does not
    // add work to headless hubs or to the consensus transition.
    state: structuredClone(liveEnv.state),
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
