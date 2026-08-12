import { parseProfile, type Profile } from '../../entity/profile';
import { validateEntityReplica } from '../../entity/replica/replica-validation';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import { cloneIsolatedRuntimeSnapshot } from '../../runtime/input-clone';
import { assertAccountJClaimRootsAvailable } from '../../entity/account/account-j-claim-node-store';
import { assertConsumptionRootsAvailable } from '../../entity/consumption/consumption-store';
import { assertCertifiedBoardRootsAvailable } from '../../jurisdiction/machine/board-registry';
import { assertCertifiedRegistrationEvidenceStore } from '../../jurisdiction/machine/registration-evidence';
import {
  assertCertifiedJHistoryIntegrity,
  assertValidatorJHistoryMatchesCertifiedAnchor,
} from '../../jurisdiction/machine/local-history';
import type { RuntimeReplica } from '../../runtime/types';
import { normalizeDbNamespace } from '../runtime-dbs';
import { restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import { validateDurableRuntimeMachineSnapshot } from '../wal/runtime-machine-schema';
import { validateJReplicas } from '../wal/runtime-machine-schema/j';
import { assertCrossJLocalCohorts } from '../../runtime/cross-j-topology';

type RuntimeModule = typeof import('../../runtime');

export interface CheckpointRestoreOptions {
  runtimeSeed?: string | null;
  runtimeId?: string | null;
  readOnly?: boolean;
}

export interface CheckpointRestoreDeps {
  createEmptyEnv: RuntimeModule['createEmptyEnv'];
}

export type DecodedCheckpointSnapshot = {
  env: RuntimeReplica;
  gossipProfiles: Profile[];
};

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
  const {
    eReplicas: _entityReplicas,
    jReplicas: _jurisdictionReplicas,
    height: _height,
    timestamp: _timestamp,
    gossip: _gossip,
    ...durableSnapshot
  } = snapshot;
  // Portable recovery is an untrusted storage boundary. Validate the same
  // Runtime-machine payload used by WAL replay before installing any field;
  // silently ignoring malformed optional configuration would let corruption
  // change recovery semantics without invalidating the checkpoint.
  const validatedRuntimeMachine = validateDurableRuntimeMachineSnapshot(
    { ...durableSnapshot, jReplicas: jurisdictionEntries },
    'RECOVERY_CHECKPOINT_RUNTIME_MACHINE',
  );
  restoreDurableRuntimeSnapshot(env, validatedRuntimeMachine);
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
export const decodeCheckpointSnapshot = async (
  deps: CheckpointRestoreDeps,
  snapshot: Record<string, unknown>,
  options: CheckpointRestoreOptions = {},
): Promise<DecodedCheckpointSnapshot> => {
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
  assertCrossJLocalCohorts(env);
  await assertCheckpointCommitments(env);
  return { env, gossipProfiles };
};
