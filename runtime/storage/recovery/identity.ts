import type { EntityState } from '../../entity/types';
import type { RuntimeState } from '../../runtime/types';
import type { StorageReplicaMeta } from '../types';

const listReplicaValidators = (state: EntityState): string[] => {
  if (!Array.isArray(state.config?.validators)) return [];
  return state.config.validators
    .map(validator => String(validator || '').toLowerCase())
    .filter(validator => validator.length > 0);
};

/**
 * Reconstruct validator-local identity only from persisted replica metadata.
 *
 * Multi-validator heads cannot guess a signer from board order: that would
 * silently attach one validator's private state to another replica.
 */
export const resolvePersistedReplicaIdentity = (
  entityId: string,
  state: EntityState,
  meta: StorageReplicaMeta | null,
  targetHeight: number,
  latestHeight: number,
): { signerId: string; isProposer: boolean } => {
  const validators = listReplicaValidators(state);
  const metaSignerId =
    typeof meta?.signerId === 'string' && meta.signerId.trim().length > 0
      ? meta.signerId.trim().toLowerCase()
      : '';
  const isLatestRestore = targetHeight === latestHeight;
  if (isLatestRestore && !metaSignerId && validators.length > 1) {
    throw new Error(
      `STORAGE_RESTORE_REPLICA_META_REQUIRED: entity=${entityId} ` +
      `validators=${validators.length} height=${targetHeight}`,
    );
  }
  const signerId =
    metaSignerId ||
    validators[0] ||
    String(state.entityId || entityId).toLowerCase();
  const isProposer =
    typeof meta?.isProposer === 'boolean'
      ? meta.isProposer
      : isLatestRestore &&
        validators.length === 1 &&
        signerId === validators[0];
  return { signerId, isProposer };
};

/**
 * Entity state names the Jurisdiction it belongs to, but it does not contain
 * the Jurisdiction frame, cursor, complete contract stack, or finality policy.
 * Reconstructing a JReplica from Entity config would therefore invent
 * consensus-relevant state. Recovery must obtain the exact JReplica from the
 * Runtime WAL instead.
 */
export const assertPersistedJurisdictionsAvailable = (env: RuntimeState): void => {
  if (env.jReplicas.size > 0) return;
  const configuredEntity = [...env.eReplicas.values()].find(
    replica => replica.state.config?.jurisdiction !== undefined,
  );
  if (configuredEntity) {
    throw new Error(
      `STORAGE_RESTORE_J_REPLICA_MISSING:entity=${configuredEntity.entityId}`,
    );
  }
};
