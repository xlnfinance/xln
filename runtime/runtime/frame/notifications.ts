import { createStructuredLogger } from '../../infra/logger';
import type { RuntimeInput, RuntimeReplica } from '../types';
import { ensureRuntimeInfrastructure } from '../infrastructure/runtime-infrastructure';

const runtimeLog = createStructuredLogger('runtime');

export const notifyRuntimeStateChanged = (env: RuntimeReplica): void => {
  const infrastructure = ensureRuntimeInfrastructure(env);
  /*
   * A Runtime mutates H+1 in place while the writer lock excludes readers.
   * Transport lifecycle changes can request a notification during that window,
   * but publishing then would expose bytes that do not exist in WAL yet. The
   * committed-effects phase emits one notification after publication, so the
   * correct behavior here is to coalesce early requests into that durable
   * notice—not invoke observers and catch their expected rejection.
   */
  if (infrastructure.stateMutationInFlight) return;
  const callbacks = infrastructure.envChangeCallbacks;
  if (!callbacks || callbacks.size === 0) return;
  for (const callback of callbacks) {
    try {
      callback(env);
    } catch (error) {
      runtimeLog.warn('env_change.callback_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

export const notifyRuntimeFrameCommitted = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
): void => {
  const callbacks = ensureRuntimeInfrastructure(env).runtimeFrameCommitCallbacks;
  if (!callbacks || callbacks.size === 0) return;
  const frame = { height: env.state.height, runtimeInput };
  for (const callback of callbacks) {
    try {
      callback(frame);
    } catch (error) {
      runtimeLog.warn('frame_commit.callback_failed', {
        error: error instanceof Error ? error.message : String(error),
        height: env.state.height,
      });
    }
  }
};
