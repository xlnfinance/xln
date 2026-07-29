import { copyLocalEntityLeaderTimeoutVoteAuthorization } from '../../entity/consensus/leader';
import { cloneTrustedEntityReplica } from '../../entity/replica-clone';
import type { RuntimeState, RuntimeInput } from '../../types';
import type { JReplica } from '../../types/jurisdiction-runtime';
import { copyLocalJAuthorityRuntimeTxAuthorization } from '../../jurisdiction/registration-evidence';
import { createGossipLayer } from '../../networking/gossip';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../../runtime/input-clone';
import { copyDeterministicHtlcTestSecretCapability } from '../../protocol/htlc/test-secret-capability';
import { copyLocalRuntimeAdapterCommandAuthorization } from '../../radapter/command-frontier-auth';
import {
  buildCanonicalJReplicaSnapshot,
  buildCanonicalRuntimeStateSnapshot,
} from '../../storage/wal/snapshot';
import { encodeBuffer } from '../../storage/codec';
import { attachEventEmitters } from '../env-events';
import { copyLocalEntityProviderActionRuntimeTxAuthorization } from '../entity-provider-action-submit-auth';
import { requireRuntimeMempool } from '../input-queue';
import { copyLocalJImportResultRuntimeTxAuthorization } from '../jurisdiction-import';
import { copyLocalJSubmitRuntimeTxAuthorization } from '../j-submit-state';
import {
  copyLocalScheduledWakeAuthorization,
  rebuildScheduledWakeIndex,
} from '../scheduled-wake';

export const RUNTIME_FRAME_SHARED_STATE_KEYS = new Set<string>([
  'loopActive',
  'loopPromise',
  'stopLoop',
  'wakeLoop',
  'processingPromise',
  'p2p',
  'envChangeCallbacks',
  'runtimeFrameCommitCallbacks',
  'storageDb',
  'storageDbOpenPromise',
  'storagePreviousDb',
  'storagePreviousDbOpenPromise',
  'storageEpochRotatePromise',
  'runtimeWalDb',
  'runtimeWalDbOpenPromise',
  'historyViewDb',
  'historyViewDbOpenPromise',
  'infraDb',
  'infraDbOpenPromise',
  'infraDbPendingWrites',
  'runtimeSyncChannel',
  'directEntityInputsDispatch',
  'directReliableReceiptDispatch',
  'canUseConnectedRelayFallback',
  'recoveryBackupBarrier',
  'watcherDedupCounter',
]);

const cloneRuntimeFrameState = (env: RuntimeState): NonNullable<RuntimeState['runtimeState']> => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env.runtimeState ?? {})) {
    if (key === 'scheduledWakeIndex') continue;
    if (RUNTIME_FRAME_SHARED_STATE_KEYS.has(key)) {
      cloned[key] = value;
      continue;
    }
    try {
      cloned[key] = structuredClone(value);
    } catch (cause) {
      throw new Error(`RUNTIME_FRAME_STATE_CLONE_FAILED:${key}`, { cause });
    }
  }
  return cloned as NonNullable<RuntimeState['runtimeState']>;
};

export const cloneRuntimeFrameMempool = (input: RuntimeInput): RuntimeInput => {
  const cloned = cloneIsolatedRuntimeInput(input);
  input.runtimeTxs.forEach((source, index) => {
    const target = cloned.runtimeTxs[index];
    if (!target) throw new Error(`RUNTIME_FRAME_RUNTIME_TX_CLONE_MISSING:${index}`);
    copyLocalJAuthorityRuntimeTxAuthorization(source, target);
    copyLocalJSubmitRuntimeTxAuthorization(source, target);
    copyLocalJImportResultRuntimeTxAuthorization(source, target);
    copyLocalEntityProviderActionRuntimeTxAuthorization(source, target);
    copyLocalRuntimeAdapterCommandAuthorization(source, target);
  });
  input.entityInputs.forEach((source, inputIndex) => {
    const target = cloned.entityInputs[inputIndex];
    if (!target) throw new Error(`RUNTIME_FRAME_ENTITY_INPUT_CLONE_MISSING:${inputIndex}`);
    if ((target.entityTxs?.length ?? 0) !== (source.entityTxs?.length ?? 0)) {
      throw new Error(`RUNTIME_FRAME_ENTITY_TX_CLONE_SHAPE_MISMATCH:${inputIndex}`);
    }
    source.entityTxs?.forEach((sourceTx, txIndex) => {
      const targetTx = target.entityTxs?.[txIndex];
      if (!targetTx) throw new Error(`RUNTIME_FRAME_ENTITY_TX_CLONE_MISSING:${inputIndex}:${txIndex}`);
      copyLocalScheduledWakeAuthorization(sourceTx, targetTx);
      copyDeterministicHtlcTestSecretCapability(sourceTx, targetTx);
    });
    if (source.leaderTimeoutVote) {
      if (!target.leaderTimeoutVote) {
        throw new Error(`RUNTIME_FRAME_LEADER_VOTE_CLONE_MISSING:${inputIndex}`);
      }
      copyLocalEntityLeaderTimeoutVoteAuthorization(source.leaderTimeoutVote, target.leaderTimeoutVote);
    }
  });
  return cloned;
};

const cloneGossip = (env: RuntimeState): RuntimeState['gossip'] => {
  const gossip = createGossipLayer();
  for (const profile of env.gossip?.getProfiles?.() ?? []) {
    const cloned = structuredClone(profile);
    gossip.profiles.set(cloned.entityId, cloned);
  }
  return gossip;
};

export const cloneRuntimeFrameWorkingEnv = (source: RuntimeState): RuntimeState => {
  const mempool = cloneRuntimeFrameMempool(requireRuntimeMempool(source));
  const working: RuntimeState = {
    ...source,
    eReplicas: new Map(
      [...source.eReplicas].map(([key, replica]) => [key, cloneTrustedEntityReplica(replica)]),
    ),
    jReplicas: new Map<string, JReplica>(
      [...source.jReplicas].map(([key, replica]) => [
        key,
        {
          ...buildCanonicalJReplicaSnapshot(replica),
          ...(replica.jadapter ? { jadapter: replica.jadapter } : {}),
        },
      ]),
    ),
    runtimeState: cloneRuntimeFrameState(source),
    runtimeMempool: mempool,
    ...(source.runtimeConfig ? { runtimeConfig: structuredClone(source.runtimeConfig) } : {}),
    ...(source.browserVMState ? { browserVMState: structuredClone(source.browserVMState) } : {}),
    ...(source.overlay ? { overlay: structuredClone(source.overlay) } : {}),
    ...(source.pendingOutputs ? { pendingOutputs: cloneIsolatedRoutedEntityInputs(source.pendingOutputs) } : {}),
    ...(source.networkInbox ? { networkInbox: cloneIsolatedRoutedEntityInputs(source.networkInbox) } : {}),
    ...(source.pendingNetworkOutputs
      ? { pendingNetworkOutputs: cloneIsolatedRoutedEntityInputs(source.pendingNetworkOutputs) }
      : {}),
    frameLogs: structuredClone(source.frameLogs),
    history: [...source.history],
    gossip: cloneGossip(source),
    ...(source.extra ? { extra: structuredClone(source.extra) } : {}),
  };
  attachEventEmitters(working);
  if (source.runtimeState?.scheduledWakeIndex !== undefined) rebuildScheduledWakeIndex(working);
  return working;
};

/**
 * Operational estimate of the deterministic payload copied for a frame.
 * It is intentionally opt-in because encoding the canonical snapshot adds
 * measurement cost. Shared process handles are excluded by the snapshot.
 */
export const measureRuntimeFrameCloneBytes = (source: RuntimeState): number =>
  encodeBuffer(buildCanonicalRuntimeStateSnapshot(source)).byteLength;
