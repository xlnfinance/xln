import type { EntityState } from '../../entity/types';
import type { RuntimeState } from '../../types';
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
 * Jurisdiction replicas are a deterministic projection of restored Entities.
 * No RPC discovery is permitted while authoritative state is being rebuilt.
 */
export const rebuildPersistedJurisdictions = (env: RuntimeState): void => {
  env.jReplicas = new Map();
  for (const replica of env.eReplicas.values()) {
    const jurisdiction = replica.state.config?.jurisdiction as
      | Record<string, unknown>
      | undefined;
    const name =
      typeof jurisdiction?.['name'] === 'string' ? jurisdiction['name'] : '';
    if (!name || env.jReplicas.has(name)) continue;

    const depositoryAddress = String(
      jurisdiction?.['depositoryAddress'] || '',
    ).trim();
    const entityProviderAddress = String(
      jurisdiction?.['entityProviderAddress'] || '',
    ).trim();
    const deltaTransformerAddress = String(
      jurisdiction?.['deltaTransformerAddress'] ??
        jurisdiction?.['deltaTransformer'] ??
        '',
    ).trim();
    const chainId = Number.isFinite(Number(jurisdiction?.['chainId']))
      ? Number(jurisdiction?.['chainId'])
      : 31337;
    env.jReplicas.set(name, {
      name,
      depositoryAddress,
      entityProviderAddress,
      chainId,
      contracts: {
        ...(depositoryAddress ? { depository: depositoryAddress } : {}),
        ...(entityProviderAddress
          ? { entityProvider: entityProviderAddress }
          : {}),
        ...(deltaTransformerAddress
          ? { deltaTransformer: deltaTransformerAddress }
          : {}),
      },
    } as never);
    if (!env.activeJurisdiction) env.activeJurisdiction = name;
  }
};
