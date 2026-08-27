import { getLiveAccountJClaimAccumulatorStates } from '../../entity/account/account-j-claim-node-store';
import { createReplicaKey, formatReplicaKey } from '../../protocol/identity';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryIntegrity,
  pruneFinalizedValidatorJHistory,
} from '../../jurisdiction/machine/local-history';
import { assertCertifiedRegistrationEvidenceStore } from '../../jurisdiction/machine/registration-evidence';
import { restoreJPrefixRound } from '../../jurisdiction/machine/history/j-prefix-consensus';
import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import {
  applyCertifiedEntityHeadPlan,
  buildCertifiedEntityHeadPlan,
} from '../replica/entity-head';
import {
  hydrateAccountJClaimRootNodesFromStorage,
  hydrateCertifiedBoardRootNodesFromStorage,
} from '..';
import { computeCanonicalEntityHash } from '../canonical-hash';
import type { PersistedStorageReadApi } from '../read/persisted-read';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import { assertPersistedJurisdictionsAvailable, resolvePersistedReplicaIdentity } from './identity';
import { assertCrossJLocalCohorts } from '../../runtime/delivery/topology/cross-j-topology';

const installPersistedEntityReplicas = async (
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  restoredStates: Map<string, EntityState>,
  targetHeight: number,
  latestHeight: number,
  selectedSnapshotHeight: number,
  usesLiveMaterializedCheckpoint: boolean,
): Promise<void> => {
  env.state.eReplicas = new Map();
  for (const [entityId, state] of restoredStates.entries()) {
    const persistedMetas =
      targetHeight === latestHeight || usesLiveMaterializedCheckpoint
        ? await reads.readPersistedStorageReplicaMetas(env, entityId, state)
        : targetHeight === selectedSnapshotHeight
          ? await reads.readPersistedStorageSnapshotReplicaMetas(
              env,
              selectedSnapshotHeight,
              entityId,
              state,
            )
          : [];
    const metas = persistedMetas.length > 0 ? persistedMetas : [null];
    for (const meta of metas) {
      const isLatestRestore = targetHeight === latestHeight;
      const isCheckpointRestore =
        targetHeight === selectedSnapshotHeight || usesLiveMaterializedCheckpoint;
      const requiresExactReplica = isLatestRestore || isCheckpointRestore;
      if (requiresExactReplica && !meta) {
        throw new Error(
          `STORAGE_RESTORE_REPLICA_META_REQUIRED:entity=${entityId}:` +
          `height=${targetHeight}:` +
          `source=${isLatestRestore ? 'head' : 'checkpoint'}`,
        );
      }
      // A materialized checkpoint is emitted only when every local validator
      // replica for this Entity shares this exact committed state. Transient
      // validator lag lives in subsequent Runtime inputs and is reconstructed
      // by WAL replay; replica metadata must never embed another Entity graph.
      const persistedReplicaState = state;
      if (
        String(persistedReplicaState.entityId || '').toLowerCase() !==
        entityId.toLowerCase()
      ) {
        throw new Error(
          `STORAGE_RESTORE_REPLICA_STATE_ENTITY_MISMATCH: ` +
          `expected=${entityId.toLowerCase()} ` +
          `actual=${String(persistedReplicaState.entityId || '').toLowerCase()}`,
        );
      }
      assertCertifiedJHistoryIntegrity(persistedReplicaState);
      const { signerId, isProposer } = resolvePersistedReplicaIdentity(
        entityId,
        persistedReplicaState,
        meta,
        targetHeight,
        latestHeight,
      );
      const validatorJHistory = pruneFinalizedValidatorJHistory(
        meta?.jHistory,
        persistedReplicaState.lastFinalizedJHeight,
      );
      try {
        assertValidatorJHistoryIntegrity(persistedReplicaState, validatorJHistory);
      } catch (cause) {
        throw new Error(
          `STORAGE_RESTORE_VALIDATOR_J_HISTORY_INVALID:${entityId}:${meta?.signerId ?? 'unknown'}:` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      // Persisted Entity state is already an owned, validated decode. Local
      // validator replicas share that immutable committed root; speculative
      // work belongs in their overlays/candidates and must never clone the
      // unbounded Account or orderbook collections during recovery.
      const replicaState = persistedReplicaState;
      // Process-local private keys are rederived from the authoritative
      // Runtime snapshot seed map after all persisted replicas are installed,
      // then asserted before the recovered Runtime can be returned or used.
      const restoredReplica: EntityReplica = {
        entityId,
        signerId,
        state: replicaState,
        mempool: requiresExactReplica ? meta!.mempool : [],
        isProposer,
        ...(meta?.htlcNotes ? { htlcNotes: meta.htlcNotes } : {}),
        // Absence and an empty witness map are different canonical envelope
        // bytes. Recovery must reproduce the persisted replica exactly; the
        // consensus path creates this optional map only when it stores the
        // first locally generated witness.
        ...(meta?.hankoWitness ? { hankoWitness: meta.hankoWitness } : {}),
        ...(meta?.proposal ? { proposal: meta.proposal } : {}),
        ...(meta?.lockedFrame ? { lockedFrame: meta.lockedFrame } : {}),
        ...(meta?.candidate
          ? { candidate: meta.candidate }
          : {}),
        ...(meta?.certifiedFrameHead
          ? { certifiedFrameHead: meta.certifiedFrameHead }
          : {}),
        ...(meta?.position ? { position: meta.position } : {}),
        ...(validatorJHistory ? { jHistory: validatorJHistory } : {}),
        ...(meta?.jSubmitState ? { jSubmitState: meta.jSubmitState } : {}),
        ...(meta?.entityProviderActionSubmitState
          ? {
              entityProviderActionSubmitState:
                meta.entityProviderActionSubmitState,
            }
          : {}),
        ...(meta?.leaderVotes ? { leaderVotes: meta.leaderVotes } : {}),
        ...(meta?.pendingLeaderCertificate
          ? { pendingLeaderCertificate: meta.pendingLeaderCertificate }
          : {}),
        ...(meta?.lastConsensusProgressAt !== undefined
          ? { lastConsensusProgressAt: meta.lastConsensusProgressAt }
          : {}),
      };
      if (
        meta?.jPrefixRound &&
        meta.jPrefixRound.targetEntityHeight > replicaState.height
      ) {
        // A lagging validator may persist a round that the shared certified
        // Entity root has already passed. It has no authority after that root
        // is installed; only the exact next-height round may be restored.
        restoredReplica.jPrefixRound = restoreJPrefixRound(
          env,
          replicaState,
          meta.jPrefixRound,
        );
      }
      env.state.eReplicas.set(
        formatReplicaKey(createReplicaKey(entityId, signerId)),
        restoredReplica,
      );
    }
  }
};

const hydrateRestoredEntityTrees = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
  snapshotHeight?: number,
): Promise<void> => {
  const walDb = deps.getRuntimeWalDb(env);
  const boardRoots = new Set(
    Array.from(
      env.state.eReplicas.values(),
      replica => replica.state.certifiedBoardState?.boardRegistryRoot,
    ).filter((value): value is string => Boolean(value)),
  );
  for (const root of boardRoots) {
    await hydrateCertifiedBoardRootNodesFromStorage(env, walDb, root, snapshotHeight);
  }
  await hydrateAccountJClaimRootNodesFromStorage(
    env,
    walDb,
    getLiveAccountJClaimAccumulatorStates(env),
    snapshotHeight,
  );
};

const seedPersistedBookRoots = (env: RuntimeReplica): void => {
  env.infrastructure ??= {};
  const roots = new Map<string, import('../../orderbook/core').BookState>();
  const seenEntities = new Set<string>();
  for (const replica of env.state.eReplicas.values()) {
    const entityId = replica.entityId.toLowerCase();
    if (seenEntities.has(entityId)) continue;
    seenEntities.add(entityId);
    for (const [pairId, book] of replica.state.orderbookExt?.books ?? []) {
      roots.set(`${entityId}\u0000${pairId}`, book);
    }
  }
  env.infrastructure.storagePersistedBooks = roots;
};

const seedPersistedAccountRoots = (env: RuntimeReplica): void => {
  env.infrastructure ??= {};
  const roots = new Map<string, import('../../types/account').AccountReplica>();
  const seenEntities = new Set<string>();
  for (const replica of env.state.eReplicas.values()) {
    const entityId = replica.entityId.toLowerCase();
    if (seenEntities.has(entityId)) continue;
    seenEntities.add(entityId);
    for (const [counterpartyId, account] of replica.state.accounts) {
      roots.set(`${entityId}\u0000${counterpartyId.toLowerCase()}`, account);
    }
  }
  env.infrastructure.storagePersistedAccounts = roots;
};

const seedPersistedEntityRoots = (env: RuntimeReplica): void => {
  env.infrastructure ??= {};
  const roots = new Map<string, EntityState>();
  for (const replica of env.state.eReplicas.values()) {
    const entityId = replica.entityId.toLowerCase();
    if (!roots.has(entityId)) roots.set(entityId, replica.state);
  }
  env.infrastructure.storagePersistedEntities = roots;
};

const verifyRestoredEntityLineage = (
  env: RuntimeReplica,
  restoredStates: Map<string, EntityState>,
): void => {
  const headPlan = buildCertifiedEntityHeadPlan(env);
  for (const [entityId, sharedState] of restoredStates) {
    const selected = headPlan.lookup.get(entityId.toLowerCase());
    if (!selected) {
      throw new Error(`STORAGE_RESTORE_LINEAGE_ENTITY_MISSING:${entityId}`);
    }
    const selectedHash = computeCanonicalEntityHash(selected.replica).hash;
    const sharedHash = computeCanonicalEntityHash({
      ...selected.replica,
      state: sharedState,
    }).hash;
    if (selectedHash !== sharedHash) {
      throw new Error(
        `STORAGE_RESTORE_SHARED_STATE_MISMATCH:entity=${entityId}:` +
        `selected=${selectedHash}:shared=${sharedHash}`,
      );
    }
  }
  applyCertifiedEntityHeadPlan(env, headPlan);
};

export const restorePersistedEntityGraph = async (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  restoredStates: Map<string, EntityState>,
  targetHeight: number,
  latestHeight: number,
  selectedSnapshotHeight: number,
  usesLiveMaterializedCheckpoint: boolean,
): Promise<void> => {
  await installPersistedEntityReplicas(
    reads,
    env,
    restoredStates,
    targetHeight,
    latestHeight,
    selectedSnapshotHeight,
    usesLiveMaterializedCheckpoint,
  );
  assertCrossJLocalCohorts(env);
  await hydrateRestoredEntityTrees(
    deps,
    env,
    !usesLiveMaterializedCheckpoint && targetHeight === selectedSnapshotHeight
      ? selectedSnapshotHeight
      : undefined,
  );
  // Keep the exact hydrated roots as the next materialization baseline.
  // Identity-sharing is what lets nodeChangesSince emit only dirty Patricia
  // paths after restart; reading the same bytes into a second tree would make
  // the first update look like an O(all pages) rewrite.
  seedPersistedBookRoots(env);
  seedPersistedAccountRoots(env);
  seedPersistedEntityRoots(env);
  assertPersistedJurisdictionsAvailable(env);
  await assertCertifiedRegistrationEvidenceStore(env);
  if (targetHeight === latestHeight) {
    verifyRestoredEntityLineage(env, restoredStates);
  }
};
