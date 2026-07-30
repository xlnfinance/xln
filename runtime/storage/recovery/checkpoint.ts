import { parseProfile, type Profile } from '../../entity/profile';
import { validateEntityReplica } from '../../entity/replica-validation';
import { normalizeRuntimeId } from '../../networking/runtime-id';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { cloneIsolatedRuntimeSnapshot } from '../../runtime/input-clone';
import { assertAccountJClaimRootsAvailable } from '../../entity/account-j-claim-node-store';
import { assertConsumptionRootsAvailable } from '../../entity/consumption-store';
import { setBrowserVMJurisdiction } from '../../jadapter/browservm-registry';
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
import type { RuntimeReplica } from '../../runtime/types';
import { normalizeDbNamespace } from '../runtime-dbs';
import { restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import { validateJReplicas } from '../wal/runtime-machine-schema/j';

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

const requireCheckpointEntries = (
  raw: unknown,
  code: string,
): Array<[string, unknown]> => {
  const entries = raw instanceof Map ? [...raw.entries()] : raw;
  if (!Array.isArray(entries)) throw new Error(code);
  const decoded = entries.map((entry, index): [string, unknown] => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${code}:entry=${index}`);
    }
    const key = entry[0];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`${code}:key=${index}`);
    }
    return [key, entry[1]];
  });
  if (new Set(decoded.map(([key]) => key)).size !== decoded.length) {
    throw new Error(`${code}:duplicate_key`);
  }
  return decoded;
};

const restoreCheckpointState = (env: RuntimeReplica, snapshot: Record<string, unknown>): Profile[] => {
  env.state.height = requireBoundaryInteger(snapshot['height'], 'RECOVERY_CHECKPOINT_HEIGHT_INVALID');
  env.state.timestamp = requireBoundaryInteger(snapshot['timestamp'], 'RECOVERY_CHECKPOINT_TIMESTAMP_INVALID');
  const entityEntries = requireCheckpointEntries(
    snapshot['eReplicas'],
    'RECOVERY_CHECKPOINT_ENTITY_REPLICAS_INVALID',
  );
  const jurisdictionEntries = requireCheckpointEntries(
    snapshot['jReplicas'],
    'RECOVERY_CHECKPOINT_J_REPLICAS_INVALID',
  );
  const { eReplicas: _entityReplicas, jReplicas: _jurisdictionReplicas, ...durableSnapshot } = snapshot;
  restoreDurableRuntimeSnapshot(env, durableSnapshot);
  env.state.eReplicas = new Map(entityEntries.map(([key, replica], index) => [
    key,
    validateEntityReplica(replica, `RecoveryCheckpoint.EntityReplica[${index}]`),
  ]));
  env.state.jReplicas = new Map(validateJReplicas(
    jurisdictionEntries,
    'RECOVERY_CHECKPOINT_J_REPLICA',
  ));
  const gossip =
    snapshot['gossip'] && typeof snapshot['gossip'] === 'object'
      ? (snapshot['gossip'] as { profiles?: unknown })
      : null;
  env.frameLogs = [];
  env.overlay = [];
  if (gossip?.profiles === undefined) return [];
  if (!Array.isArray(gossip.profiles)) throw new Error('RECOVERY_CHECKPOINT_GOSSIP_PROFILES_INVALID');
  return gossip.profiles.map(parseProfile);
};

const assertCheckpointCommitments = async (env: RuntimeReplica): Promise<void> => {
  for (const replica of env.state.eReplicas.values()) {
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
): Promise<RuntimeReplica> => {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('RECOVERY_CHECKPOINT_INVALID');

  const normalizedSnapshot = cloneIsolatedRuntimeSnapshot(snapshot);
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
