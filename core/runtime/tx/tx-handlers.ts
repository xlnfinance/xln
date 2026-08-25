import { engineAccountValueHash } from '../../rscore/cutover/leaf-cache';
import { buildDefaultEntitySwapPairs, getTokenIdsForJurisdiction } from '../../account/utils';
import { applyRuntimeStorageChanges } from '../observability/env-events';
import { normalizeEntitySwapTradingPairs } from '../swap-cmd/swap-pairs';
import { initCrontab } from '../../entity/scheduler';
import {
  buildEntityFrameAuthority,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../entity/state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../../entity/state/persistent-collection-map';
import {
  backfillEntityJurisdictionBinding,
  requireBoundEntityConfig,
} from '../../jurisdiction/machine/jurisdiction-runtime';
import { getJHistoryRegistrationBaseHeight } from '../../jurisdiction/machine/history-consensus';
import {
  assertValidatorJHistoryMatchesCertifiedAnchor,
  getEntityCertifiedJAnchor,
  recordValidatorJHistory,
  rewindValidatorJHistory,
} from '../../jurisdiction/machine/local-history';
import { getJEventJurisdictionRef } from '../../jurisdiction/machine/event-observation';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import type { EntityReplica, EntityState } from '../../entity/types';
import type { RuntimeReplica, RuntimeTx } from '../types';
import type { JInput } from '../../jurisdiction/machine/input';
import { applyRuntimeAdapterCommandMarker } from '../command/frontier';
import {
  applyRetryJSubmitRuntimeTx,
} from '../j-submit/j-submit-state';
import { applyRecordJSubmitResultRuntimeTx } from '../j-submit/j-submit-result';
import {
  applyRetryEntityProviderActionRuntimeTx,
} from '../registration/entity-provider-action-submit-state';
import { applyRecordEntityProviderActionResultRuntimeTx } from '../registration/entity-provider-action-submit-result';
import { applyGovernanceSubmitResultRuntimeTx } from '../registration/governance-submit-state';
import { DEBUG } from '../../support/debug-flags';
import { createStructuredLogger } from '../../support/logger';
import { encodeBoard, hashBoard } from '../../entity/factory';
import { isNumberedEntity, toEntityId } from '../../protocol/identity';
import { getCertifiedBoardStackKey } from '../../jurisdiction/machine/board-registry';
import { buildRuntimeCheckpointLineagePlan } from '../../storage/replica/entity-lineage';
import {
  assertCertifiedRegistrationEvidence,
  computeRegistrationEvidenceClaimHash,
  freezeCertifiedRegistrationEvidence,
  registrationEvidenceKey,
} from '../../jurisdiction/machine/registration-evidence';
import {
  applyCompleteImportJurisdiction,
  applyImportJurisdictionIntent,
} from '../j-submit/jurisdiction-import';
import { applyWatcherJurisdictionCursor } from '../../jurisdiction/adapter/watcher/observe/watcher-cursor';
import {
  applyNumberedRegistrationIntent,
  applyNumberedRegistrationResolution,
} from '../registration/numbered-registration-intent';
import { assertRuntimeTxCapabilitiesAuthorized } from './internal-tx-auth';
import { getBytes } from 'ethers';
import {
  deriveEntityEncryptionPublicKey,
  provisionEntityEncryptionKey,
} from '../../entity/auth/crypto';
import { deriveEntityEncryptionPrivateKey } from '../registration/entity-creation/crypto';

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
  assertRuntimeTxCapabilitiesAuthorized(runtimeTx, deps.isReplay === true);
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
      freezeCertifiedRegistrationEvidence({
        ...runtimeTx.data,
        topics: [...runtimeTx.data.topics],
        receiptProofNodes: [...runtimeTx.data.receiptProofNodes],
      }),
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
  if (runtimeTx.type === 'recordGovernanceJSubmitResult') {
    applyGovernanceSubmitResultRuntimeTx(env, runtimeTx);
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
    Boolean(replica.certifiedFrameHead));

const deriveImportedEntityEncryptionKeys = (
  runtimeTx: ImportReplicaRuntimeTx,
  entityId: string,
): Readonly<{ privateKey: string; publicKey: string }> => {
  const seed = runtimeTx.data.entitySeed;
  if (!/^0x[0-9a-f]{128}$/.test(seed)) throw new Error('IMPORT_REPLICA_ENTITY_SEED_INVALID');
  const privateKey = deriveEntityEncryptionPrivateKey(getBytes(seed), entityId);
  return { privateKey, publicKey: deriveEntityEncryptionPublicKey(privateKey, entityId) };
};

const applyReplicaLocalMetadata = (
  replica: EntityReplica,
  identity: ReplicaImportIdentity,
  isProposer: boolean,
): void => {
  replica.isProposer = isProposer;
  replica.entityId = identity.entityId;
  replica.signerId = identity.signerId;
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
  const entityEncryptionPublicKey = deriveImportedEntityEncryptionKeys(runtimeTx, identity.entityId).publicKey;
  if (replica.state.entityEncryptionPublicKey !== entityEncryptionPublicKey) {
    throw new Error(`IMPORT_REPLICA_ENTITY_ENCRYPTION_PUBLIC_KEY_MISMATCH:${identity.entityId}`);
  }
  if (hasCertifiedCheckpoint) {
    resolveImportCheckpointState(env, identity.entityId, identity.signerId, config);
    // Re-import changes validator-local routing metadata only. Mutating the
    // certified Entity state here would change its root without a quorum frame.
    applyReplicaLocalMetadata(replica, identity, runtimeTx.data.isProposer);
  } else {
    backfillEntityJurisdictionBinding(env, identity.entityId, config.jurisdiction!);
    applyReplicaLocalMetadata(replica, identity, runtimeTx.data.isProposer);
    replica.state.entityId = identity.entityId;
    replica.state.config = config;
    if (
      replica.state.lastFinalizedJHeight === 0 &&
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
): EntityReplica => {
  // Certified EntityState is immutable and shared by sibling validator
  // replicas. Each validator's future proposal uses its own path-copy overlay;
  // duplicating the complete accounts/orderbook tree here is both unnecessary
  // and O(total Entity state).
  const state = resolveImportCheckpointState(env, identity.entityId, identity.signerId, config);
  if (state.entityEncryptionPublicKey !== deriveImportedEntityEncryptionKeys(runtimeTx, identity.entityId).publicKey) {
    throw new Error(`IMPORT_REPLICA_ENTITY_ENCRYPTION_PUBLIC_KEY_MISMATCH:${identity.entityId}`);
  }
  return {
    entityId: identity.entityId,
    signerId: identity.signerId,
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
): EntityReplica => {
  const replica: EntityReplica = {
    entityId: identity.entityId,
    signerId: identity.signerId,
    mempool: [],
    isProposer: runtimeTx.data.isProposer,
    state: {
      entityId: identity.entityId,
      height: 0,
      timestamp: env.state.timestamp,
      nonces: new Map(),
      proposals: new Map(),
      config,
      entityEncryptionPublicKey: deriveImportedEntityEncryptionKeys(runtimeTx, identity.entityId).publicKey,
      reserves: new Map(),
      accounts: PersistentEntityAccountMap.empty(identity.entityId, engineAccountValueHash(identity.entityId)),
      deferredAccountProposals: new Map(),
      lastFinalizedJHeight: getJHistoryRegistrationBaseHeight(config.jurisdiction),
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
      htlcRoutes: PersistentEntityCollectionMap.empty(),
      htlcFeesEarned: 0n,
      lockBook: PersistentEntityCollectionMap.empty(),
      crontabState: initCrontab(),
      swapTradingPairs: buildDefaultEntitySwapPairs(
        getTokenIdsForJurisdiction(config.jurisdiction),
      ),
      pendingCrossJurisdictionFillAcks: PersistentEntityCollectionMap.empty(),
      crossJurisdictionBookAdmissions: PersistentEntityCollectionMap.empty(),
    },
  };
  normalizeEntitySwapTradingPairs(replica.state);
  if (runtimeTx.data.position) {
    replica.position = {
      ...runtimeTx.data.position,
      jurisdiction:
        runtimeTx.data.position.jurisdiction ||
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

const assertNumberedReplicaImportAuthority = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  config: EntityState['config'],
  isProposer: boolean,
): void => {
  const boardIndex = config.validators.findIndex(
    validator => validator.toLowerCase() === signerId,
  );
  if (boardIndex < 0) throw new Error(`IMPORT_REPLICA_SIGNER_NOT_ON_BOARD:${signerId}`);
  if (isProposer !== (boardIndex === 0)) {
    throw new Error(`IMPORT_REPLICA_PROPOSER_FLAG_INVALID:${entityId}:${signerId}`);
  }
  if (!isNumberedEntity(toEntityId(entityId))) {
    const boardEntityId = hashBoard(encodeBoard(config, env)).toLowerCase();
    if (entityId !== boardEntityId) {
      throw new Error(`IMPORT_REPLICA_LAZY_BOARD_ID_MISMATCH:${entityId}:${boardEntityId}`);
    }
    return;
  }
  const jurisdiction = config.jurisdiction;
  if (!jurisdiction) throw new Error(`NUMBERED_REPLICA_JURISDICTION_MISSING:${entityId}`);
  const evidence = env.infrastructure?.certifiedRegistrationEvidence?.get(
    registrationEvidenceKey(getCertifiedBoardStackKey(jurisdiction), entityId),
  );
  if (!evidence) throw new Error(`NUMBERED_REPLICA_REGISTRATION_EVIDENCE_MISSING:${entityId}`);
  const boardHash = hashBoard(encodeBoard(config, env)).toLowerCase();
  if (evidence.boardHash.toLowerCase() !== boardHash) {
    throw new Error(`NUMBERED_REPLICA_REGISTRATION_BOARD_MISMATCH:${entityId}`);
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
  assertNumberedReplicaImportAuthority(
    env,
    identity.entityId,
    identity.signerId,
    config,
    runtimeTx.data.isProposer,
  );
  const siblings = Array.from(env.state.eReplicas.values()).filter(replica =>
    String(replica.entityId || replica.state.entityId).toLowerCase() === identity.entityId);
  const encryptionKeys = deriveImportedEntityEncryptionKeys(runtimeTx, identity.entityId);
  const importedSeed = runtimeTx.data.entitySeed;
  for (const sibling of siblings) {
    if (sibling.state.entityEncryptionPublicKey !== encryptionKeys.publicKey) {
      throw new Error(`IMPORT_REPLICA_ENTITY_ENCRYPTION_PUBLIC_KEY_MISMATCH:${identity.entityId}`);
    }
  }
  const hasCheckpoint = entityHasCertifiedCheckpoint(siblings);
  const cachedPrivateKey = env.infrastructure?.entityEncryptionPrivateKeys?.get(identity.entityId);
  if (cachedPrivateKey && cachedPrivateKey !== encryptionKeys.privateKey) {
    throw new Error(`ENTITY_ENCRYPTION_KEY_CONFLICT:entity=${identity.entityId}`);
  }
  const retainedSeed = env.infrastructure?.entityEncryptionSeeds?.get(identity.entityId);
  if (retainedSeed && retainedSeed !== importedSeed) {
    throw new Error(`ENTITY_ENCRYPTION_SEED_CONFLICT:entity=${identity.entityId}`);
  }
  const finishImport = (entityId: string): string => {
    provisionEntityEncryptionKey(env, identity.entityId, encryptionKeys.privateKey);
    env.infrastructure ??= {};
    env.infrastructure.entityEncryptionSeeds ??= new Map();
    env.infrastructure.entityEncryptionSeeds.set(identity.entityId, importedSeed);
    return entityId;
  };
  if (existing) {
    return finishImport(reuseExistingReplica(
      env,
      runtimeTx,
      identity,
      existing.key,
      existing.replica,
      config,
      hasCheckpoint,
    ));
  }

  if (siblings.length > 0) {
    const replica = buildCheckpointReplica(env, runtimeTx, identity, config);
    env.state.eReplicas.set(identity.replicaKey, replica);
    runtimeTxLog.info('replica.imported_from_certified_checkpoint', {
      entity: identity.entityId,
      signer: identity.signerId,
      height: replica.state.height,
      head: replica.state.prevFrameHash ?? 'genesis',
    });
    return finishImport(identity.entityId);
  }

  backfillEntityJurisdictionBinding(env, identity.entityId, config.jurisdiction!);
  env.state.eReplicas.set(
    identity.replicaKey,
    buildGenesisReplica(env, runtimeTx, identity, config),
  );
  assertCreatedReplicaJHeight(env, identity.replicaKey);
  return finishImport(identity.entityId);
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
