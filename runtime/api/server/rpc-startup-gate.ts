import type { RuntimeReplica } from '../../runtime/types';

/**
 * Hold RPC work until startup has either completed or failed.
 *
 * The server binds its listener before WAL recovery so health probes can see
 * progress. RPC messages arriving in that window must resolve the Runtime
 * replica only after the barrier, otherwise they can authenticate against or
 * mutate a half-restored owner. Resolving `getEnv` after the await is the key:
 * capturing `session.env` at socket-message time would preserve the stale null.
 */
export const dispatchRuntimeRpcAfterStartup = async (
  startupBarrier: Promise<void>,
  getEnv: () => RuntimeReplica | null,
  attachTicker: (env: RuntimeReplica) => void,
  dispatch: (env: RuntimeReplica | null) => Promise<void>,
): Promise<void> => {
  await startupBarrier;
  const env = getEnv();
  if (env) attachTicker(env);
  await dispatch(env);
};
