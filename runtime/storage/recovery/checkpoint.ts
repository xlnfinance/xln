import type { Profile } from '../../networking/gossip';
import { normalizeRuntimeId } from '../../networking/runtime-id';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { cloneIsolatedRuntimeSnapshot } from '../../protocol/runtime-input-clone';
import { assertAccountJClaimRootsAvailable } from '../../account/j-claim-store';
import { assertConsumptionRootsAvailable } from '../../entity/consumption-store';
import { setBrowserVMJurisdiction } from '../../jadapter';
import { assertCertifiedBoardRootsAvailable } from '../../jurisdiction/board-registry';
import { assertCertifiedRegistrationEvidenceStore } from '../../jurisdiction/registration-evidence';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryMatchesCertifiedAnchor,
} from '../../jurisdiction/local-history';
import { rehydrateRestoredRuntimeInfra } from '../../runtime/infra';
import { loadGossipProfilesFromInfraDb } from '../../runtime/infra-gossip-store';
import { assertPersistedContractConfigReady, registerCommittedSingleSignerWallets } from '../../runtime/recovery-infra';
import { runtimeIsBrowser } from '../../infra/runtime-process';
import type { RuntimeState } from '../../types';
import { normalizeDbNamespace } from '../runtime-dbs';
import { normalizePersistedSnapshotInPlace, restoreDurableRuntimeSnapshot } from '../wal/snapshot';

type RuntimeModule = typeof import('../../runtime');

export interface CheckpointRestoreOptions {
  runtimeSeed?: string | null;
  runtimeId?: string | null;
  readOnly?: boolean;
}

export interface CheckpointRestoreDeps {
  createEmptyEnv: RuntimeModule['createEmptyEnv'];
  infraGossipDbAccess: Parameters<typeof loadGossipProfilesFromInfraDb>[1];
}

const normalizeCheckpointReplicaMap = (raw: unknown): Map<string, unknown> => {
  if (raw instanceof Map) return new Map(raw.entries());
  if (!Array.isArray(raw)) return new Map();
  return new Map(
    raw
      .filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length >= 2)
      .map(([key, value]) => [String(key), value]),
  );
};

const restoreCheckpointState = (env: RuntimeState, snapshot: Record<string, unknown>): Profile[] => {
  env.height = requireBoundaryInteger(snapshot['height'], 'RECOVERY_CHECKPOINT_HEIGHT_INVALID');
  env.timestamp = requireBoundaryInteger(snapshot['timestamp'], 'RECOVERY_CHECKPOINT_TIMESTAMP_INVALID');
  env.eReplicas =
    snapshot['eReplicas'] instanceof Map
      ? new Map(Array.from(snapshot['eReplicas'].entries(), ([key, value]) => [String(key), value as never]))
      : new Map();
  env.jReplicas =
    snapshot['jReplicas'] instanceof Map
      ? new Map(Array.from(snapshot['jReplicas'].entries(), ([key, value]) => [String(key), value as never]))
      : new Map();
  env.activeJurisdiction =
    typeof snapshot['activeJurisdiction'] === 'string' ? snapshot['activeJurisdiction'] : env.activeJurisdiction;

  if (snapshot['browserVMState'] !== undefined) {
    Object.assign(env, {
      browserVMState: structuredClone(snapshot['browserVMState']) as RuntimeState['browserVMState'],
    });
  }
  const gossip =
    snapshot['gossip'] && typeof snapshot['gossip'] === 'object'
      ? (snapshot['gossip'] as { profiles?: unknown })
      : null;
  env.runtimeMempool = { runtimeTxs: [], entityInputs: [] };
  env.frameLogs = [];
  env.networkInbox = [];
  env.pendingNetworkOutputs = [];
  env.overlay = [];
  restoreDurableRuntimeSnapshot(env, snapshot);
  return Array.isArray(gossip?.profiles) ? (gossip.profiles as Profile[]) : [];
};

const assertCheckpointCommitments = async (env: RuntimeState): Promise<void> => {
  for (const replica of env.eReplicas.values()) {
    assertCertifiedJHistoryIntegrity(replica.state);
    assertValidatorJHistoryMatchesCertifiedAnchor(replica.state, replica.jHistory);
  }
  assertCertifiedBoardRootsAvailable(env);
  assertConsumptionRootsAvailable(env);
  assertAccountJClaimRootsAvailable(env);
  await assertCertifiedRegistrationEvidenceStore(env);
};

// A recovery bundle uses the canonical WAL checkpoint representation. Keeping one
// decoder prevents backup import and local crash recovery from drifting into two
// subtly different state machines.
export const restoreCheckpointSnapshot = async (
  deps: CheckpointRestoreDeps,
  snapshot: Record<string, unknown>,
  options: CheckpointRestoreOptions = {},
): Promise<RuntimeState> => {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('RECOVERY_CHECKPOINT_INVALID');

  const normalizedSnapshot = cloneIsolatedRuntimeSnapshot(snapshot);
  normalizePersistedSnapshotInPlace(normalizedSnapshot, {
    normalizeReplicaMap: normalizeCheckpointReplicaMap,
    normalizeJReplicaMap: normalizeCheckpointReplicaMap,
  });
  const snapshotSeed = typeof normalizedSnapshot['runtimeSeed'] === 'string' ? normalizedSnapshot['runtimeSeed'] : null;
  const env = deps.createEmptyEnv(options.runtimeSeed === undefined ? snapshotSeed : options.runtimeSeed);
  const runtimeId = normalizeRuntimeId(
    options.runtimeId ?? String(normalizedSnapshot['runtimeId'] || env.runtimeId || ''),
  );
  if (!runtimeId) throw new Error('RECOVERY_CHECKPOINT_RUNTIME_ID_REQUIRED');
  env.runtimeId = runtimeId;
  env.dbNamespace = normalizeDbNamespace(runtimeId);

  const gossipProfiles = restoreCheckpointState(env, normalizedSnapshot);
  await assertCheckpointCommitments(env);
  if (!options.readOnly) {
    await rehydrateRestoredRuntimeInfra(env, {
      isBrowser: runtimeIsBrowser,
      loadGossipProfiles: target => loadGossipProfilesFromInfraDb(target, deps.infraGossipDbAccess),
      assertPersistedContractConfigReady,
      setBrowserVMJurisdiction,
    });
  }
  registerCommittedSingleSignerWallets(env);
  for (const profile of gossipProfiles) env.gossip?.announce?.(profile);
  return env;
};
