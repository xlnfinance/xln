import { buildDefaultEntitySwapPairs, getTokenIdsForJurisdiction } from '../account/utils';
import { markStorageEntityDirty } from './env-events';
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
import type { EntityReplica, EntityState, Env, JInput, RuntimeTx } from '../types';
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
import {
  DEBUG,
  formatEntityDisplay,
  formatSignerDisplay,
} from '../utils';
import { createStructuredLogger } from '../infra/logger';
import { cloneEntityState } from '../state-helpers';
import { buildCertifiedEntityLineagePlan } from '../storage/entity-lineage';
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
import { applyWatcherJurisdictionCursor } from '../jadapter/helpers';
import {
  applyNumberedRegistrationIntent,
  applyNumberedRegistrationResolution,
} from '../entity/numbered-registration-intent';

const runtimeTxLog = createStructuredLogger('runtime.tx');

type ImportReplicaRuntimeTx = Extract<RuntimeTx, { type: 'importReplica' }>;

export interface RuntimeTxHandlerDeps {
  isReplay?: boolean;
}

export const applyRuntimeTx = async (
  env: Env,
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
    env.runtimeState ??= {};
    env.runtimeState.certifiedRegistrationEvidence ??= new Map();
    const existing = env.runtimeState.certifiedRegistrationEvidence.get(key);
    if (existing) {
      const existingClaimHash = computeRegistrationEvidenceClaimHash(existing);
      const incomingClaimHash = computeRegistrationEvidenceClaimHash(runtimeTx.data);
      if (existingClaimHash !== incomingClaimHash) {
        throw new Error(`J_AUTHORITY_EVIDENCE_CONFLICT:${key}:${existingClaimHash}:${incomingClaimHash}`);
      }
      return [];
    }
    env.runtimeState.certifiedRegistrationEvidence.set(
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
    importReplicaRuntimeTx(env, runtimeTx);
    return [];
  }
  if (runtimeTx.type === 'observeJRange') {
    observeJRangeRuntimeTx(env, runtimeTx);
    return [];
  }
  if (runtimeTx.type === 'advanceJWatcherCursor') {
    applyWatcherJurisdictionCursor(env, runtimeTx.data);
    return [];
  }
  if (runtimeTx.type === 'rewindJHistory') {
    rewindJHistoryRuntimeTx(env, runtimeTx);
    return [];
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
  env: Env,
  runtimeTx: Extract<RuntimeTx, { type: 'rewindJHistory' }>,
): void => {
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
  markStorageEntityDirty(env, entityId);
};

const observeJRangeRuntimeTx = (
  env: Env,
  runtimeTx: Extract<RuntimeTx, { type: 'observeJRange' }>,
): void => {
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
    // A watcher page can be queued against an older live Env while another
    // Runtime frame advances this Entity's certified J head. Validate the
    // discarded page independently, then prove the retained local cache has
    // not corrupted the newer certified anchor. Never let staleness hide bad
    // bytes, and never rewind Entity-certified authority to accept old input.
    recordValidatorJHistory(undefined, observation);
    assertValidatorJHistoryMatchesCertifiedAnchor(match.replica.state, match.replica.jHistory);
    runtimeTxLog.info('jurisdiction.observation_superseded', {
      entity: formatEntityDisplay(entityId),
      signer: formatSignerDisplay(signerId),
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
  markStorageEntityDirty(env, entityId);
};

const resolveImportCheckpointState = (
  env: Env,
  entityId: string,
  signerId: string,
  config: EntityState['config'],
): EntityState => {
  const selected = buildCertifiedEntityLineagePlan(env).lookup.get(entityId);
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

const importReplicaRuntimeTx = (env: Env, runtimeTx: ImportReplicaRuntimeTx): void => {
  const importedEntityId = String(runtimeTx.entityId || '').toLowerCase();
  const importedSignerId =
    normalizeRuntimeId(String(runtimeTx.signerId || '')) ||
    String(runtimeTx.signerId || '').trim().toLowerCase();
  if (!importedEntityId || !importedSignerId) {
    throw new Error(`IMPORT_REPLICA_INVALID_ID: entity=${runtimeTx.entityId} signer=${runtimeTx.signerId}`);
  }
  if (DEBUG) {
    runtimeTxLog.debug('replica.import_start', {
      entity: formatEntityDisplay(importedEntityId),
      signer: formatSignerDisplay(importedSignerId),
      isProposer: runtimeTx.data.isProposer,
    });
  }

  const replicaKey = `${importedEntityId}:${importedSignerId}`;
  const existingMatch = findExistingReplicaCaseInsensitive(env, importedEntityId, importedSignerId);
  const config = requireBoundEntityConfig(env, importedEntityId, runtimeTx.data.config);
  const liveSiblings = Array.from(env.eReplicas.values()).filter(candidate => (
    String(candidate.entityId || candidate.state.entityId).toLowerCase() === importedEntityId
  ));
  const hasCertifiedCheckpoint = liveSiblings.some(candidate => (
    candidate.state.height > 0 ||
    Boolean(candidate.certifiedFrameAnchor) ||
    Boolean(candidate.certifiedFrameLineage?.length)
  ));

  if (existingMatch) {
    const { key: existingReplicaKey, replica: existingReplica } = existingMatch;
    if (hasCertifiedCheckpoint) {
      resolveImportCheckpointState(env, importedEntityId, importedSignerId, config);
      // Re-import is local routing metadata, never an Entity state transition.
      // Re-normalizing swap pairs or replacing config here changes a certified
      // state root without a quorum frame and poisons the lineage on this very
      // RuntimeTx. Crypto keys are explicitly excluded validator-local state.
      existingReplica.isProposer = runtimeTx.data.isProposer;
      existingReplica.entityId = importedEntityId;
      existingReplica.signerId = importedSignerId;
      canonicalizeLocalEntityCryptoKeys(env, importedEntityId, importedSignerId, existingReplica.state);
      if (existingReplicaKey !== replicaKey) env.eReplicas.delete(existingReplicaKey);
      env.eReplicas.set(replicaKey, existingReplica);
      markStorageEntityDirty(env, importedEntityId);
      return;
    }

    backfillEntityJurisdictionBinding(env, importedEntityId, config.jurisdiction!);
    existingReplica.isProposer = runtimeTx.data.isProposer;
    existingReplica.entityId = importedEntityId;
    existingReplica.signerId = importedSignerId;
    existingReplica.state.entityId = importedEntityId;
    existingReplica.state.config = config;
    if (
      existingReplica.state.lastFinalizedJHeight === 0 &&
      existingReplica.state.jBlockChain.length === 0 &&
      !existingReplica.state.jHistoryFinality
    ) {
      existingReplica.state.lastFinalizedJHeight = getJHistoryRegistrationBaseHeight(config.jurisdiction);
    }
    canonicalizeLocalEntityCryptoKeys(env, importedEntityId, importedSignerId, existingReplica.state);
    normalizeEntitySwapTradingPairs(existingReplica.state);
    if (existingReplicaKey !== replicaKey) {
      env.eReplicas.delete(existingReplicaKey);
    }
    env.eReplicas.set(replicaKey, existingReplica);
    markStorageEntityDirty(env, existingReplica.state.entityId);
    if (DEBUG) {
      runtimeTxLog.debug('replica.restored_reused', {
        entity: formatEntityDisplay(importedEntityId),
        signer: formatSignerDisplay(importedSignerId),
      });
    }
    return;
  }

  const replicaKeys = resolveReplicaEntityCryptoKeys(env, importedEntityId, importedSignerId);
  if (liveSiblings.length > 0) {
    const checkpointState = cloneEntityState(
      resolveImportCheckpointState(env, importedEntityId, importedSignerId, config),
      true,
    );
    checkpointState.entityEncPubKey = replicaKeys.publicKey;
    checkpointState.entityEncPrivKey = replicaKeys.privateKey;
    checkpointState.htlcNotes = new Map();
    const checkpointReplica: EntityReplica = {
      entityId: importedEntityId,
      signerId: importedSignerId,
      mempool: [],
      isProposer: runtimeTx.data.isProposer,
      state: checkpointState,
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
    env.eReplicas.set(replicaKey, checkpointReplica);
    markStorageEntityDirty(env, importedEntityId);
    runtimeTxLog.info('replica.imported_from_certified_checkpoint', {
      entity: formatEntityDisplay(importedEntityId),
      signer: formatSignerDisplay(importedSignerId),
      height: checkpointState.height,
      head: checkpointState.prevFrameHash ?? 'genesis',
    });
    return;
  }
  backfillEntityJurisdictionBinding(env, importedEntityId, config.jurisdiction!);
  const replica: EntityReplica = {
    entityId: importedEntityId,
    signerId: importedSignerId,
    mempool: [],
    isProposer: runtimeTx.data.isProposer,
    state: {
      entityId: importedEntityId,
      height: 0,
      timestamp: env.timestamp,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config,
      reserves: new Map(),
      accounts: new Map(),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: getJHistoryRegistrationBaseHeight(config.jurisdiction),
      jBlockChain: [],
      entityEncPubKey: replicaKeys.publicKey,
      entityEncPrivKey: replicaKeys.privateKey,
      profile: {
        name:
          typeof runtimeTx.data.profileName === 'string' && runtimeTx.data.profileName.trim().length > 0
            ? runtimeTx.data.profileName.trim()
            : `Entity ${importedEntityId.slice(-4)}`,
        isHub: false,
        avatar: '',
        bio: '',
        website: '',
      },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      htlcNotes: new Map(),
      lockBook: new Map(),
      crontabState: initCrontab(),
      swapTradingPairs: buildDefaultEntitySwapPairs(getTokenIdsForJurisdiction(config.jurisdiction)),
      pendingSwapFillRatios: new Map(),
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

  env.eReplicas.set(replicaKey, replica);
  markStorageEntityDirty(env, replica.state.entityId);

  const createdReplica = env.eReplicas.get(replicaKey);
  const actualJBlock = createdReplica?.state.lastFinalizedJHeight;
  if (typeof actualJBlock !== 'number') {
    throw new Error(
      `ENTITY_CREATION_INVALID_J_HEIGHT: replica=${replicaKey} ` +
        `expected=number actualType=${typeof actualJBlock} actual=${String(actualJBlock)}`,
    );
  }
};

const findExistingReplicaCaseInsensitive = (
  env: Env,
  entityId: string,
  signerId: string,
): { key: string; replica: EntityReplica } | null => {
  const directKey = `${entityId}:${signerId}`;
  const directReplica = env.eReplicas.get(directKey);
  if (directReplica) return { key: directKey, replica: directReplica };

  for (const [key, candidate] of env.eReplicas.entries()) {
    const [candidateEntity, candidateSigner] = String(key).split(':');
    if (String(candidateEntity || '').toLowerCase() !== entityId) continue;
    if (String(candidateSigner || '').toLowerCase() !== signerId) continue;
    return { key: String(key), replica: candidate };
  }
  return null;
};
