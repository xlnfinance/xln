import { getLiveAccountJClaimAccumulatorStates } from '../../entity/account-j-claim-node-store';
import { getLiveConsumptionAccumulatorStates } from '../../entity/consumption-store';
import { assertPersistedLocalEntityCryptoKeys } from '../../entity/crypto';
import { createReplicaKey, formatReplicaKey } from '../../protocol/identity';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryIntegrity,
} from '../../jurisdiction/local-history';
import { assertCertifiedRegistrationEvidenceStore } from '../../jurisdiction/registration-evidence';
import { restoreJPrefixRound } from '../../jurisdiction/j-prefix-consensus';
import { cloneEntityState } from '../../entity/state-clone';
import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
} from '../entity-lineage';
import {
  hydrateAccountJClaimRootNodesFromStorage,
  hydrateCertifiedBoardRootNodesFromStorage,
  hydrateConsumptionRootNodesFromStorage,
} from '..';
import { computeCanonicalEntityHash } from '../canonical-hash';
import type { PersistedStorageReadApi } from '../persisted-read';
import type { RuntimeStorageApiDeps } from '../runtime-storage-deps';
import { assertPersistedJurisdictionsAvailable, resolvePersistedReplicaIdentity } from './identity';

const installPersistedEntityReplicas = async (
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  restoredStates: Map<string, EntityState>,
  targetHeight: number,
  latestHeight: number,
  selectedSnapshotHeight: number,
): Promise<void> => {
  env.eReplicas = new Map();
  for (const [entityId, state] of restoredStates.entries()) {
    const persistedMetas =
      targetHeight === latestHeight
        ? await reads.readPersistedStorageReplicaMetas(env, entityId, state)
        : targetHeight === selectedSnapshotHeight
          ? await reads.readPersistedStorageSnapshotReplicaMetas(
              env,
              selectedSnapshotHeight,
              entityId,
            )
          : [];
    const metas = persistedMetas.length > 0 ? persistedMetas : [null];
    for (const meta of metas) {
      const isLatestRestore = targetHeight === latestHeight;
      const isCheckpointRestore = targetHeight === selectedSnapshotHeight;
      const requiresExactReplica = isLatestRestore || isCheckpointRestore;
      if (requiresExactReplica && !meta) {
        throw new Error(
          `STORAGE_RESTORE_REPLICA_META_REQUIRED:entity=${entityId}:` +
          `height=${targetHeight}:` +
          `source=${isLatestRestore ? 'head' : 'checkpoint'}`,
        );
      }
      const persistedReplicaState = requiresExactReplica
        ? (meta?.state ?? state)
        : state;
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
      assertValidatorJHistoryIntegrity(persistedReplicaState, meta?.jHistory);
      const replicaState = cloneEntityState(persistedReplicaState, true);
      if (requiresExactReplica) {
        assertPersistedLocalEntityCryptoKeys(env, entityId, signerId, meta!);
      }
      // Intermediate historical views intentionally lack validator-local
      // private keys. Only a live head or certified checkpoint restores them.
      const restoredReplica: EntityReplica = {
        entityId,
        signerId,
        entityEncPubKey: meta?.entityEncPubKey ?? '',
        entityEncPrivKey: meta?.entityEncPrivKey ?? '',
        state: replicaState,
        mempool: requiresExactReplica ? meta!.mempool : [],
        isProposer,
        hankoWitness: meta?.hankoWitness ?? new Map(),
        ...(meta?.proposal ? { proposal: meta.proposal } : {}),
        ...(meta?.lockedFrame ? { lockedFrame: meta.lockedFrame } : {}),
        ...(meta?.candidate
          ? { candidate: meta.candidate }
          : {}),
        ...(meta?.certifiedFrameLineage
          ? { certifiedFrameLineage: meta.certifiedFrameLineage }
          : {}),
        ...(meta?.certifiedFrameAnchor
          ? { certifiedFrameAnchor: meta.certifiedFrameAnchor }
          : {}),
        ...(meta?.position ? { position: meta.position } : {}),
        ...(meta?.jHistory ? { jHistory: meta.jHistory } : {}),
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
      if (meta?.jPrefixRound) {
        restoredReplica.jPrefixRound = restoreJPrefixRound(
          env,
          replicaState,
          meta.jPrefixRound,
        );
      }
      env.eReplicas.set(
        formatReplicaKey(createReplicaKey(entityId, signerId)),
        restoredReplica,
      );
    }
  }
};

const hydrateRestoredEntityDags = async (
  deps: RuntimeStorageApiDeps,
  env: RuntimeReplica,
): Promise<void> => {
  const walDb = deps.getRuntimeWalDb(env);
  const boardRoots = new Set(
    Array.from(
      env.eReplicas.values(),
      replica => replica.state.certifiedBoardState?.boardRegistryRoot,
    ).filter((value): value is string => Boolean(value)),
  );
  for (const root of boardRoots) {
    await hydrateCertifiedBoardRootNodesFromStorage(env, walDb, root);
  }
  for (const state of getLiveConsumptionAccumulatorStates(env)) {
    await hydrateConsumptionRootNodesFromStorage(env, walDb, state);
  }
  await hydrateAccountJClaimRootNodesFromStorage(
    env,
    walDb,
    getLiveAccountJClaimAccumulatorStates(env),
  );
};

const verifyRestoredEntityLineage = (
  env: RuntimeReplica,
  restoredStates: Map<string, EntityState>,
): void => {
  const lineagePlan = buildCertifiedEntityLineagePlan(env);
  for (const [entityId, sharedState] of restoredStates) {
    const selected = lineagePlan.lookup.get(entityId.toLowerCase());
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
  applyCertifiedEntityLineagePlan(env, lineagePlan);
};

export const restorePersistedEntityGraph = async (
  deps: RuntimeStorageApiDeps,
  reads: PersistedStorageReadApi,
  env: RuntimeReplica,
  restoredStates: Map<string, EntityState>,
  targetHeight: number,
  latestHeight: number,
  selectedSnapshotHeight: number,
): Promise<void> => {
  await installPersistedEntityReplicas(
    reads,
    env,
    restoredStates,
    targetHeight,
    latestHeight,
    selectedSnapshotHeight,
  );
  await hydrateRestoredEntityDags(deps, env);
  assertPersistedJurisdictionsAvailable(env);
  await assertCertifiedRegistrationEvidenceStore(env);
  if (targetHeight === latestHeight) {
    verifyRestoredEntityLineage(env, restoredStates);
  }
};
