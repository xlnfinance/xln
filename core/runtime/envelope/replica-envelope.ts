import type { RuntimeReplica } from '../types';
import { inferRuntimeLifecyclePhase } from '../replica/lifecycle';

/**
 * Return the process-local infrastructure envelope for one Runtime replica.
 *
 * This helper never creates consensus State. Runtime State lives in
 * `replica.state`; the fields initialized here are writer locks, transports,
 * lifecycle controls, and other process-owned machinery that must never enter
 * a Runtime frame or its canonical hash.
 */
export const ensureRuntimeInfrastructure = (
  replica: RuntimeReplica,
): NonNullable<RuntimeReplica['infrastructure']> => {
  if (!replica.infrastructure) {
    replica.infrastructure = {
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
      recoveryBackupBarrier: null,
    };
  }
  if (!replica.infrastructure.entityRuntimeHints) {
    replica.infrastructure.entityRuntimeHints = new Map();
  }
  if (!replica.infrastructure.lifecyclePhase) {
    replica.infrastructure.lifecyclePhase = inferRuntimeLifecyclePhase(
      replica.infrastructure,
    );
  }
  if (!replica.infrastructure.watcherDedupCounter) {
    replica.infrastructure.watcherDedupCounter = { value: 0 };
  }
  return replica.infrastructure;
};
