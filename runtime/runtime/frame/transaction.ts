import type { JAdapter } from '../../jadapter';
import type { Env, JReplica, RuntimeInput } from '../../types';
import { cloneTrustedEntityReplica } from '../../state-helpers';
import {
  cloneIsolatedRoutedEntityInputs,
  cloneIsolatedRuntimeInput,
} from '../../protocol/runtime-input-clone';
import { copyDeterministicHtlcTestSecretCapability } from '../../protocol/htlc/test-secret-capability';
import { copyLocalEntityLeaderTimeoutVoteAuthorization } from '../../entity/consensus/leader';
import { copyLocalJAuthorityRuntimeTxAuthorization } from '../../jurisdiction/registration-evidence';
import { copyLocalRuntimeAdapterCommandAuthorization } from '../../radapter/command-frontier-auth';
import { buildCanonicalJReplicaSnapshot } from '../../wal/snapshot';
import { createGossipLayer } from '../../networking/gossip';
import { attachEventEmitters } from '../env-events';
import { copyLocalEntityProviderActionRuntimeTxAuthorization } from '../entity-provider-action-submit-auth';
import { ensureRuntimeMempool } from '../input-queue';
import { copyLocalJImportResultRuntimeTxAuthorization } from '../jurisdiction-import';
import { copyLocalJSubmitRuntimeTxAuthorization } from '../j-submit-state';
import {
  assertRuntimeFrameStorageState,
  reconcileRuntimeFrameSharedState,
  RUNTIME_FRAME_DB_HANDLE_GROUPS,
  type RuntimeFrameSharedStateSnapshot,
} from '../runtime-frame-shared-state';
import { ensureRuntimeState } from '../runtime-state';
import {
  copyLocalScheduledWakeAuthorization,
  rebuildScheduledWakeIndex,
} from '../scheduled-wake';

const SHARED_STATE_KEYS = new Set<string>([
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
  'frameDb',
  'frameDbOpenPromise',
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

// These fields belong to the live process, not the deterministic frame
// candidate. Publishing a frame retains the exact live handles and flags.
const LIVE_STATE_KEYS = new Set<string>([
  'lifecyclePhase',
  'halted',
  'fatalDebugPayload',
  'wakeRequested',
  'persistencePaused',
  'persistenceQuiescing',
  'pendingP2PConfig',
  'lastP2PConfig',
  'logState',
  'cleanLogs',
  'pendingAuditEvents',
  'recentJEvents',
  'recentReserveUpdatedEvents',
  'verifiedProfileRoutes',
  'externalWalletWatchOwners',
  'infraDbClosing',
  'inFlightEntityInputs',
  'runtimeSyncNotificationFailure',
]);

export type RuntimeFrameTransaction = {
  liveEnv: Env;
  workingEnv: Env;
  sharedStateBaseline: Map<string, RuntimeFrameSharedStateSnapshot>;
  liveFrameLogBaseLength: number;
  workingCleanLogBaseLength: number;
  liveAdapters: Set<JAdapter>;
  published: boolean;
};

const cloneRuntimeFrameState = (env: Env): NonNullable<Env['runtimeState']> => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env.runtimeState ?? {})) {
    if (key === 'scheduledWakeIndex') continue;
    if (SHARED_STATE_KEYS.has(key)) {
      cloned[key] = value;
      continue;
    }
    try {
      cloned[key] = structuredClone(value);
    } catch (cause) {
      throw new Error(`RUNTIME_FRAME_STATE_CLONE_FAILED:${key}`, { cause });
    }
  }
  return cloned as NonNullable<Env['runtimeState']>;
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

const cloneGossip = (env: Env): Env['gossip'] => {
  const gossip = createGossipLayer();
  for (const profile of env.gossip?.getProfiles?.() ?? []) {
    const cloned = structuredClone(profile);
    gossip.profiles.set(cloned.entityId, cloned);
  }
  return gossip;
};

export const cloneRuntimeFrameWorkingEnv = (source: Env): Env => {
  const mempool = cloneRuntimeFrameMempool(ensureRuntimeMempool(source));
  const working: Env = {
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
    runtimeInput: mempool,
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

export const createRuntimeFrameTransaction = (liveEnv: Env): RuntimeFrameTransaction => {
  const workingEnv = cloneRuntimeFrameWorkingEnv(liveEnv);
  const workingMempool = ensureRuntimeMempool(workingEnv);
  const workingState = ensureRuntimeState(workingEnv);
  const liveState = ensureRuntimeState(liveEnv);
  const sharedStateBaseline = new Map(
    [...SHARED_STATE_KEYS].map(key => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(liveState, key),
        value: (liveState as Record<string, unknown>)[key],
      },
    ]),
  );
  const activeMempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };
  liveState.inFlightEntityInputs = workingMempool.entityInputs.length;
  liveEnv.runtimeMempool = activeMempool;
  liveEnv.runtimeInput = activeMempool;
  return {
    liveEnv,
    workingEnv,
    sharedStateBaseline,
    liveFrameLogBaseLength: liveEnv.frameLogs.length,
    workingCleanLogBaseLength: workingState.cleanLogs?.length ?? 0,
    liveAdapters: new Set(
      [...liveEnv.jReplicas.values()].flatMap(replica => replica.jadapter ? [replica.jadapter] : []),
    ),
    published: false,
  };
};

export const runtimeInputHasQueuedWork = (input: RuntimeInput): boolean =>
  input.runtimeTxs.length > 0 ||
  input.entityInputs.length > 0 ||
  (input.jInputs?.length ?? 0) > 0 ||
  (input.reliableReceipts?.length ?? 0) > 0;

/** Restore older detached input before work that arrived in the active mempool. */
export const prependOlderRuntimeInput = (older: RuntimeInput, newer: RuntimeInput): RuntimeInput => {
  const merged: RuntimeInput = {
    runtimeTxs: [...older.runtimeTxs, ...newer.runtimeTxs],
    entityInputs: [...older.entityInputs, ...newer.entityInputs],
    ...((older.jInputs?.length ?? 0) + (newer.jInputs?.length ?? 0) > 0
      ? { jInputs: [...(older.jInputs ?? []), ...(newer.jInputs ?? [])] }
      : {}),
    ...((older.reliableReceipts?.length ?? 0) + (newer.reliableReceipts?.length ?? 0) > 0
      ? { reliableReceipts: [...(older.reliableReceipts ?? []), ...(newer.reliableReceipts ?? [])] }
      : {}),
  };
  const queuedAt = [older.queuedAt, newer.queuedAt]
    .filter((value): value is number => Number.isFinite(value))
    .reduce<number | undefined>(
      (latest, value) => latest === undefined ? value : Math.max(latest, value),
      undefined,
    );
  if (runtimeInputHasQueuedWork(merged) && queuedAt !== undefined) merged.queuedAt = queuedAt;
  return merged;
};

const mergeEntityHints = (
  working: NonNullable<Env['runtimeState']>['entityRuntimeHints'],
  live: NonNullable<Env['runtimeState']>['entityRuntimeHints'],
) => {
  const merged = new Map(working ?? []);
  for (const [entityId, candidate] of live ?? []) {
    const current = merged.get(entityId);
    if (!current || candidate.seenAt > current.seenAt) merged.set(entityId, candidate);
  }
  return merged;
};

const publishRuntimeState = (transaction: RuntimeFrameTransaction): void => {
  const { liveEnv, workingEnv } = transaction;
  const liveState = ensureRuntimeState(liveEnv);
  const workingState = ensureRuntimeState(workingEnv);
  const liveRecord = liveState as Record<string, unknown>;
  const selectedShared = reconcileRuntimeFrameSharedState(
    transaction.sharedStateBaseline,
    liveRecord,
    workingState as Record<string, unknown>,
    SHARED_STATE_KEYS,
  );
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workingState)) {
    if (!SHARED_STATE_KEYS.has(key) && !LIVE_STATE_KEYS.has(key)) next[key] = value;
  }
  for (const key of LIVE_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(liveRecord, key)) next[key] = liveRecord[key];
  }
  for (const [key, snapshot] of selectedShared) {
    if (snapshot.present) next[key] = snapshot.value;
  }
  const hints = mergeEntityHints(workingState.entityRuntimeHints, liveState.entityRuntimeHints);
  next['entityRuntimeHints'] = hints;
  assertRuntimeFrameStorageState(next);
  for (const key of Object.keys(liveState)) delete liveRecord[key];
  Object.assign(liveRecord, next);

  const cleanTail = (workingState.cleanLogs ?? []).slice(transaction.workingCleanLogBaseLength);
  if (cleanTail.length > 0) {
    liveState.cleanLogs = [...(liveState.cleanLogs ?? []), ...cleanTail].slice(-2_000);
  }
  liveState.logState ??= { nextId: 0, mirrorToConsole: true };
  liveState.logState.nextId = Math.max(liveState.logState.nextId, workingState.logState?.nextId ?? 0);
};

export const publishRuntimeFrameTransaction = (transaction: RuntimeFrameTransaction): Env => {
  if (transaction.published) return transaction.liveEnv;
  const { liveEnv, workingEnv } = transaction;
  const activeMempool = ensureRuntimeMempool(liveEnv);
  const workingMempool = ensureRuntimeMempool(workingEnv);
  publishRuntimeState(transaction);

  liveEnv.height = workingEnv.height;
  liveEnv.timestamp = workingEnv.timestamp;
  liveEnv.eReplicas = workingEnv.eReplicas;
  liveEnv.jReplicas = workingEnv.jReplicas;
  for (const key of [
    'activeJurisdiction',
    'browserVM',
    'browserVMState',
    'jAdapter',
    'overlay',
    'pendingOutputs',
    'networkInbox',
    'pendingNetworkOutputs',
    'extra',
  ] as const) {
    if (workingEnv[key] === undefined) delete liveEnv[key];
    else (liveEnv as unknown as Record<string, unknown>)[key] = workingEnv[key];
  }
  liveEnv.history = [];
  liveEnv.frameLogs = liveEnv.frameLogs.slice(transaction.liveFrameLogBaseLength);
  const mergedMempool = prependOlderRuntimeInput(workingMempool, activeMempool);
  liveEnv.runtimeMempool = mergedMempool;
  liveEnv.runtimeInput = mergedMempool;
  const state = ensureRuntimeState(liveEnv);
  state.wakeRequested =
    state.wakeRequested === true ||
    runtimeInputHasQueuedWork(mergedMempool) ||
    (state.pendingProfileCertificationEntityIds?.size ?? 0) > 0;
  rebuildScheduledWakeIndex(liveEnv);
  for (const replica of liveEnv.jReplicas.values()) {
    replica.jadapter?.setBlockTimestamp(liveEnv.timestamp);
  }
  transaction.published = true;
  return liveEnv;
};

type ClosableRuntimeResource = {
  close(): void | Promise<void>;
};

const isClosableRuntimeResource = (value: unknown): value is ClosableRuntimeResource =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { close?: unknown }).close === 'function';

const closeCandidateRuntimeDbHandles = async (
  transaction: RuntimeFrameTransaction,
): Promise<Error[]> => {
  const liveState = ensureRuntimeState(transaction.liveEnv) as Record<string, unknown>;
  const workingState = ensureRuntimeState(transaction.workingEnv) as Record<string, unknown>;
  const protectedHandles = new Set<unknown>();
  for (const group of RUNTIME_FRAME_DB_HANDLE_GROUPS) {
    const handleKey = group.keys[0]!;
    protectedHandles.add(transaction.sharedStateBaseline.get(handleKey)?.value);
    protectedHandles.add(liveState[handleKey]);
  }

  const candidates = new Map<ClosableRuntimeResource, unknown>();
  for (const group of RUNTIME_FRAME_DB_HANDLE_GROUPS) {
    const [handleKey, promiseKey] = group.keys;
    const handle = workingState[handleKey!];
    if (isClosableRuntimeResource(handle) && !protectedHandles.has(handle)) {
      candidates.set(handle, workingState[promiseKey!]);
    }
  }

  const errors: Error[] = [];
  for (const [handle, openPromise] of candidates) {
    if (openPromise instanceof Promise) {
      try {
        await openPromise;
      } catch (cause) {
        errors.push(new Error('RUNTIME_FRAME_CANDIDATE_DB_OPEN_FAILED', { cause }));
      }
    }
    try {
      await handle.close();
    } catch (cause) {
      errors.push(new Error('RUNTIME_FRAME_CANDIDATE_DB_CLOSE_FAILED', { cause }));
    }
  }
  return errors;
};

export const abortRuntimeFrameTransaction = async (
  transaction: RuntimeFrameTransaction,
): Promise<Error[]> => {
  const uncommitted = new Set(
    [...transaction.workingEnv.jReplicas.values()].flatMap(replica =>
      replica.jadapter && !transaction.liveAdapters.has(replica.jadapter) ? [replica.jadapter] : []),
  );
  const settled = await Promise.allSettled([...uncommitted].map(adapter => adapter.close()));
  for (const replica of transaction.liveEnv.jReplicas.values()) {
    replica.jadapter?.setBlockTimestamp(transaction.liveEnv.timestamp);
  }
  const adapterErrors = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
  return [...adapterErrors, ...await closeCandidateRuntimeDbHandles(transaction)];
};
