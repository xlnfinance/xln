import type { RuntimeReplica } from './types';
import { inferRuntimeLifecyclePhase } from './lifecycle';

export const ensureRuntimeState = (env: RuntimeReplica): NonNullable<RuntimeReplica['runtimeState']> => {
  if (!env.runtimeState) {
    env.runtimeState = {
      lifecyclePhase: 'booting',
      loopActive: false,
      halted: false,
      loopPromise: null,
      stopLoop: null,
      wakeLoop: null,
      wakeRequested: false,
      inFlightEntityInputs: 0,
      p2p: null,
      pendingP2PConfig: null,
      lastP2PConfig: null,
      directEntityInputsDispatch: null,
      directReliableReceiptDispatch: null,
      canUseConnectedRelayFallback: null,
      recoveryBackupBarrier: null,
    };
  }
  if (!env.runtimeState.entityRuntimeHints) {
    env.runtimeState.entityRuntimeHints = new Map();
  }
  if (!env.runtimeState.lifecyclePhase) {
    env.runtimeState.lifecyclePhase = inferRuntimeLifecyclePhase(env.runtimeState);
  }
  if (!env.runtimeState.watcherDedupCounter) {
    env.runtimeState.watcherDedupCounter = { value: 0 };
  }
  return env.runtimeState;
};
