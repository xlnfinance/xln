import { getLocalSignerPrivateKey } from '../account/crypto';
import { getEntityLeaderState, isEntityActiveLeader } from '../entity/consensus/leader';
import type { Profile } from '../entity/profile';
import type { RuntimeState } from '../types';

const REPLAY_OUTPUT_SIGNER_HINTS = Symbol.for('xln.runtime.replay.output-signer-hints');

type RuntimeStateWithReplaySignerHints = RuntimeState & {
  [REPLAY_OUTPUT_SIGNER_HINTS]?: ReadonlyMap<string, string>;
};

export const installReplayOutputSignerHints = (env: RuntimeState, hints: ReadonlyMap<string, string>): void => {
  const canonical = new Map<string, string>();
  for (const [rawEntityId, rawSignerId] of hints) {
    const entityId = String(rawEntityId || '')
      .trim()
      .toLowerCase();
    const signerId = String(rawSignerId || '')
      .trim()
      .toLowerCase();
    if (!entityId || !signerId) {
      throw new Error('REPLAY_OUTPUT_SIGNER_HINT_INVALID');
    }
    canonical.set(entityId, signerId);
  }
  Object.defineProperty(env, REPLAY_OUTPUT_SIGNER_HINTS, {
    value: canonical,
    configurable: true,
    enumerable: false,
    writable: false,
  });
};

export const clearReplayOutputSignerHints = (env: RuntimeState): void => {
  const transient: RuntimeStateWithReplaySignerHints = env;
  delete transient[REPLAY_OUTPUT_SIGNER_HINTS];
};

const replayOutputSignerHint = (env: RuntimeState, entityId: string): string | null => {
  const transient: RuntimeStateWithReplaySignerHints = env;
  const hints = transient[REPLAY_OUTPUT_SIGNER_HINTS];
  return hints instanceof Map ? String(hints.get(entityId) || '') || null : null;
};

/**
 * Resolve which local signer may emit a committed Entity output.
 *
 * Sparse-WAL replay runs before gossip/network infrastructure is attached.
 * The atomically hashed WAL record already contains the durable outbox, so its
 * exact signer hint is valid local routing evidence. The hint never enters
 * Runtime/Entity/Account consensus state and is cleared after each replayed
 * Runtime frame.
 */
export const resolveEntityProposerId = (env: RuntimeState, entityId: string, context: string): string => {
  const targetEntityId = String(entityId || '').toLowerCase();
  let localKeyReplicaFallback: string | null = null;
  let configFallback: string | null = null;
  let gossipFallback: string | null = null;

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const keyParts = String(replicaKey).split(':');
    const keyEntityId = String(keyParts[0] || '').toLowerCase();
    const replicaEntityId = String(replica.entityId || '').toLowerCase();
    if (replicaEntityId !== targetEntityId && keyEntityId !== targetEntityId) {
      continue;
    }

    const replicaSignerId = String(replica.signerId || keyParts[1] || '').trim();
    const configuredValidators = replica.state.config.validators || [];
    if (isEntityActiveLeader(replica) && replicaSignerId && getLocalSignerPrivateKey(env, replicaSignerId)) {
      return replicaSignerId;
    }
    if (!localKeyReplicaFallback && replicaSignerId && getLocalSignerPrivateKey(env, replicaSignerId)) {
      localKeyReplicaFallback = replicaSignerId;
    }
    if (!configFallback) {
      configFallback = getEntityLeaderState(replica.state).activeValidatorId || configuredValidators[0] || null;
    }
  }

  if (env.gossip?.getProfiles) {
    const profile = (env.gossip.getProfiles() as Profile[]).find(
      candidate => String(candidate.entityId || '').toLowerCase() === targetEntityId,
    );
    const firstValidator = profile?.metadata.board?.validators?.[0];
    gossipFallback = firstValidator?.signerId || firstValidator?.signer || null;
  }

  if (localKeyReplicaFallback) return localKeyReplicaFallback;
  if (configFallback && getLocalSignerPrivateKey(env, configFallback)) {
    return configFallback;
  }
  const replayHint = replayOutputSignerHint(env, targetEntityId);
  if (replayHint) return replayHint;
  if (gossipFallback) return gossipFallback;
  if (configFallback) return configFallback;

  throw new Error(`SIGNER_RESOLUTION_FAILED: ${context} entityId=${entityId}`);
};
