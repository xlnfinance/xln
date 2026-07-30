import type { RuntimeReplica } from './types';
import { inferRuntimeLifecyclePhase } from './lifecycle';

export const ensureRuntimeState = (env: RuntimeReplica): NonNullable<RuntimeReplica['infrastructure']> => {
  if (!env.infrastructure) {
    env.infrastructure = {
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
  if (!env.infrastructure.entityRuntimeHints) {
    env.infrastructure.entityRuntimeHints = new Map();
  }
  if (!env.infrastructure.lifecyclePhase) {
    env.infrastructure.lifecyclePhase = inferRuntimeLifecyclePhase(env.infrastructure);
  }
  if (!env.infrastructure.watcherDedupCounter) {
    env.infrastructure.watcherDedupCounter = { value: 0 };
  }
  return env.infrastructure;
};
