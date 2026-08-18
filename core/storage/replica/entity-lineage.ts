import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { ethers } from 'ethers';

import { verifyAccountSignature } from '../../account/crypto';
import { LIMITS, UINT16_MAX } from '../../config/constants';
import {
  expectedCommittedLeaderState,
  verifyEntityLeaderCertificate,
  verifyEntityRelayCertificate,
} from '../../entity/consensus';
import { createEntityFrameHashFromStateRoot } from '../../entity/consensus/frame';
import { entityFrameBodyIsVerified } from '../../entity/consensus/frame/body-verified';
import { certifiedEntityFrameLinkFingerprint } from '../../entity/consensus/frame/lineage';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { encodeBoard, hashBoard } from '../../entity/factory';
import { getCertifiedBoardStackKey } from '../../jurisdiction/machine/board-registry';
import {
  assertRegistrationEvidenceEnvelope,
  computeRegistrationEvidenceHash,
  registrationEvidenceKey,
} from '../../jurisdiction/machine/registration-evidence';
import { compareStableText } from '../../protocol/serialization';
import type { CertifiedEntityFrameLink, CertifiedEntityLineageAnchor, ConsensusConfig, EntityFrameAuthority, EntityReplica, EntityFrame } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { validateConsensusConfig } from '../../entity/consensus/config-validation';
import { validateProposedEntityFrame } from '../../entity/consensus/frame/validation';
import { readRuntimeEnv } from '../../support/process/runtime-process';
import {
  getBoardHandoverFrameConfig,
  getBoardHandoverLeaderState,
} from '../../entity/consensus/authority/board-handover';
import { normalizeEntityId } from '../keys';
import type { StorageReplicaLookup } from '../types';

export type CertifiedEntityLineagePlan = {
  lookup: StorageReplicaLookup;
  lineageByReplicaKey: Map<string, CertifiedEntityFrameLink[]>;
  anchorByReplicaKey: Map<string, CertifiedEntityLineageAnchor>;
};

type ReplicaEntry = {
  replicaKey: string;
  replica: EntityReplica;
};

const replicaHead = (replica: EntityReplica): string => {
  if (replica.state.height === 0) return 'genesis';
  const head = String(replica.state.prevFrameHash || '');
  if (!head) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_HEAD_MISSING:entity=${replica.entityId}:signer=${replica.signerId}:` +
        `height=${replica.state.height}`,
    );
  }
  return head;
};

const assertValidHeight = (entry: ReplicaEntry): void => {
  const height = Number(entry.replica.state.height);
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error(
      `STORAGE_ENTITY_REPLICA_HEIGHT_INVALID:entity=${entry.replica.entityId}:` +
        `signer=${entry.replica.signerId}:height=${String(entry.replica.state.height)}`,
    );
  }
};

const assertSameHeightState = (entityId: string, expected: ReplicaEntry, actual: ReplicaEntry): void => {
  const expectedHash = computeCanonicalEntityConsensusStateHash(expected.replica.state);
  const actualHash = computeCanonicalEntityConsensusStateHash(actual.replica.state);
  if (expectedHash === actualHash) return;
  throw new Error(
    `STORAGE_ENTITY_REPLICA_STATE_DIVERGENCE:entity=${entityId}:height=${actual.replica.state.height}:` +
      `expectedSigner=${expected.replica.signerId}:actualSigner=${actual.replica.signerId}:` +
      `expected=${expectedHash}:actual=${actualHash}`,
  );
};

const normalizeConfigSigners = (
  config: ConsensusConfig,
): {
  validators: Set<string>;
  shares: Map<string, bigint>;
  totalPower: bigint;
} => {
  if (config.mode !== 'proposer-based' && config.mode !== 'gossip-based') {
    throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_MODE_INVALID:${String(config.mode)}`);
  }
  if (config.validators.length === 0 || config.validators.length > LIMITS.MAX_VALIDATORS) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_SIZE_INVALID:${config.validators.length}`);
  }
  const validators = new Set<string>();
  for (const rawValidator of config.validators) {
    const validator = normalizeEntityId(rawValidator);
    if (!validator || validators.has(validator)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_VALIDATOR_INVALID:${rawValidator}`);
    }
    validators.add(validator);
  }
  const shares = new Map<string, bigint>();
  for (const [rawSignerId, share] of Object.entries(config.shares)) {
    const signerId = normalizeEntityId(rawSignerId);
    if (!signerId || shares.has(signerId) || typeof share !== 'bigint' || share <= 0n || share > BigInt(UINT16_MAX)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_SHARE_INVALID:${rawSignerId}:${String(share)}`);
    }
    shares.set(signerId, share);
  }
  for (const validator of validators) {
    if (!shares.has(validator)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_SHARE_MISSING:${validator}`);
    }
  }
  for (const signerId of shares.keys()) {
    if (!validators.has(signerId)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_SHARE_UNKNOWN:${signerId}`);
    }
  }
  if (typeof config.threshold !== 'bigint' || config.threshold <= 0n) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_THRESHOLD_INVALID:${String(config.threshold)}`);
  }
  const totalPower = Array.from(shares.values()).reduce((sum, share) => sum + share, 0n);
  if (config.threshold > totalPower || config.threshold > BigInt(UINT16_MAX)) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_BOARD_THRESHOLD_EXCEEDS_POWER:${config.threshold}:${totalPower}`);
  }
  return { validators, shares, totalPower };
};

const assertAuthorityShape = (authority: EntityFrameAuthority, height: number, context: string): void => {
  const { validators } = normalizeConfigSigners(authority.config);
  const leader = authority.leaderState;
  const activeValidatorId = normalizeEntityId(leader.activeValidatorId);
  if (!validators.has(activeValidatorId)) {
    throw new Error(`${context}_LEADER_NOT_IN_BOARD:${activeValidatorId}`);
  }
  if (
    !Number.isSafeInteger(leader.view) ||
    leader.view < 0 ||
    !Number.isSafeInteger(leader.changedAtHeight) ||
    leader.changedAtHeight < 0 ||
    leader.changedAtHeight > height
  ) {
    throw new Error(
      `${context}_LEADER_COUNTER_INVALID:view=${leader.view}:changedAt=${leader.changedAtHeight}:height=${height}`,
    );
  }
};

const assertLeaderTransition = (
  env: RuntimeReplica,
  entityId: string,
  link: CertifiedEntityFrameLink,
  preAuthority: EntityFrameAuthority,
): ConsensusConfig => {
  const { frame, postAuthority } = link;
  assertAuthorityShape(preAuthority, frame.height - 1, 'STORAGE_ENTITY_LINEAGE_PRE_AUTHORITY');
  assertAuthorityShape(postAuthority, frame.height, 'STORAGE_ENTITY_LINEAGE_POST_AUTHORITY');
  const preState = {
    entityId,
    height: frame.height - 1,
    ...(frame.height > 1 ? { prevFrameHash: frame.parentFrameHash } : {}),
    config: preAuthority.config,
    leaderState: preAuthority.leaderState,
  };
  const handoverConfig = getBoardHandoverFrameConfig(env, preState, frame.txs);
  if (handoverConfig) {
    const handoverLeader = handoverConfig.validators[0];
    if (encodeCanonicalConsensusValue(postAuthority.config) !== encodeCanonicalConsensusValue(handoverConfig)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_HANDOVER_CONFIG_MISMATCH:${frame.height}`);
    }
    const expectedLeader = getBoardHandoverLeaderState(env, preState, frame.txs);
    if (
      !expectedLeader ||
      encodeCanonicalConsensusValue(postAuthority.leaderState) !== encodeCanonicalConsensusValue(expectedLeader)
    ) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_HANDOVER_LEADER_MISMATCH:${frame.height}`);
    }
    if (
      !handoverLeader ||
      normalizeEntityId(frame.leader.proposerSignerId) !== normalizeEntityId(handoverLeader) ||
      frame.leader.view !== 0 ||
      frame.leader.certificate ||
      frame.leader.relayCertificate
    ) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_HANDOVER_FRAME_LEADER_INVALID:${frame.height}`);
    }
    return handoverConfig;
  }
  if (!verifyEntityLeaderCertificate(env, preState, frame)) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_LEADER_CERT_INVALID:${frame.height}`);
  }
  if (!verifyEntityRelayCertificate(env, preState, frame)) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_RELAY_CERT_INVALID:${frame.height}`);
  }
  const expectedPostLeader = expectedCommittedLeaderState(preState, frame);
  if (encodeCanonicalConsensusValue(postAuthority.leaderState) !== encodeCanonicalConsensusValue(expectedPostLeader)) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_POST_LEADER_MISMATCH:${frame.height}`);
  }
  return preAuthority.config;
};

const replicaStateCommitments = (state: EntityReplica['state']) => ({
  stateRoot: computeCanonicalEntityConsensusStateHash(state),
  authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(state)),
});

const assertFrameBody = (entityId: string, link: CertifiedEntityFrameLink): EntityFrame => {
  const frame = validateProposedEntityFrame(link.frame, 'StorageCertifiedEntityFrame');
  const postAuthorityRoot = computeEntityFrameAuthorityRoot(link.postAuthority);
  if (postAuthorityRoot !== frame.authorityRoot) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_AUTHORITY_ROOT_MISMATCH:height=${frame.height}:` +
        `expected=${postAuthorityRoot}:received=${frame.authorityRoot}`,
    );
  }
  const skipBodyRehash =
    entityFrameBodyIsVerified(frame) && readRuntimeEnv('XLN_ENTITY_STATE_ROOT_AUDIT') !== '1';
  if (!skipBodyRehash) {
    const bodyHash = createEntityFrameHashFromStateRoot(
      frame.parentFrameHash,
      frame.height,
      frame.timestamp,
      frame.txs,
      frame.events,
      entityId,
      frame.stateRoot,
      frame.authorityRoot,
      frame.entityContext,
      frame.jPrefixCertificate,
    );
    if (bodyHash !== frame.hash) {
      throw new Error(
        `STORAGE_ENTITY_LINEAGE_FRAME_HASH_MISMATCH:height=${frame.height}:` +
          `expected=${bodyHash}:received=${frame.hash}`,
      );
    }
  }
  const frameManifest = frame.hashesToSign?.[0];
  if (!frameManifest || frameManifest.type !== 'entityFrame' || frameManifest.hash !== frame.hash) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_FRAME_MANIFEST_INVALID:${frame.height}:${frame.hash}`);
  }
  return frame;
};

const assertCertificateVariant = (
  env: RuntimeReplica,
  entityId: string,
  link: CertifiedEntityFrameLink,
  preAuthority: EntityFrameAuthority,
): void => {
  const frame = assertFrameBody(entityId, link);
  const signingConfig = assertLeaderTransition(env, entityId, link, preAuthority);
  const manifest = frame.hashesToSign!;
  const bundles = frame.collectedSigs;
  if (!(bundles instanceof Map) || bundles.size === 0) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_SIGNATURES_MISSING:${frame.height}:${frame.hash}`);
  }
  const { validators, shares } = normalizeConfigSigners(signingConfig);
  const seen = new Set<string>();
  let power = 0n;
  for (const [rawSignerId, signatures] of bundles) {
    const signerId = normalizeEntityId(rawSignerId);
    if (!signerId || seen.has(signerId)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_DUPLICATE_SIGNER:${rawSignerId}`);
    }
    seen.add(signerId);
    if (!validators.has(signerId)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_UNKNOWN_SIGNER:${rawSignerId}`);
    }
    if (!Array.isArray(signatures) || signatures.length !== manifest.length) {
      throw new Error(
        `STORAGE_ENTITY_LINEAGE_SIGNATURE_COUNT_MISMATCH:signer=${rawSignerId}:` +
          `actual=${Array.isArray(signatures) ? signatures.length : 'invalid'}:expected=${manifest.length}`,
      );
    }
    for (let index = 0; index < manifest.length; index += 1) {
      const hashInfo = manifest[index];
      const signature = signatures[index];
      if (!hashInfo || !signature || !verifyAccountSignature(env, signerId, hashInfo.hash, signature)) {
        throw new Error(
          `STORAGE_ENTITY_LINEAGE_SIGNATURE_INVALID:height=${frame.height}:signer=${signerId}:index=${index}`,
        );
      }
    }
    power += shares.get(signerId)!;
  }
  if (power < signingConfig.threshold) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_QUORUM_INSUFFICIENT:height=${frame.height}:` +
        `power=${power}:threshold=${signingConfig.threshold}`,
    );
  }
};

const linkFingerprint = (link: CertifiedEntityFrameLink): string =>
  certifiedEntityFrameLinkFingerprint(link);

/** Leader/manifest sit outside `frame.hash`; txs/events are already in the hash. */
const immutableFrameMetadataFingerprint = (frame: EntityFrame): string =>
  encodeCanonicalConsensusValue({
    hash: frame.hash.toLowerCase(),
    parentFrameHash: frame.parentFrameHash,
    stateRoot: frame.stateRoot.toLowerCase(),
    authorityRoot: frame.authorityRoot.toLowerCase(),
    leader: frame.leader,
    hashesToSign: frame.hashesToSign,
    entityContext: frame.entityContext,
    jPrefixCertificate: frame.jPrefixCertificate ?? null,
  });

const collectCandidates = (entries: ReplicaEntry[]): CertifiedEntityFrameLink[] =>
  entries.flatMap(entry => entry.replica.certifiedFrameHead ? [entry.replica.certifiedFrameHead] : []);

const anchorIdentity = (anchor: CertifiedEntityLineageAnchor): string =>
  encodeCanonicalConsensusValue({
    entityId: normalizeEntityId(anchor.entityId),
    height: anchor.height,
    frameHash: anchor.frameHash,
    stateRoot: anchor.stateRoot.toLowerCase(),
    authorityRoot: computeEntityFrameAuthorityRoot(anchor.authority),
    authorityEvidenceHash: anchor.authorityEvidenceHash?.toLowerCase() ?? null,
    runtimeCheckpoint: anchor.runtimeCheckpoint ?? null,
  });

const checkpointAnchorIdentity = (
  entry: ReplicaEntry,
  anchor: CertifiedEntityLineageAnchor,
): Record<string, unknown> => ({
  replicaKey: entry.replicaKey.toLowerCase(),
  signerId: normalizeEntityId(entry.replica.signerId),
  entityId: normalizeEntityId(anchor.entityId),
  height: anchor.height,
  frameHash: anchor.frameHash.toLowerCase(),
  stateRoot: anchor.stateRoot.toLowerCase(),
  authorityRoot: computeEntityFrameAuthorityRoot(anchor.authority),
  authorityEvidenceHash: anchor.authorityEvidenceHash?.toLowerCase() ?? null,
});

const computeRuntimeCheckpointReplicaSetRoot = (
  runtimeHeight: number,
  anchors: Array<{ entry: ReplicaEntry; anchor: CertifiedEntityLineageAnchor }>,
): string =>
  ethers.keccak256(
    ethers.toUtf8Bytes(
      encodeCanonicalConsensusValue({
        kind: 'xln.local-runtime-lineage-checkpoint.v1',
        runtimeHeight,
        replicas: anchors
          .map(({ entry, anchor }) => checkpointAnchorIdentity(entry, anchor))
          .sort((left, right) =>
            compareStableText(encodeCanonicalConsensusValue(left), encodeCanonicalConsensusValue(right)),
          ),
      }),
    ),
  );

const assertGenesisBoardAuthority = (
  env: RuntimeReplica,
  entityId: string,
  authority: EntityFrameAuthority,
): string | undefined => {
  validateConsensusConfig(authority.config, 'StorageCertifiedEntityGenesis.config');
  assertAuthorityShape(authority, 0, 'STORAGE_ENTITY_LINEAGE_GENESIS_AUTHORITY');
  const expectedLeader = normalizeEntityId(authority.config.validators[0] ?? '');
  const actualLeader = authority.leaderState;
  if (
    normalizeEntityId(actualLeader.activeValidatorId) !== expectedLeader ||
    actualLeader.view !== 0 ||
    actualLeader.changedAtHeight !== 0
  ) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_GENESIS_LEADER_INVALID:${entityId}`);
  }
  const boardHash = hashBoard(encodeBoard(authority.config, env)).toLowerCase();
  if (boardHash === entityId) return undefined;
  if (!authority.config.jurisdiction) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_GENESIS_STACK_MISSING:${entityId}`);
  }
  const configuredStack = getCertifiedBoardStackKey(authority.config.jurisdiction);
  const evidence = env.infrastructure?.certifiedRegistrationEvidence?.get(
    registrationEvidenceKey(configuredStack, entityId),
  );
  if (!evidence) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_GENESIS_AUTHORITY_EVIDENCE_MISSING:${entityId}:${configuredStack}:${boardHash}`,
    );
  }
  assertRegistrationEvidenceEnvelope(env, evidence);
  if (evidence.boardHash !== boardHash) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_GENESIS_BOARD_MISMATCH:${entityId}:` +
        `expected=${evidence.boardHash}:received=${boardHash}`,
    );
  }
  return computeRegistrationEvidenceHash(evidence);
};

const assertGenesisAnchor = (env: RuntimeReplica, entityId: string, anchor: CertifiedEntityLineageAnchor): void => {
  if (
    normalizeEntityId(anchor.entityId) !== entityId ||
    anchor.height !== 0 ||
    anchor.frameHash !== 'genesis' ||
    !/^0x[0-9a-f]{64}$/i.test(anchor.stateRoot)
  ) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_ANCHOR_INVALID:${entityId}`);
  }
  const expectedEvidenceHash = assertGenesisBoardAuthority(env, entityId, anchor.authority);
  if (anchor.authorityEvidenceHash !== expectedEvidenceHash) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_ANCHOR_AUTHORITY_EVIDENCE_MISMATCH:${entityId}:` +
        `expected=${expectedEvidenceHash ?? 'none'}:received=${anchor.authorityEvidenceHash ?? 'none'}`,
    );
  }
};

const assertLineageAnchor = (env: RuntimeReplica, entityId: string, anchor: CertifiedEntityLineageAnchor): void => {
  if (
    normalizeEntityId(anchor.entityId) !== entityId ||
    !Number.isSafeInteger(anchor.height) ||
    anchor.height < 0 ||
    !/^0x[0-9a-f]{64}$/i.test(anchor.stateRoot)
  ) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_ANCHOR_INVALID:${entityId}`);
  }
  if (anchor.height === 0) {
    assertGenesisAnchor(env, entityId, anchor);
  } else {
    if (!/^0x[0-9a-f]{64}$/i.test(anchor.frameHash)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_CHECKPOINT_HEAD_INVALID:${entityId}:${anchor.height}`);
    }
    if (anchor.authorityEvidenceHash !== undefined) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_CHECKPOINT_GENESIS_EVIDENCE_FORBIDDEN:${entityId}`);
    }
    assertAuthorityShape(anchor.authority, anchor.height, 'STORAGE_ENTITY_LINEAGE_CHECKPOINT_AUTHORITY');
  }
  const checkpoint = anchor.runtimeCheckpoint;
  if (
    checkpoint &&
    (!Number.isSafeInteger(checkpoint.runtimeHeight) ||
      checkpoint.runtimeHeight < 0 ||
      !/^0x[0-9a-f]{64}$/i.test(checkpoint.replicaSetRoot))
  ) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_RUNTIME_CHECKPOINT_INVALID:${entityId}`);
  }
};

const createGenesisAnchor = (
  env: RuntimeReplica,
  entityId: string,
  entry: ReplicaEntry,
): CertifiedEntityLineageAnchor => {
  if (entry.replica.state.height !== 0 || replicaHead(entry.replica) !== 'genesis') {
    throw new Error(`STORAGE_ENTITY_LINEAGE_GENESIS_STATE_INVALID:${entityId}`);
  }
  const authority = buildEntityFrameAuthority(entry.replica.state);
  const authorityEvidenceHash = assertGenesisBoardAuthority(env, entityId, authority);
  const anchor: CertifiedEntityLineageAnchor = {
    entityId,
    height: 0,
    frameHash: 'genesis',
    stateRoot: computeCanonicalEntityConsensusStateHash(entry.replica.state),
    authority,
    ...(authorityEvidenceHash ? { authorityEvidenceHash } : {}),
  };
  assertGenesisAnchor(env, entityId, anchor);
  return anchor;
};

const resolveGenesisAnchor = (
  env: RuntimeReplica,
  entityId: string,
  entries: ReplicaEntry[],
): CertifiedEntityLineageAnchor => {
  const persisted = entries.flatMap(entry =>
    entry.replica.certifiedFrameAnchor ? [entry.replica.certifiedFrameAnchor] : [],
  );
  const genesisEntry = entries.find(entry => entry.replica.state.height === 0);
  const candidates = [...persisted];
  if (genesisEntry) candidates.push(createGenesisAnchor(env, entityId, genesisEntry));
  if (candidates.length === 0) {
    const replicas = entries
      .map(
        ({ replicaKey, replica }) =>
          `${replicaKey}@h${replica.state.height}:head=${replicaHead(replica)}:` +
          `head=${replica.certifiedFrameHead ? 'present' : 'none'}`,
      )
      .sort(compareStableText)
      .join(',');
    throw new Error(`STORAGE_ENTITY_LINEAGE_ANCHOR_MISSING:entity=${entityId}:replicas=[${replicas}]`);
  }
  for (const candidate of candidates) assertGenesisAnchor(env, entityId, candidate);
  const identities = new Set(candidates.map(anchorIdentity));
  if (identities.size !== 1) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_ANCHOR_CONFLICT:entity=${entityId}:` +
        `identities=${Array.from(identities).sort(compareStableText).join('|')}`,
    );
  }
  return candidates[0]!;
};

const assertReplicaMatchesAnchor = (entry: ReplicaEntry, anchor: CertifiedEntityLineageAnchor): void => {
  const { stateRoot, authorityRoot } = replicaStateCommitments(entry.replica.state);
  const anchorAuthorityRoot = computeEntityFrameAuthorityRoot(anchor.authority);
  if (
    entry.replica.state.height !== anchor.height ||
    replicaHead(entry.replica) !== anchor.frameHash ||
    stateRoot !== anchor.stateRoot ||
    authorityRoot !== anchorAuthorityRoot
  ) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_ANCHOR_REPLICA_MISMATCH:entity=${entry.replica.entityId}:` +
        `signer=${entry.replica.signerId}:` +
        `stateHeight=${entry.replica.state.height}:anchorHeight=${anchor.height}:` +
        `stateHead=${replicaHead(entry.replica)}:anchorHead=${anchor.frameHash}:` +
        `stateRoot=${stateRoot}:anchorRoot=${anchor.stateRoot}:` +
        `stateAuthority=${authorityRoot}:` +
        `anchorAuthority=${anchorAuthorityRoot}`,
    );
  }
};

const selectCanonicalVariant = (variants: CertifiedEntityFrameLink[]): CertifiedEntityFrameLink =>
  [...variants]
    .sort((left, right) => compareStableText(linkFingerprint(left), linkFingerprint(right)))[0]!;

const assertReplicaMatchesCertifiedHeight = (entry: ReplicaEntry, link: CertifiedEntityFrameLink): void => {
  const frame = link.frame;
  const state = entry.replica.state;
  const { stateRoot, authorityRoot } = replicaStateCommitments(state);
  if (
    state.height !== frame.height ||
    replicaHead(entry.replica) !== frame.hash ||
    stateRoot !== frame.stateRoot ||
    authorityRoot !== frame.authorityRoot
  ) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_REPLICA_HEAD_MISMATCH:entity=${entry.replica.entityId}:` +
        `signer=${entry.replica.signerId}:height=${state.height}:frameHeight=${frame.height}:` +
        `stateHead=${replicaHead(entry.replica)}:frameHash=${frame.hash}:` +
        `stateRoot=${stateRoot}:frameStateRoot=${frame.stateRoot}:` +
        `authorityRoot=${authorityRoot}:frameAuthorityRoot=${frame.authorityRoot}`,
    );
  }
};

/**
 * Bind an Entity to this Runtime before its first local checkpoint exists.
 *
 * This is not compatibility recovery. A Runtime may import an already-live
 * Entity at H>0, so it must verify the complete certified H0→H chain before
 * its next R-WAL checkpoint can become the local anchor.
 */
const buildUncheckpointedEntityBootstrapPlan = (
  env: RuntimeReplica,
  entityId: string,
  entries: ReplicaEntry[],
): {
  selected: ReplicaEntry;
  ownerKey: string;
  lineage: CertifiedEntityFrameLink[];
  anchor: CertifiedEntityLineageAnchor;
} => {
  entries.forEach(assertValidHeight);
  entries.sort(
    (left, right) =>
      left.replica.state.height - right.replica.state.height ||
      compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()),
  );
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (previous.replica.state.height === current.replica.state.height) {
      assertSameHeightState(entityId, previous, current);
    }
  }
  const maxHeight = entries.at(-1)!.replica.state.height;
  const selectedCandidates = entries.filter(entry => entry.replica.state.height === maxHeight);
  const selected = [...selectedCandidates].sort((left, right) =>
    compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()),
  )[0]!;
  const anchor = resolveGenesisAnchor(env, entityId, entries);
  const candidates = collectCandidates(entries);
  const variantsByHeight = new Map<number, CertifiedEntityFrameLink[]>();
  for (const candidate of candidates) {
    const frame = assertFrameBody(entityId, candidate);
    if (frame.height < 1 || frame.height > maxHeight) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_CERT_HEIGHT_INVALID:${entityId}:${frame.height}:${maxHeight}`);
    }
    const atHeight = variantsByHeight.get(frame.height) ?? [];
    atHeight.push(candidate);
    variantsByHeight.set(frame.height, atHeight);
  }

  const selectedLinks: CertifiedEntityFrameLink[] = [];
  let currentHead = anchor.frameHash;
  let currentAuthority = anchor.authority;
  for (let height = 1; height <= maxHeight; height += 1) {
    const variants = variantsByHeight.get(height) ?? [];
    if (variants.length === 0) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_GAP:entity=${entityId}:height=${height}`);
    }
    const frameHashes = new Set(variants.map(link => link.frame.hash));
    if (frameHashes.size !== 1) {
      throw new Error(
        `STORAGE_ENTITY_LINEAGE_FORK:entity=${entityId}:height=${height}:` +
          `hashes=${Array.from(frameHashes).sort(compareStableText).join(',')}`,
      );
    }
    const metadataVariants = new Set(variants.map(variant => immutableFrameMetadataFingerprint(variant.frame)));
    if (metadataVariants.size !== 1) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_CERT_VARIANT_CONFLICT:entity=${entityId}:height=${height}`);
    }
    for (const variant of variants) {
      if (variant.frame.parentFrameHash !== currentHead) {
        throw new Error(
          `STORAGE_ENTITY_LINEAGE_PARENT_MISMATCH:entity=${entityId}:height=${height}:` +
            `expected=${currentHead}:received=${variant.frame.parentFrameHash}`,
        );
      }
      assertCertificateVariant(env, entityId, variant, currentAuthority);
    }
    const selectedLink = selectCanonicalVariant(variants);
    selectedLinks.push(selectedLink);
    currentHead = selectedLink.frame.hash;
    currentAuthority = selectedLink.postAuthority;
  }
  if (currentHead !== replicaHead(selected.replica)) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_SELECTED_HEAD_MISMATCH:entity=${entityId}:` +
        `expected=${replicaHead(selected.replica)}:actual=${currentHead}`,
    );
  }
  const selectedStateRoot = computeCanonicalEntityConsensusStateHash(selected.replica.state);
  const selectedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(selected.replica.state));
  const expectedStateRoot = selectedLinks.at(-1)?.frame.stateRoot ?? anchor.stateRoot;
  const expectedAuthorityRoot = computeEntityFrameAuthorityRoot(currentAuthority);
  if (selectedStateRoot !== expectedStateRoot || selectedAuthorityRoot !== expectedAuthorityRoot) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_SELECTED_STATE_MISMATCH:entity=${entityId}:height=${maxHeight}:` +
        `state=${selectedStateRoot}/${expectedStateRoot}:authority=${selectedAuthorityRoot}/${expectedAuthorityRoot}`,
    );
  }
  for (const entry of entries) {
    if (entry.replica.state.height === 0) {
      assertReplicaMatchesAnchor(entry, anchor);
      continue;
    }
    const link = selectedLinks.find(candidate => candidate.frame.height === entry.replica.state.height);
    if (!link) {
      throw new Error(
        `STORAGE_ENTITY_LINEAGE_REPLICA_CERT_MISSING:entity=${entityId}:height=${entry.replica.state.height}`,
      );
    }
    assertReplicaMatchesCertifiedHeight(entry, link);
  }
  const ownerKey = [...entries].sort((left, right) =>
    compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()),
  )[0]!.replicaKey;
  return { selected, ownerKey, lineage: selectedLinks, anchor };
};

type EntityLineagePlan = {
  selected: ReplicaEntry;
  lineages: Map<string, CertifiedEntityFrameLink[]>;
  anchors: Map<string, CertifiedEntityLineageAnchor>;
};

const buildCheckpointedReplicaLineage = (
  env: RuntimeReplica,
  entityId: string,
  entry: ReplicaEntry,
  anchor: CertifiedEntityLineageAnchor,
): CertifiedEntityFrameLink[] => {
  assertValidHeight(entry);
  assertLineageAnchor(env, entityId, anchor);
  const stateHeight = entry.replica.state.height;
  if (stateHeight < anchor.height) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_REPLICA_BEFORE_CHECKPOINT:entity=${entityId}:` +
        `signer=${entry.replica.signerId}:state=${stateHeight}:anchor=${anchor.height}`,
    );
  }
  if (stateHeight === anchor.height) {
    if (entry.replica.certifiedFrameHead) {
      throw new Error(`STORAGE_ENTITY_HEAD_NOT_REBASED:${entityId}:${stateHeight}`);
    }
    assertReplicaMatchesAnchor(entry, anchor);
    return [];
  }
  if (stateHeight !== anchor.height + 1) {
    throw new Error(
      `STORAGE_ENTITY_HEAD_DISTANCE_INVALID:${entityId}:anchor=${anchor.height}:state=${stateHeight}`,
    );
  }
  const head = entry.replica.certifiedFrameHead;
  if (!head) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_GAP:entity=${entityId}:signer=${entry.replica.signerId}:height=${stateHeight}`);
  }
  const frame = assertFrameBody(entityId, head);
  if (frame.height !== stateHeight || frame.parentFrameHash !== anchor.frameHash) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_PARENT_MISMATCH:entity=${entityId}:height=${frame.height}:` +
        `expected=${anchor.frameHash}:received=${frame.parentFrameHash}`,
    );
  }
  assertCertificateVariant(env, entityId, head, anchor.authority);
  assertReplicaMatchesCertifiedHeight(entry, head);
  return [head];
};

const assertCheckpointSet = (
  entityId: string,
  anchored: Array<{ entry: ReplicaEntry; anchor: CertifiedEntityLineageAnchor }>,
): void => {
  const checkpoints = anchored.map(({ anchor }) => anchor.runtimeCheckpoint!);
  const runtimeHeights = new Set(checkpoints.map(checkpoint => checkpoint.runtimeHeight));
  const roots = new Set(checkpoints.map(checkpoint => checkpoint.replicaSetRoot.toLowerCase()));
  if (runtimeHeights.size !== 1 || roots.size !== 1) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_RUNTIME_CHECKPOINT_CONFLICT:${entityId}`);
  }
  const runtimeHeight = checkpoints[0]!.runtimeHeight;
  const expectedRoot = computeRuntimeCheckpointReplicaSetRoot(runtimeHeight, anchored);
  const receivedRoot = checkpoints[0]!.replicaSetRoot.toLowerCase();
  if (expectedRoot !== receivedRoot) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_RUNTIME_CHECKPOINT_ROOT_MISMATCH:${entityId}:` +
        `expected=${expectedRoot}:received=${receivedRoot}`,
    );
  }
};

const buildCheckpointedEntityPlan = (
  env: RuntimeReplica,
  entityId: string,
  entries: ReplicaEntry[],
): EntityLineagePlan => {
  entries.forEach(assertValidHeight);
  entries.sort(
    (left, right) =>
      left.replica.state.height - right.replica.state.height ||
      compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()),
  );
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (previous.replica.state.height === current.replica.state.height) {
      assertSameHeightState(entityId, previous, current);
    }
  }

  const anchored = entries.flatMap(entry => {
    const anchor = entry.replica.certifiedFrameAnchor;
    return anchor?.runtimeCheckpoint ? [{ entry, anchor }] : [];
  });
  if (anchored.length === 0) {
    throw new Error(`STORAGE_ENTITY_LINEAGE_RUNTIME_CHECKPOINT_MISSING:${entityId}`);
  }
  const uncheckpointedAnchor = entries.find(
    entry => entry.replica.certifiedFrameAnchor && !entry.replica.certifiedFrameAnchor.runtimeCheckpoint,
  );
  if (uncheckpointedAnchor) {
    throw new Error(
      `STORAGE_ENTITY_LINEAGE_CHECKPOINT_MODE_MIX:${entityId}:${uncheckpointedAnchor.replicaKey}`,
    );
  }
  for (const { anchor } of anchored) assertLineageAnchor(env, entityId, anchor);
  assertCheckpointSet(entityId, anchored);

  const lineages = new Map<string, CertifiedEntityFrameLink[]>();
  const anchors = new Map<string, CertifiedEntityLineageAnchor>();
  for (const { entry, anchor } of anchored) {
    lineages.set(entry.replicaKey, buildCheckpointedReplicaLineage(env, entityId, entry, anchor));
    anchors.set(entry.replicaKey, anchor);
  }

  // A newly imported local validator shares an already-certified immutable
  // replica before the next R-frame is durable. It has no authority to invent a
  // checkpoint: accept it only when its exact consensus endpoint equals one of
  // the checkpoint-bound replicas, then include it in the next atomic set root.
  for (const entry of entries) {
    if (anchors.has(entry.replicaKey)) continue;
    if (entry.replica.certifiedFrameHead) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_UNANCHORED_CERTIFICATES:${entityId}:${entry.replicaKey}`);
    }
    const donor = anchored.find(
      ({ entry: candidate }) =>
        candidate.replica.state.height === entry.replica.state.height &&
        replicaHead(candidate.replica) === replicaHead(entry.replica) &&
        computeCanonicalEntityConsensusStateHash(candidate.replica.state) ===
          computeCanonicalEntityConsensusStateHash(entry.replica.state) &&
        computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(candidate.replica.state)) ===
          computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(entry.replica.state)),
    );
    if (!donor) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_RUNTIME_CHECKPOINT_MEMBER_MISSING:${entityId}:${entry.replicaKey}`);
    }
    lineages.set(entry.replicaKey, []);
  }

  const headsByHeight = new Map<number, { hash: string; stateRoot: string; authorityRoot: string }>();
  const registerHead = (height: number, hash: string, stateRoot: string, authorityRoot: string): void => {
    const existing = headsByHeight.get(height);
    if (
      existing &&
      (existing.hash !== hash || existing.stateRoot !== stateRoot || existing.authorityRoot !== authorityRoot)
    ) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_FORK:entity=${entityId}:height=${height}`);
    }
    headsByHeight.set(height, { hash, stateRoot, authorityRoot });
  };
  for (const { anchor } of anchored) {
    registerHead(anchor.height, anchor.frameHash, anchor.stateRoot, computeEntityFrameAuthorityRoot(anchor.authority));
  }
  for (const links of lineages.values()) {
    for (const { frame } of links) {
      registerHead(frame.height, frame.hash, frame.stateRoot, frame.authorityRoot);
    }
  }

  const maxHeight = entries.at(-1)!.replica.state.height;
  const selected = entries
    .filter(entry => entry.replica.state.height === maxHeight)
    .sort((left, right) => compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()))[0]!;
  return { selected, lineages, anchors };
};

const buildEntityPlan = (env: RuntimeReplica, entityId: string, entries: ReplicaEntry[]): EntityLineagePlan => {
  const checkpointed = entries.some(entry => Boolean(entry.replica.certifiedFrameAnchor?.runtimeCheckpoint));
  if (checkpointed) return buildCheckpointedEntityPlan(env, entityId, entries);
  const bootstrap = buildUncheckpointedEntityBootstrapPlan(env, entityId, entries);
  return {
    selected: bootstrap.selected,
    lineages: new Map([[bootstrap.ownerKey, bootstrap.lineage]]),
    anchors: new Map([[bootstrap.ownerKey, bootstrap.anchor]]),
  };
};

export const buildCertifiedEntityLineagePlan = (env: RuntimeReplica): CertifiedEntityLineagePlan => {
  const byEntity = new Map<string, ReplicaEntry[]>();
  for (const [rawReplicaKey, replica] of env.state.eReplicas.entries()) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    const entries = byEntity.get(entityId) ?? [];
    entries.push({ replicaKey: String(rawReplicaKey), replica });
    byEntity.set(entityId, entries);
  }
  const lookup: StorageReplicaLookup = new Map();
  const lineageByReplicaKey = new Map<string, CertifiedEntityFrameLink[]>();
  const anchorByReplicaKey = new Map<string, CertifiedEntityLineageAnchor>();
  for (const [entityId, entries] of Array.from(byEntity.entries()).sort(([left], [right]) =>
    compareStableText(left, right),
  )) {
    const plan = buildEntityPlan(env, entityId, entries);
    lookup.set(entityId, {
      replicaKey: plan.selected.replicaKey,
      replica: plan.selected.replica,
      state: plan.selected.replica.state,
    });
    for (const [replicaKey, lineage] of plan.lineages) {
      lineageByReplicaKey.set(replicaKey, lineage);
    }
    for (const [replicaKey, anchor] of plan.anchors) {
      anchorByReplicaKey.set(replicaKey, anchor);
    }
  }
  return { lookup, lineageByReplicaKey, anchorByReplicaKey };
};

/**
 * Collapses certificate history into the exact validator-local states already
 * accepted by this Runtime. The returned anchors gain authority only when the
 * caller publishes their replica-meta digest in the same atomic R-frame WAL
 * batch. They are never valid peer/Entity certificates and never cross a
 * Runtime trust boundary.
 */
export const rebaseCertifiedEntityLineageAtRuntimeCheckpoint = (
  env: RuntimeReplica,
  validated = buildCertifiedEntityLineagePlan(env),
): CertifiedEntityLineagePlan => {
  const lineageByReplicaKey = new Map<string, CertifiedEntityFrameLink[]>();
  const anchorByReplicaKey = new Map<string, CertifiedEntityLineageAnchor>();
  const entriesByEntity = new Map<string, ReplicaEntry[]>();
  const endpointEvidence = new Map<string, CertifiedEntityLineageAnchor>();
  const endpointKey = (entityId: string, height: number, frameHash: string): string =>
    `${normalizeEntityId(entityId)}:${height}:${String(frameHash).toLowerCase()}`;
  for (const anchor of validated.anchorByReplicaKey.values()) {
    endpointEvidence.set(endpointKey(anchor.entityId, anchor.height, anchor.frameHash), anchor);
  }
  for (const [replicaKey, links] of validated.lineageByReplicaKey) {
    const replica = env.state.eReplicas.get(replicaKey);
    const evidenceEntityId = normalizeEntityId(replica?.entityId || replica?.state?.entityId || '');
    if (!evidenceEntityId && links.length > 0) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_CHECKPOINT_REPLICA_MISSING:${replicaKey}`);
    }
    for (const link of links) {
      endpointEvidence.set(endpointKey(evidenceEntityId, link.frame.height, link.frame.hash), {
        entityId: evidenceEntityId,
        height: link.frame.height,
        frameHash: link.frame.hash,
        stateRoot: link.frame.stateRoot,
        authority: link.postAuthority,
      });
    }
  }
  for (const [rawReplicaKey, replica] of env.state.eReplicas) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    const entries = entriesByEntity.get(entityId) ?? [];
    entries.push({ replicaKey: String(rawReplicaKey), replica });
    entriesByEntity.set(entityId, entries);
  }

  for (const [entityId, entries] of entriesByEntity) {
    if (!validated.lookup.has(entityId)) {
      throw new Error(`STORAGE_ENTITY_LINEAGE_CHECKPOINT_LOOKUP_MISSING:${entityId}`);
    }
    const pending = entries.map(entry => {
      const state = entry.replica.state;
      const frameHash = replicaHead(entry.replica);
      const evidence = endpointEvidence.get(endpointKey(entityId, state.height, frameHash));
      if (!evidence) {
        throw new Error(`STORAGE_ENTITY_LINEAGE_CHECKPOINT_ENDPOINT_MISSING:${entityId}:${state.height}:${frameHash}`);
      }
      const base: CertifiedEntityLineageAnchor = {
        entityId,
        height: state.height,
        frameHash,
        stateRoot: evidence.stateRoot,
        authority: evidence.authority,
        ...(evidence.authorityEvidenceHash ? { authorityEvidenceHash: evidence.authorityEvidenceHash } : {}),
      };
      return { entry, anchor: base };
    });
    const replicaSetRoot = computeRuntimeCheckpointReplicaSetRoot(env.state.height, pending);
    for (const { entry, anchor } of pending) {
      const checkpointed: CertifiedEntityLineageAnchor = {
        ...anchor,
        runtimeCheckpoint: {
          runtimeHeight: env.state.height,
          replicaSetRoot,
        },
      };
      assertLineageAnchor(env, entityId, checkpointed);
      anchorByReplicaKey.set(entry.replicaKey, checkpointed);
      // The synced Runtime WAL makes this endpoint durable before the plan is
      // installed in memory. Full Entity certificates remain in the Entity
      // history view; the live replica needs only this anchor plus links
      // certified after it. Pruning earlier would make a failed WAL write lose
      // recovery evidence, while retaining the full prefix would make memory
      // grow with Entity age.
    }
  }
  return {
    lookup: validated.lookup,
    lineageByReplicaKey,
    anchorByReplicaKey,
  };
};

/**
 * Builds the local checkpoint anchor from Entity endpoints that this Runtime
 * has already certified while applying earlier R-frames. This intentionally
 * does not re-verify every historical Hanko: that audit belongs to replay and
 * test gates. Repeating it synchronously every 100 R-frames turns a derived
 * LevelDB checkpoint into user-visible latency without adding new authority.
 */
export const buildRuntimeCheckpointLineagePlan = (
  env: RuntimeReplica,
  sourceReplicas: ReadonlyMap<string, EntityReplica> = env.state.eReplicas,
): CertifiedEntityLineagePlan => {
  const entriesByEntity = new Map<string, ReplicaEntry[]>();
  for (const [rawReplicaKey, replica] of sourceReplicas) {
    if (!replica?.state) continue;
    const entityId = normalizeEntityId(replica.entityId || replica.state.entityId || '');
    if (!entityId) continue;
    assertValidHeight({ replicaKey: String(rawReplicaKey), replica });
    const entries = entriesByEntity.get(entityId) ?? [];
    entries.push({ replicaKey: String(rawReplicaKey), replica });
    entriesByEntity.set(entityId, entries);
  }

  // Entity-frame certificates are Entity-wide facts, not validator-local
  // facts. Live storage keeps the pre-checkpoint lineage on one canonical
  // replica to avoid multiplying identical Hanko payloads by the signer count.
  // Resolve that shared evidence by exact consensus endpoint, then bind it to
  // every matching local replica below. A same-height fork or a state mismatch
  // remains fatal before the checkpoint enters the WAL.
  const endpointKey = (entityId: string, height: number, frameHash: string): string =>
    `${normalizeEntityId(entityId)}:${height}:${String(frameHash).toLowerCase()}`;
  const endpointEvidence = new Map<string, CertifiedEntityLineageAnchor>();
  const registerEndpointEvidence = (evidence: CertifiedEntityLineageAnchor): void => {
    const key = endpointKey(evidence.entityId, evidence.height, evidence.frameHash);
    const existing = endpointEvidence.get(key);
    if (
      existing &&
      (existing.stateRoot.toLowerCase() !== evidence.stateRoot.toLowerCase() ||
        computeEntityFrameAuthorityRoot(existing.authority) !== computeEntityFrameAuthorityRoot(evidence.authority))
    ) {
      throw new Error(`STORAGE_RUNTIME_CHECKPOINT_ENDPOINT_CONFLICT:${key}`);
    }
    if (!existing) endpointEvidence.set(key, evidence);
  };
  for (const [entityId, entries] of entriesByEntity) {
    for (const { replica } of entries) {
      if (replica.certifiedFrameAnchor) {
        registerEndpointEvidence({
          ...replica.certifiedFrameAnchor,
          entityId,
        });
      }
      for (const link of replica.certifiedFrameHead ? [replica.certifiedFrameHead] : []) {
        registerEndpointEvidence({
          entityId,
          height: link.frame.height,
          frameHash: link.frame.hash,
          stateRoot: link.frame.stateRoot,
          authority: link.postAuthority,
        });
      }
    }
  }

  const lookup: StorageReplicaLookup = new Map();
  const lineageByReplicaKey = new Map<string, CertifiedEntityFrameLink[]>();
  const anchorByReplicaKey = new Map<string, CertifiedEntityLineageAnchor>();
  for (const [entityId, entries] of Array.from(entriesByEntity.entries()).sort(([left], [right]) =>
    compareStableText(left, right),
  )) {
    const ordered = [...entries].sort(
      (left, right) =>
        right.replica.state.height - left.replica.state.height ||
        compareStableText(left.replicaKey.toLowerCase(), right.replicaKey.toLowerCase()),
    );
    const selected = ordered[0]!;
    lookup.set(entityId, {
      replicaKey: selected.replicaKey,
      replica: selected.replica,
      state: selected.replica.state,
    });

    const pending = entries.map(entry => {
      const height = entry.replica.state.height;
      const frameHash = replicaHead(entry.replica);
      const genesisAnchor =
        height === 0 && frameHash === 'genesis' ? createGenesisAnchor(env, entityId, entry) : undefined;
      const evidence = endpointEvidence.get(endpointKey(entityId, height, frameHash));
      if (!genesisAnchor && !evidence) {
        const existingAnchor = entry.replica.certifiedFrameAnchor;
        const anchorEndpoint = existingAnchor ? `${existingAnchor.height}@${existingAnchor.frameHash}` : 'none';
        const lineageEndpoints =
          (entry.replica.certifiedFrameHead ? [entry.replica.certifiedFrameHead] : [])
            .map(link => `${link.frame.height}@${link.frame.hash}`)
            .join(',') || 'none';
        throw new Error(
          `STORAGE_RUNTIME_CHECKPOINT_ENDPOINT_MISSING:${entityId}:${entry.replica.signerId}:` +
            `head=${height}@${frameHash}:anchor=${anchorEndpoint}:lineage=${lineageEndpoints}`,
        );
      }
      const anchor: CertifiedEntityLineageAnchor = genesisAnchor ?? {
        entityId,
        height,
        frameHash,
        stateRoot: evidence!.stateRoot,
        authority: evidence!.authority,
        ...(evidence!.authorityEvidenceHash ? { authorityEvidenceHash: evidence!.authorityEvidenceHash } : {}),
      };
      const { stateRoot, authorityRoot } = replicaStateCommitments(entry.replica.state);
      const anchorAuthorityRoot = computeEntityFrameAuthorityRoot(anchor.authority);
      if (stateRoot !== anchor.stateRoot || authorityRoot !== anchorAuthorityRoot) {
        throw new Error(
          `STORAGE_RUNTIME_CHECKPOINT_STATE_MISMATCH:${entityId}:${entry.replica.signerId}:` +
            `head=${height}@${frameHash}:state=${stateRoot}/${anchor.stateRoot}:` +
            `authority=${authorityRoot}/${anchorAuthorityRoot}`,
        );
      }
      return { entry, anchor };
    });
    const replicaSetRoot = computeRuntimeCheckpointReplicaSetRoot(env.state.height, pending);
    for (const { entry, anchor } of pending) {
      anchorByReplicaKey.set(entry.replicaKey, {
        ...anchor,
        runtimeCheckpoint: { runtimeHeight: env.state.height, replicaSetRoot },
      });
      // Deliberately leave the post-checkpoint lineage empty. The commit path
      // installs this plan only after the synced WAL batch succeeds. Subsequent
      // Entity frames append a short, independently verifiable tail.
    }
  }
  return { lookup, lineageByReplicaKey, anchorByReplicaKey };
};

/**
 * Seal only the Entity that is about to enter an Entity-frame transition.
 * Untouched Entity anchors stay byte-identical; a later full storage
 * checkpoint still validates and republishes the complete replica set.
 */
export const refreshRuntimeCheckpointLineageForEntity = (env: RuntimeReplica, rawEntityId: string): void => {
  const entityId = normalizeEntityId(rawEntityId);
  // Runtime owns a deliberately small, flat set of Entity replicas. Select
  // the target cohort explicitly; never clone an Entity or its Account graph.
  const replicas = new Map<string, EntityReplica>();
  for (const [replicaKey, replica] of env.state.eReplicas) {
    if (normalizeEntityId(replica.entityId || replica.state.entityId || '') === entityId) {
      replicas.set(replicaKey, replica);
    }
  }
  if (replicas.size === 0) {
    throw new Error(`STORAGE_RUNTIME_CHECKPOINT_ENTITY_MISSING:${entityId}`);
  }
  const plan = buildRuntimeCheckpointLineagePlan(env, replicas);
  for (const [replicaKey, replica] of replicas) {
    const lineage = plan.lineageByReplicaKey.get(replicaKey);
    if (lineage && lineage.length > 0) replica.certifiedFrameHead = lineage.at(-1)!;
    else delete replica.certifiedFrameHead;
    const anchor = plan.anchorByReplicaKey.get(replicaKey);
    if (anchor) replica.certifiedFrameAnchor = anchor;
    else delete replica.certifiedFrameAnchor;
  }
};

export type RuntimeCheckpointLineageRefreshGuard = Readonly<{
  finalize: () => boolean;
}>;

/**
 * Refreshing a checkpoint anchor is preparation for an Entity-frame commit,
 * not an independent Runtime transition. If the attempted input is a
 * duplicate/no-op and no local replica head advances, restore the exact prior
 * metadata so the WAL remains a pure function of its persisted Runtime input.
 */
export const beginRuntimeCheckpointLineageRefresh = (
  env: RuntimeReplica,
  rawEntityId: string,
): RuntimeCheckpointLineageRefreshGuard => {
  const entityId = normalizeEntityId(rawEntityId);
  const snapshots = [...env.state.eReplicas.entries()]
    .filter(([, replica]) => normalizeEntityId(replica.entityId || replica.state.entityId || '') === entityId)
    .map(([replicaKey, replica]) => ({
      replicaKey,
      height: replica.state.height,
      frameHash: replicaHead(replica),
      certifiedFrameHead: replica.certifiedFrameHead,
      certifiedFrameAnchor: replica.certifiedFrameAnchor,
    }));
  if (snapshots.length === 0) {
    throw new Error(`STORAGE_RUNTIME_CHECKPOINT_ENTITY_MISSING:${entityId}`);
  }
  refreshRuntimeCheckpointLineageForEntity(env, entityId);
  return {
    finalize: (): boolean => {
      const advanced = snapshots.some(snapshot => {
        const replica = env.state.eReplicas.get(snapshot.replicaKey);
        if (!replica) {
          throw new Error(`STORAGE_RUNTIME_CHECKPOINT_REPLICA_DISAPPEARED:${snapshot.replicaKey}`);
        }
        return replica.state.height !== snapshot.height || replicaHead(replica) !== snapshot.frameHash;
      });
      if (advanced) return true;
      for (const snapshot of snapshots) {
        const replica = env.state.eReplicas.get(snapshot.replicaKey)!;
        if (snapshot.certifiedFrameHead) {
          replica.certifiedFrameHead = snapshot.certifiedFrameHead;
        } else {
          delete replica.certifiedFrameHead;
        }
        if (snapshot.certifiedFrameAnchor) {
          replica.certifiedFrameAnchor = snapshot.certifiedFrameAnchor;
        } else {
          delete replica.certifiedFrameAnchor;
        }
      }
      return false;
    },
  };
};

export const applyCertifiedEntityLineagePlan = (env: RuntimeReplica, plan: CertifiedEntityLineagePlan): void => {
  for (const [replicaKey, replica] of env.state.eReplicas.entries()) {
    const lineage = plan.lineageByReplicaKey.get(String(replicaKey));
    if (lineage && lineage.length > 0) {
      replica.certifiedFrameHead = lineage.at(-1)!;
    } else {
      delete replica.certifiedFrameHead;
    }
    const anchor = plan.anchorByReplicaKey.get(String(replicaKey));
    if (anchor) replica.certifiedFrameAnchor = anchor;
    else delete replica.certifiedFrameAnchor;
  }
};
