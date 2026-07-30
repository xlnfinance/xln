import { createStructuredLogger } from '../../infra/logger';
import type { RuntimeInput, RuntimeReplica } from '../types';
import { ensureRuntimeInfrastructure } from '../runtime-infrastructure';

const runtimeLog = createStructuredLogger('runtime');

export const notifyRuntimeStateChanged = (env: RuntimeReplica): void => {
  const callbacks = ensureRuntimeInfrastructure(env).envChangeCallbacks;
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
