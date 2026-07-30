import { buildDefaultEntitySwapPairs, getTokenIdsForJurisdiction } from '../account/utils';
import { applyRuntimeStorageChanges } from './env-events';
import {
  canonicalizeLocalEntityCryptoKeys,
  resolveReplicaEntityCryptoKeys,
} from '../entity/crypto';
import { normalizeEntitySwapTradingPairs } from './swap-pairs';
import { initCrontab } from '../entity/scheduler';
import {
  buildEntityFrameAuthority,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import {
  backfillEntityJurisdictionBinding,
  requireBoundEntityConfig,
} from '../jurisdiction/jurisdiction-runtime';
import { getJHistoryRegistrationBaseHeight } from '../jurisdiction/history-consensus';
import {
  assertValidatorJHistoryMatchesCertifiedAnchor,
  getEntityCertifiedJAnchor,
  recordValidatorJHistory,
  rewindValidatorJHistory,
} from '../jurisdiction/local-history';
import { getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { normalizeRuntimeId } from '../networking/runtime-id';
import type { EntityReplica, EntityState } from '../entity/types';
import type { RuntimeReplica, RuntimeTx } from './types';
import type { JInput } from '../jurisdiction/input';
import { applyRuntimeAdapterCommandMarker } from '../radapter/command-frontier';
import { assertRuntimeAdapterCommandTxAuthorized } from '../radapter/command-frontier-auth';
import {
  applyRetryJSubmitRuntimeTx,
  assertJSubmitRuntimeTxAuthorized,
} from './j-submit-state';
import { applyRecordJSubmitResultRuntimeTx } from './j-submit-result';
import {
  applyRetryEntityProviderActionRuntimeTx,
} from './entity-provider-action-submit-state';
import { assertEntityProviderActionRuntimeTxAuthorized } from './entity-provider-action-submit-auth';
import { applyRecordEntityProviderActionResultRuntimeTx } from './entity-provider-action-submit-result';
import { DEBUG } from '../infra/debug-flags';
import { createStructuredLogger } from '../infra/logger';
import { cloneEntityState } from '../entity/state-clone';
import { buildRuntimeCheckpointLineagePlan } from '../storage/entity-lineage';
import {
  assertCertifiedRegistrationEvidence,
  assertJAuthorityRuntimeTxAuthorized,
  computeRegistrationEvidenceClaimHash,
  freezeCertifiedRegistrationEvidence,
  registrationEvidenceKey,
} from '../jurisdiction/registration-evidence';
import {
  applyCompleteImportJurisdiction,
  applyImportJurisdictionIntent,
  assertJImportResultRuntimeTxAuthorized,
} from './jurisdiction-import';
import { applyWatcherJurisdictionCursor } from '../jadapter/watcher-cursor';
import {
  applyNumberedRegistrationIntent,
  applyNumberedRegistrationResolution,
} from './registration/numbered-registration-intent';

const runtimeTxLog = createStructuredLogger('runtime.tx');

type ImportReplicaRuntimeTx = Extract<RuntimeTx, { type: 'importReplica' }>;

export interface RuntimeTxHandlerDeps {
  isReplay?: boolean;
}

const commitRuntimeTxEntityChange = (env: RuntimeReplica, entityId: string | undefined): JInput[] => {
  if (entityId) applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
  return [];
};

export const applyRuntimeTx = async (
  env: RuntimeReplica,
  runtimeTx: RuntimeTx,
  deps: RuntimeTxHandlerDeps = {},
): Promise<JInput[]> => {
  assertJSubmitRuntimeTxAuthorized(runtimeTx, deps.isReplay === true);
  assertJAuthorityRuntimeTxAuthorized(runtimeTx, deps.isReplay === true);
  assertJImportResultRuntimeTxAuthorized(runtimeTx, deps.isReplay === true);
  assertEntityProviderActionRuntimeTxAuthorized(runtimeTx, deps.isReplay === true);
  assertRuntimeAdapterCommandTxAuthorized(runtimeTx, deps.isReplay === true);
  if (runtimeTx.type === 'recordRuntimeAdapterCommand') {
    applyRuntimeAdapterCommandMarker(env, runtimeTx.data);
    return [];
  }
  if (runtimeTx.type === 'recordNumberedRegistrationIntent') {
    applyNumberedRegistrationIntent(env, runtimeTx.data);
    return [];
  }
  if (runtimeTx.type === 'resolveNumberedRegistrationIntent') {
    applyNumberedRegistrationResolution(env, runtimeTx.data);
    return [];
  }
  if (runtimeTx.type === 'recordAuthenticatedJAuthority') {
    await assertCertifiedRegistrationEvidence(env, runtimeTx.data);
    const key = registrationEvidenceKey(runtimeTx.data.stackKey, runtimeTx.data.entityId);
    env.infrastructure ??= {};
    env.infrastructure.certifiedRegistrationEvidence ??= new Map();
    const existing = env.infrastructure.certifiedRegistrationEvidence.get(key);
    if (existing) {
      const existingClaimHash = computeRegistrationEvidenceClaimHash(existing);
      const incomingClaimHash = computeRegistrationEvidenceClaimHash(runtimeTx.data);
      if (existingClaimHash !== incomingClaimHash) {
        throw new Error(`J_AUTHORITY_EVIDENCE_CONFLICT:${key}:${existingClaimHash}:${incomingClaimHash}`);
      }
      return [];
    }
    env.infrastructure.certifiedRegistrationEvidence.set(
      key,
      freezeCertifiedRegistrationEvidence(structuredClone(runtimeTx.data)),
    );
    return [];
  }
  if (runtimeTx.type === 'importJ') {
    applyImportJurisdictionIntent(env, runtimeTx);
    return [];
  }
  if (runtimeTx.type === 'completeImportJ') {
    applyCompleteImportJurisdiction(env, runtimeTx);
    return [];
  }
  if (runtimeTx.type === 'importReplica') {
    return commitRuntimeTxEntityChange(env, importReplicaRuntimeTx(env, runtimeTx));
  }
  if (runtimeTx.type === 'observeJRange') {
    return commitRuntimeTxEntityChange(env, observeJRangeRuntimeTx(env, runtimeTx));
  }
  if (runtimeTx.type === 'advanceJWatcherCursor') {
    applyWatcherJurisdictionCursor(env, runtimeTx.data);
    return [];
  }
  if (runtimeTx.type === 'rewindJHistory') {
    return commitRuntimeTxEntityChange(env, rewindJHistoryRuntimeTx(env, runtimeTx));
  }
  if (runtimeTx.type === 'retryJSubmit') {
    return applyRetryJSubmitRuntimeTx(env, runtimeTx);
  }
  if (runtimeTx.type === 'recordJSubmitResult') {
    applyRecordJSubmitResultRuntimeTx(env, runtimeTx);
    return [];
  }
  if (runtimeTx.type === 'retryEntityProviderAction') {
    return applyRetryEntityProviderActionRuntimeTx(env, runtimeTx);
  }
  if (runtimeTx.type === 'recordEntityProviderActionSubmitResult') {
    applyRecordEntityProviderActionResultRuntimeTx(env, runtimeTx);
    return [];
  }
  const exhaustive: never = runtimeTx;
  throw new Error(`RUNTIME_TX_UNKNOWN: ${(exhaustive as { type?: string }).type ?? 'unknown'}`);
};

const rewindJHistoryRuntimeTx = (
  env: RuntimeReplica,
  runtimeTx: Extract<RuntimeTx, { type: 'rewindJHistory' }>,
): string => {
  const entityId = String(runtimeTx.data.entityId || '').trim().toLowerCase();
  const signerId = String(runtimeTx.data.signerId || '').trim().toLowerCase();
  const match = findExistingReplicaCaseInsensitive(env, entityId, signerId);
  if (!match) throw new Error(`J_HISTORY_LOCAL_REPLICA_MISSING:${entityId}:${signerId}`);
  const jurisdictionRef = String(runtimeTx.data.jurisdictionRef || '').trim().toLowerCase();
  if (String(match.replica.jHistory?.jurisdictionRef || '').trim().toLowerCase() !== jurisdictionRef) {
    throw new Error(`J_HISTORY_REWIND_JURISDICTION_MISMATCH:${entityId}:${signerId}`);
  }
  const certifiedAnchor = getEntityCertifiedJAnchor(match.replica.state);
  if (certifiedAnchor && runtimeTx.data.conflictingHeight <= certifiedAnchor.height) {
    throw new Error(`J_HISTORY_FINALIZED_REORG:${runtimeTx.data.conflictingHeight}`);
  }
  const signedRange = match.replica.lockedFrame?.txs.find((tx) =>
    tx.type === 'j_event' &&
    runtimeTx.data.conflictingHeight > Number(tx.data.baseHeight) &&
    runtimeTx.data.conflictingHeight <= Number(tx.data.scannedThroughHeight));
  if (signedRange && match.replica.lockedFrame) {
    // A precommit cannot be revoked. Rewinding the watcher and later signing a
    // different J prefix at the same Entity height would make this validator
    // equivocate across settlement-chain forks. Preserve the lock and local
    // evidence for forensics; an operator must resolve the chain-finality fault.
    throw new Error(
      `J_HISTORY_SIGNED_LOCK_REORG:entity=${entityId}:signer=${signerId}` +
      `:frameHeight=${match.replica.lockedFrame.height}:frameHash=${match.replica.lockedFrame.hash}` +
      `:jHeight=${runtimeTx.data.conflictingHeight}`,
    );
  }
  const rewound = rewindValidatorJHistory(match.replica.state, match.replica.jHistory);
  if (rewound) match.replica.jHistory = rewound;
  else delete match.replica.jHistory;
  return entityId;
};

const observeJRangeRuntimeTx = (
  env: RuntimeReplica,
  runtimeTx: Extract<RuntimeTx, { type: 'observeJRange' }>,
): string | undefined => {
  const entityId = String(runtimeTx.data.entityId || '').trim().toLowerCase();
  const signerId = String(runtimeTx.data.signerId || '').trim().toLowerCase();
  const match = findExistingReplicaCaseInsensitive(env, entityId, signerId);
  if (!match) throw new Error(`J_HISTORY_LOCAL_REPLICA_MISSING:${entityId}:${signerId}`);
  const expectedJurisdictionRef = getJEventJurisdictionRef(match.replica.state.config.jurisdiction);
  const observedJurisdictionRef = String(runtimeTx.data.jurisdictionRef || '').trim().toLowerCase();
  if (observedJurisdictionRef !== expectedJurisdictionRef) {
    throw new Error(
      `J_HISTORY_OBSERVATION_JURISDICTION_MISMATCH:${entityId}:${signerId}` +
      `:expected=${expectedJurisdictionRef}:observed=${observedJurisdictionRef || 'missing'}`,
    );
  }
  const observation = {
    jurisdictionRef: runtimeTx.data.jurisdictionRef,
    scannedThroughHeight: runtimeTx.data.scannedThroughHeight,
    tipBlockHash: runtimeTx.data.tipBlockHash,
    ...(runtimeTx.data.headers ? { headers: runtimeTx.data.headers } : {}),
    blocks: runtimeTx.data.blocks,
  };
  const certifiedAnchor = getEntityCertifiedJAnchor(match.replica.state);
  if (certifiedAnchor && observation.scannedThroughHeight < certifiedAnchor.height) {
    // A watcher page can be queued against an older live RuntimeReplica while another
    // Runtime frame advances this Entity's certified J head. Validate the
    // discarded page independently, then prove the retained local cache has
    // not corrupted the newer certified anchor. Never let staleness hide bad
    // bytes, and never rewind Entity-certified authority to accept old input.
    recordValidatorJHistory(undefined, observation);
    assertValidatorJHistoryMatchesCertifiedAnchor(match.replica.state, match.replica.jHistory);
    runtimeTxLog.info('jurisdiction.observation_superseded', {
      entity: entityId,
      signer: signerId,
      observedThrough: observation.scannedThroughHeight,
      certifiedThrough: certifiedAnchor.height,
    });
    return;
  }
  match.replica.jHistory = recordValidatorJHistory(
    match.replica.jHistory,
    observation,
    match.replica.state,
  );
  return entityId;
};

const resolveImportCheckpointState = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  config: EntityState['config'],
): EntityState => {
  // Live Runtime memory keeps only the latest certified Entity endpoint. The
  // complete certificate history is an inspection/replay concern stored in the
  // Runtime WAL; requiring it here would turn every late validator import into an
  // accidental in-memory archive dependency. Bind the import to the exact
  // already-certified local endpoint that the next Runtime checkpoint uses.
  const selected = buildRuntimeCheckpointLineagePlan(env).lookup.get(entityId);
  if (!selected) throw new Error(`IMPORT_REPLICA_CERTIFIED_CHECKPOINT_MISSING:${entityId}`);
  if (!selected.state.config.validators.some(validator => (
    String(validator).toLowerCase() === signerId
  ))) {
    throw new Error(`IMPORT_REPLICA_SIGNER_NOT_IN_CERTIFIED_BOARD:entity=${entityId}:signer=${signerId}`);
  }
  const suppliedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority({
    ...selected.state,
    config,
  }));
  const certifiedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(selected.state));
  if (suppliedAuthorityRoot !== certifiedAuthorityRoot) {
    throw new Error(
      `IMPORT_REPLICA_CONFIG_CHECKPOINT_MISMATCH:entity=${entityId}:` +
      `certified=${certifiedAuthorityRoot}:supplied=${suppliedAuthorityRoot}`,
    );
  }
  return selected.state;
};

type ReplicaImportIdentity = {
  entityId: string;
  signerId: string;
  replicaKey: string;
};

const normalizeReplicaImportIdentity = (
  runtimeTx: ImportReplicaRuntimeTx,
): ReplicaImportIdentity => {
  const entityId = String(runtimeTx.entityId || '').toLowerCase();
  const signerId =
    normalizeRuntimeId(String(runtimeTx.signerId || '')) ||
    String(runtimeTx.signerId || '').trim().toLowerCase();
  if (!entityId || !signerId) {
    throw new Error(
      'IMPORT_REPLICA_INVALID_ID: entity=' + runtimeTx.entityId +
      ' signer=' + runtimeTx.signerId,
    );
  }
  return { entityId, signerId, replicaKey: entityId + ':' + signerId };
};

const entityHasCertifiedCheckpoint = (
  siblings: EntityReplica[],
): boolean =>
  siblings.some(replica =>
    replica.state.height > 0 ||
    Boolean(replica.certifiedFrameAnchor) ||
    Boolean(replica.certifiedFrameLineage?.length));

const applyReplicaLocalMetadata = (
  env: RuntimeReplica,
  replica: EntityReplica,
  identity: ReplicaImportIdentity,
  isProposer: boolean,
): void => {
  replica.isProposer = isProposer;
  replica.entityId = identity.entityId;
  replica.signerId = identity.signerId;
  canonicalizeLocalEntityCryptoKeys(
    env,
    identity.entityId,
    identity.signerId,
    replica,
  );
};

const reuseExistingReplica = (
  env: RuntimeReplica,
  runtimeTx: ImportReplicaRuntimeTx,
  identity: ReplicaImportIdentity,
  existingKey: string,
  replica: EntityReplica,
  config: EntityState['config'],
  hasCertifiedCheckpoint: boolean,
): string => {
  if (hasCertifiedCheckpoint) {
    resolveImportCheckpointState(env, identity.entityId, identity.signerId, config);
    // Re-import changes validator-local routing metadata only. Mutating the
    // certified Entity state here would change its root without a quorum frame.
    applyReplicaLocalMetadata(env, replica, identity, runtimeTx.data.isProposer);
  } else {
    backfillEntityJurisdictionBinding(env, identity.entityId, config.jurisdiction!);
    applyReplicaLocalMetadata(env, replica, identity, runtimeTx.data.isProposer);
    replica.state.entityId = identity.entityId;
    replica.state.config = config;
    if (
      replica.state.lastFinalizedJHeight === 0 &&
      replica.state.jBlockChain.length === 0 &&
      !replica.state.jHistoryFinality
    ) {
      replica.state.lastFinalizedJHeight =
        getJHistoryRegistrationBaseHeight(config.jurisdiction);
    }
    normalizeEntitySwapTradingPairs(replica.state);
    if (DEBUG) {
      runtimeTxLog.debug('replica.restored_reused', {
        entity: identity.entityId,
        signer: identity.signerId,
      });
    }
  }
  if (existingKey !== identity.replicaKey) env.state.eReplicas.delete(existingKey);
  env.state.eReplicas.set(identity.replicaKey, replica);
  return identity.entityId;
};

const buildCheckpointReplica = (
  env: RuntimeReplica,
  runtimeTx: ImportReplicaRuntimeTx,
  identity: ReplicaImportIdentity,
  config: EntityState['config'],
  replicaKeys: ReturnType<typeof resolveReplicaEntityCryptoKeys>,
): EntityReplica => {
  const state = cloneEntityState(
    resolveImportCheckpointState(env, identity.entityId, identity.signerId, config),
    true,
  );
  return {
    entityId: identity.entityId,
    signerId: identity.signerId,
    entityEncPubKey: replicaKeys.publicKey,
    mempool: [],
    isProposer: runtimeTx.data.isProposer,
    state,
    ...(runtimeTx.data.position
      ? {
          position: {
            ...runtimeTx.data.position,
            ...((runtimeTx.data.position.jurisdiction || config.jurisdiction?.name)
              ? { jurisdiction: runtimeTx.data.position.jurisdiction || config.jurisdiction!.name }
              : {}),
          },
        }
      : {}),
  };
};

const buildGenesisReplica = (
  env: RuntimeReplica,
  runtimeTx: ImportReplicaRuntimeTx,
  identity: ReplicaImportIdentity,
  config: EntityState['config'],
  replicaKeys: ReturnType<typeof resolveReplicaEntityCryptoKeys>,
): EntityReplica => {
  const replica: EntityReplica = {
    entityId: identity.entityId,
    signerId: identity.signerId,
    entityEncPubKey: replicaKeys.publicKey,
    mempool: [],
    isProposer: runtimeTx.data.isProposer,
    state: {
      entityId: identity.entityId,
      height: 0,
      timestamp: env.state.timestamp,
      nonces: new Map(),
      proposals: new Map(),
      config,
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: getJHistoryRegistrationBaseHeight(config.jurisdiction),
      jBlockChain: [],
      profile: {
        name:
          typeof runtimeTx.data.profileName === 'string' &&
          runtimeTx.data.profileName.trim().length > 0
            ? runtimeTx.data.profileName.trim()
            : 'Entity ' + identity.entityId.slice(-4),
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      lockBook: new Map(),
      crontabState: initCrontab(),
      swapTradingPairs: buildDefaultEntitySwapPairs(
        getTokenIdsForJurisdiction(config.jurisdiction),
      ),
      pendingCrossJurisdictionFillAcks: new Map(),
      crossJurisdictionBookAdmissions: new Map(),
    },
  };
  normalizeEntitySwapTradingPairs(replica.state);
  if (runtimeTx.data.position) {
    replica.position = {
      ...runtimeTx.data.position,
      jurisdiction:
        runtimeTx.data.position.jurisdiction ||
        runtimeTx.data.position.xlnomy ||
        env.activeJurisdiction ||
        'default',
    };
  }
  return replica;
};

const assertCreatedReplicaJHeight = (
  env: RuntimeReplica,
  replicaKey: string,
): void => {
  const actual = env.state.eReplicas.get(replicaKey)?.state.lastFinalizedJHeight;
  if (typeof actual !== 'number') {
    throw new Error(
      'ENTITY_CREATION_INVALID_J_HEIGHT: replica=' + replicaKey +
      ' expected=number actualType=' + typeof actual + ' actual=' + String(actual),
    );
  }
};

const importReplicaRuntimeTx = (env: RuntimeReplica, runtimeTx: ImportReplicaRuntimeTx): string => {
  const identity = normalizeReplicaImportIdentity(runtimeTx);
  if (DEBUG) {
    runtimeTxLog.debug('replica.import_start', {
      entity: identity.entityId,
      signer: identity.signerId,
      isProposer: runtimeTx.data.isProposer,
    });
  }
  const existing = findExistingReplicaCaseInsensitive(
    env,
    identity.entityId,
    identity.signerId,
  );
  const config = requireBoundEntityConfig(env, identity.entityId, runtimeTx.data.config);
  const siblings = Array.from(env.state.eReplicas.values()).filter(replica =>
    String(replica.entityId || replica.state.entityId).toLowerCase() === identity.entityId);
  const hasCheckpoint = entityHasCertifiedCheckpoint(siblings);
  if (existing) {
    return reuseExistingReplica(
      env,
      runtimeTx,
      identity,
      existing.key,
      existing.replica,
      config,
      hasCheckpoint,
    );
  }

  const replicaKeys = resolveReplicaEntityCryptoKeys(
    env,
    identity.entityId,
    identity.signerId,
  );
  if (siblings.length > 0) {
    const replica = buildCheckpointReplica(env, runtimeTx, identity, config, replicaKeys);
    env.state.eReplicas.set(identity.replicaKey, replica);
    runtimeTxLog.info('replica.imported_from_certified_checkpoint', {
      entity: identity.entityId,
      signer: identity.signerId,
      height: replica.state.height,
      head: replica.state.prevFrameHash ?? 'genesis',
    });
    return identity.entityId;
  }

  backfillEntityJurisdictionBinding(env, identity.entityId, config.jurisdiction!);
  env.state.eReplicas.set(
    identity.replicaKey,
    buildGenesisReplica(env, runtimeTx, identity, config, replicaKeys),
  );
  assertCreatedReplicaJHeight(env, identity.replicaKey);
  return identity.entityId;
};

const findExistingReplicaCaseInsensitive = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
): { key: string; replica: EntityReplica } | null => {
  const directKey = `${entityId}:${signerId}`;
  const directReplica = env.state.eReplicas.get(directKey);
  if (directReplica) return { key: directKey, replica: directReplica };

  for (const [key, candidate] of env.state.eReplicas.entries()) {
    const [candidateEntity, candidateSigner] = String(key).split(':');
    if (String(candidateEntity || '').toLowerCase() !== entityId) continue;
    if (String(candidateSigner || '').toLowerCase() !== signerId) continue;
    return { key: String(key), replica: candidate };
  }
  return null;
};
