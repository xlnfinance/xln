import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import type { RoutedEntityInput, RuntimeReplica } from '../types';

const REPLAY_OUTPUT_RUNTIME_ROUTES = Symbol.for('xln.runtime.replay.output-runtime-routes');

type RuntimeWithReplayOutputRoutes = RuntimeReplica & {
  [REPLAY_OUTPUT_RUNTIME_ROUTES]?: ReadonlyMap<string, string>;
};

const routeKey = (entityId: string, signerId: string): string =>
  `${entityId.trim().toLowerCase()}:${signerId.trim().toLowerCase()}`;

/**
 * WAL replay must reproduce the exact committed outbox without consulting
 * volatile gossip. These hints exist only while replaying one hash-verified
 * Runtime frame and never become consensus or live routing state.
 */
export const installReplayOutputRuntimeRoutes = (
  env: RuntimeReplica,
  outputs: readonly RoutedEntityInput[],
): void => {
  const routes = new Map<string, string>();
  for (const output of outputs) {
    const key = routeKey(String(output.entityId || ''), String(output.signerId || ''));
    const runtimeId = normalizeRuntimeId(String(output.runtimeId || ''));
    if (key === ':' || !runtimeId) throw new Error('REPLAY_OUTPUT_RUNTIME_ROUTE_INVALID');
    const existing = routes.get(key);
    if (existing && existing !== runtimeId) {
      throw new Error(`REPLAY_OUTPUT_RUNTIME_ROUTE_CONFLICT:${key}`);
    }
    routes.set(key, runtimeId);
  }
  Object.defineProperty(env, REPLAY_OUTPUT_RUNTIME_ROUTES, {
    value: routes,
    configurable: true,
    enumerable: false,
    writable: false,
  });
};

export const resolveReplayOutputRuntimeRoute = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
): string | null => {
  const routes = (env as RuntimeWithReplayOutputRoutes)[REPLAY_OUTPUT_RUNTIME_ROUTES];
  return routes?.get(routeKey(entityId, signerId)) ?? null;
};

export const clearReplayOutputRuntimeRoutes = (env: RuntimeReplica): void => {
  delete (env as RuntimeWithReplayOutputRoutes)[REPLAY_OUTPUT_RUNTIME_ROUTES];
};
