import { createStructuredLogger } from '../../infra/logger';
import type { RuntimeInput, RuntimeState } from '../types';
import { ensureRuntimeState } from '../runtime-state';

const runtimeLog = createStructuredLogger('runtime');

export const notifyRuntimeStateChanged = (env: RuntimeState): void => {
  const callbacks = ensureRuntimeState(env).envChangeCallbacks;
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
  env: RuntimeState,
  runtimeInput: RuntimeInput,
): void => {
  const callbacks = ensureRuntimeState(env).runtimeFrameCommitCallbacks;
  if (!callbacks || callbacks.size === 0) return;
  const frame = { height: env.height, runtimeInput };
  for (const callback of callbacks) {
    try {
      callback(frame);
    } catch (error) {
      runtimeLog.warn('frame_commit.callback_failed', {
        error: error instanceof Error ? error.message : String(error),
        height: env.height,
      });
    }
  }
};
