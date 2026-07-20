import { ethers } from 'ethers';

import { signAccountFrame, verifyAccountSignature } from '../account/crypto';
import { encodeCanonicalEntityConsensusValue } from '../entity/consensus/state-root';
import { compareStableText } from '../protocol/serialization';
import type {
  ConsensusConfig,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JPrefixAttestation,
  JPrefixCertificate,
  JPrefixClaim,
  JPrefixRound,
  JurisdictionEventBlock,
  ValidatorJHistory,
} from '../types';
import {
  getJEventJurisdictionRef,
} from './event-observation';
import { buildJEventRangeDigest, canonicalJEventRangeHash, foldJHistoryRoot } from './history-consensus';
import { normalizeStrictJEventBlock } from './j-event-range-validation';
import {
  buildUnsignedJEventRangeAtHeight,
  buildValidatorJPrefixHeaders,
  finalizedJHistoryRoot,
  getValidatorJContiguousThroughHeight,
  reconcileJEventRangeWithFinalizedState,
} from './local-history';
import { getJRangeClaimsProposableBudgetError, type JRangeBody } from './range-budget';

const J_PREFIX_ATTESTATION_DOMAIN = 'xln:j-prefix-attestation:v1';

const normalizeText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const normalizeHeight = (value: unknown, label: string): number => {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`J_PREFIX_${label}_INVALID:${String(value)}`);
  return height;
};

const normalizeHash = (value: unknown, label: string): string => {
  const hash = normalizeText(value);
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`J_PREFIX_${label}_INVALID:${String(value)}`);
  return hash;
};

const normalizeClaimEnvelope = (expectedJurisdictionRef: string, raw: JPrefixClaim): JPrefixClaim => {
  const jurisdictionRef = normalizeText(raw.jurisdictionRef);
  if (jurisdictionRef !== expectedJurisdictionRef) {
    throw new Error(`J_PREFIX_JURISDICTION_MISMATCH:${jurisdictionRef}:${expectedJurisdictionRef}`);
  }
  const baseHeight = normalizeHeight(raw.baseHeight, 'BASE_HEIGHT');
  const scannedThroughHeight = normalizeHeight(raw.scannedThroughHeight, 'SCANNED_HEIGHT');
  if (scannedThroughHeight < baseHeight) throw new Error('J_PREFIX_BEHIND_BASE');
  let priorHeight = baseHeight;
  const blocks = raw.blocks.map((block) => {
    const normalized = normalizeStrictJEventBlock(
      block,
      priorHeight,
      scannedThroughHeight,
      'J_PREFIX',
    );
    priorHeight = normalized.blockNumber;
    return normalized;
  });
  const rangeHash = canonicalJEventRangeHash(jurisdictionRef, blocks);
  if (normalizeHash(raw.rangeHash, 'RANGE_HASH') !== rangeHash) {
    throw new Error('J_PREFIX_RANGE_HASH_MISMATCH');
  }
  const claim: JPrefixClaim = {
    jurisdictionRef,
    baseHeight,
    scannedThroughHeight,
    tipBlockHash: normalizeHash(raw.tipBlockHash, 'TIP_HASH'),
    eventHistoryRoot: normalizeHash(raw.eventHistoryRoot, 'HISTORY_ROOT'),
    rangeHash,
    blocks,
  };
  return claim;
};

const normalizeClaim = (state: EntityState, raw: JPrefixClaim): JPrefixClaim => {
  const claim = normalizeClaimEnvelope(getJEventJurisdictionRef(state.config.jurisdiction), raw);
  const { baseHeight, scannedThroughHeight, jurisdictionRef, blocks } = claim;
  if (baseHeight !== state.lastFinalizedJHeight) {
    throw new Error(`J_PREFIX_BASE_HEIGHT_MISMATCH:${baseHeight}:${state.lastFinalizedJHeight}`);
  }
  const eventHistoryRoot = foldJHistoryRoot(
    finalizedJHistoryRoot(state),
    blocks.map(block => ({
      jurisdictionRef,
      jHeight: block.blockNumber,
      jBlockHash: block.blockHash,
      eventsHash: block.eventsHash,
      ...(block.disputeFinalizationEvidenceHash
        ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
        : {}),
    })),
  );
  if (claim.eventHistoryRoot !== eventHistoryRoot) {
    throw new Error('J_PREFIX_HISTORY_ROOT_MISMATCH');
  }
  const anchoredClaim = { ...claim, eventHistoryRoot };
  if (scannedThroughHeight === baseHeight) {
    if (!state.jHistoryFinality) throw new Error('J_PREFIX_BASE_ATTESTATION_WITHOUT_CERTIFIED_ANCHOR');
    const certifiedBase = buildCertifiedBaseClaim(state);
    if (encodeCanonicalEntityConsensusValue(anchoredClaim) !== encodeCanonicalEntityConsensusValue(certifiedBase)) {
      throw new Error('J_PREFIX_BASE_ATTESTATION_CONFLICT');
    }
  }
  return anchoredClaim;
};

const attestationBody = (attestation: Omit<JPrefixAttestation, 'signature'>): unknown => ({
  domain: J_PREFIX_ATTESTATION_DOMAIN,
  version: 1,
  entityId: normalizeText(attestation.entityId),
  targetEntityHeight: attestation.targetEntityHeight,
  parentFrameHash: normalizeText(attestation.parentFrameHash),
  validatorId: normalizeText(attestation.validatorId),
  jurisdictionRef: normalizeText(attestation.jurisdictionRef),
  baseHeight: attestation.baseHeight,
  scannedThroughHeight: attestation.scannedThroughHeight,
  tipBlockHash: normalizeText(attestation.tipBlockHash),
  eventHistoryRoot: normalizeText(attestation.eventHistoryRoot),
  rangeHash: normalizeText(attestation.rangeHash),
  headers: attestation.headers.map(header => ({
    jHeight: header.jHeight,
    jBlockHash: normalizeText(header.jBlockHash),
  })),
  blocks: attestation.blocks,
});

export const hashJPrefixAttestation = (attestation: Omit<JPrefixAttestation, 'signature'>): string =>
  ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue(attestationBody(attestation))));

const currentParentFrameHash = (state: EntityState): string =>
  state.height === 0 ? 'genesis' : String(state.prevFrameHash || '');

/**
 * Registered Entities certify one exact J prefix in every Entity frame. A
 * jurisdiction-configured lazy Entity is not registered merely because it can
 * observe that stack; `registrationBlock` or an existing certified anchor is
 * the durable authority boundary.
 */
export const entityRequiresJPrefixCertificate = (state: EntityState): boolean =>
  state.config.jurisdiction?.registrationBlock !== undefined || Boolean(state.jHistoryFinality);

const buildCertifiedBaseClaim = (state: EntityState): JPrefixClaim => {
  const baseHeight = state.lastFinalizedJHeight;
  const finality = state.jHistoryFinality;
  if (!finality || finality.finalizedThroughHeight !== baseHeight) {
    throw new Error(`J_PREFIX_CERTIFIED_BASE_MISSING:${baseHeight}`);
  }
  const jurisdictionRef = getJEventJurisdictionRef(state.config.jurisdiction);
  if (normalizeText(finality.jurisdictionRef) !== jurisdictionRef) {
    throw new Error('J_PREFIX_CERTIFIED_BASE_JURISDICTION_MISMATCH');
  }
  return {
    jurisdictionRef,
    baseHeight,
    scannedThroughHeight: baseHeight,
    tipBlockHash: normalizeHash(finality.tipBlockHash, 'CERTIFIED_BASE_TIP_HASH'),
    eventHistoryRoot: normalizeHash(finality.eventHistoryRoot, 'CERTIFIED_BASE_HISTORY_ROOT'),
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
    blocks: [],
  };
};

const buildBaseClaim = (state: EntityState, history: ValidatorJHistory): JPrefixClaim => {
  if (state.jHistoryFinality) return buildCertifiedBaseClaim(state);
  const baseHeight = state.lastFinalizedJHeight;
  const tipBlockHash = history.blockHashes.get(baseHeight);
  if (!tipBlockHash) throw new Error(`J_PREFIX_LOCAL_TIP_HASH_MISSING:${baseHeight}`);
  const jurisdictionRef = getJEventJurisdictionRef(state.config.jurisdiction);
  return {
    jurisdictionRef,
    baseHeight,
    scannedThroughHeight: baseHeight,
    tipBlockHash: normalizeHash(tipBlockHash, 'TIP_HASH'),
    eventHistoryRoot: finalizedJHistoryRoot(state),
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
    blocks: [],
  };
};

const isolatedEventBlockClaim = (claim: JPrefixClaim, block: JurisdictionEventBlock): JRangeBody => ({
  jurisdictionRef: claim.jurisdictionRef,
  baseHeight: block.blockNumber - 1,
  scannedThroughHeight: block.blockNumber,
  tipBlockHash: block.blockHash,
  eventHistoryRoot: claim.eventHistoryRoot,
  rangeHash: canonicalJEventRangeHash(claim.jurisdictionRef, [block]),
  blocks: [block],
});

/**
 * Find the highest exact local prefix that fits one Entity frame. Heights are
 * tested in order so a block body is either wholly included or wholly left for
 * the next certified prefix. A block that cannot fit by itself is terminal:
 * repeatedly advancing or retrying around it would silently omit J history.
 */
/**
 * Highest local head this validator can prove without crossing a sparse gap.
 * A later event remains durable while its missing predecessor headers are
 * fetched, but it must not strand an already-complete earlier prefix.
 */
export const getLocalJPrefixAttestableHeight = (
  state: EntityState,
  history: ValidatorJHistory,
): number | null => {
  const baseHeight = state.lastFinalizedJHeight;
  const contiguousHeight = getValidatorJContiguousThroughHeight(state, history);
  if (contiguousHeight > baseHeight) return contiguousHeight;
  const hasSparsePendingEvent = Array.from(history.eventBlocks.keys()).some(
    height => height > baseHeight && height <= history.scannedThroughHeight,
  );
  if (hasSparsePendingEvent || !state.jHistoryFinality) return null;
  return baseHeight;
};

const buildBudgetedLocalClaim = (state: EntityState, history: ValidatorJHistory): JPrefixClaim | null => {
  const baseHeight = state.lastFinalizedJHeight;
  const highestHeight = getLocalJPrefixAttestableHeight(state, history);
  if (highestHeight === null) return null;
  if (highestHeight === baseHeight) return buildBaseClaim(state, history);
  const claimAt = (height: number): JPrefixClaim => {
    const claim = buildUnsignedJEventRangeAtHeight(state, history, height);
    if (!claim) throw new Error(`J_PREFIX_BUDGET_CLAIM_MISSING:${height}`);
    return claim;
  };
  const budgetError = (claim: JRangeBody): string | null =>
    getJRangeClaimsProposableBudgetError([claim], state.config.validators);
  const highestClaim = claimAt(highestHeight);
  if (!budgetError(highestClaim)) return highestClaim;

  // Canonical range size is monotonic: the event-block list is append-only,
  // hashes/signatures are fixed-width, and decimal heights never shrink.
  // Binary search caps repeated canonical encodings at log2(backlog), even near
  // 10 MiB. There is deliberately no arbitrary block-count cap: empty blocks
  // add no frame body, so the exact available prefix advances in one frame.
  let lower = baseHeight + 1;
  let upper = highestHeight - 1;
  let selected: JPrefixClaim | null = null;
  while (lower <= upper) {
    const height = Math.floor((lower + upper) / 2);
    const claim = claimAt(height);
    if (budgetError(claim)) {
      upper = height - 1;
    } else {
      selected = claim;
      lower = height + 1;
    }
  }

  const failingHeight = (selected?.scannedThroughHeight ?? baseHeight) + 1;
  const failingClaim = claimAt(failingHeight);
  const error = budgetError(failingClaim);
  if (!error) throw new Error(`J_PREFIX_BUDGET_SEARCH_NON_MONOTONIC:${failingHeight}`);
  const eventBlock = failingClaim.blocks.find(block => block.blockNumber === failingHeight);
  if (eventBlock) {
    const isolatedError = budgetError(isolatedEventBlockClaim(failingClaim, eventBlock));
    if (isolatedError?.startsWith('J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:')) {
      throw new Error(`J_RANGE_SINGLE_BLOCK_UNPROPOSABLE:${failingHeight}:${isolatedError}`);
    }
  }
  if (!selected) throw new Error(`J_PREFIX_RANGE_UNPROPOSABLE:${failingHeight}:${error}`);
  return selected;
};

const normalizeAttestationClaimEvidence = (
  raw: JPrefixAttestation,
  claim: JPrefixClaim,
  validators: readonly string[],
): Pick<JPrefixAttestation, 'headers' | 'signature'> => {
  if (claim.scannedThroughHeight > claim.baseHeight) {
    const budgetError = getJRangeClaimsProposableBudgetError([claim], validators);
    if (budgetError) throw new Error(`J_PREFIX_ATTESTATION_BUDGET_INVALID:${budgetError}`);
  }
  const expectedHeaderCount = claim.scannedThroughHeight - claim.baseHeight;
  if (!Array.isArray(raw.headers) || raw.headers.length !== expectedHeaderCount) {
    throw new Error(`J_PREFIX_HEADER_COUNT_MISMATCH:${raw.headers?.length ?? -1}:${expectedHeaderCount}`);
  }
  const headers = raw.headers.map((header, index) => {
    const jHeight = normalizeHeight(header.jHeight, 'HEADER_HEIGHT');
    const expectedHeight = claim.baseHeight + index + 1;
    if (jHeight !== expectedHeight) {
      throw new Error(`J_PREFIX_HEADER_ORDER_MISMATCH:${jHeight}:${expectedHeight}`);
    }
    return { jHeight, jBlockHash: normalizeHash(header.jBlockHash, 'HEADER_HASH') };
  });
  if (claim.scannedThroughHeight > claim.baseHeight && headers.at(-1)?.jBlockHash !== claim.tipBlockHash) {
    throw new Error('J_PREFIX_TIP_HEADER_MISMATCH');
  }
  for (const block of claim.blocks) {
    const header = headers[block.blockNumber - claim.baseHeight - 1];
    if (!header || header.jBlockHash !== block.blockHash) {
      throw new Error(`J_PREFIX_EVENT_HEADER_MISMATCH:${block.blockNumber}`);
    }
  }
  const signature = normalizeText(raw.signature);
  if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new Error('J_PREFIX_SIGNATURE_INVALID');
  return { headers, signature };
};

export const normalizeJPrefixAttestation = (state: EntityState, raw: JPrefixAttestation): JPrefixAttestation => {
  if (raw.version !== 1) throw new Error(`J_PREFIX_VERSION_UNSUPPORTED:${String(raw.version)}`);
  const entityId = normalizeText(raw.entityId);
  if (entityId !== normalizeText(state.entityId)) {
    throw new Error(`J_PREFIX_ENTITY_MISMATCH:${entityId}:${normalizeText(state.entityId)}`);
  }
  const targetEntityHeight = normalizeHeight(raw.targetEntityHeight, 'TARGET_ENTITY_HEIGHT');
  if (targetEntityHeight !== state.height + 1) {
    throw new Error(`J_PREFIX_TARGET_HEIGHT_MISMATCH:${targetEntityHeight}:${state.height + 1}`);
  }
  const parentFrameHash = normalizeText(raw.parentFrameHash);
  const expectedParent = normalizeText(currentParentFrameHash(state));
  if (parentFrameHash !== expectedParent) {
    throw new Error(`J_PREFIX_PARENT_MISMATCH:${parentFrameHash}:${expectedParent}`);
  }
  const validatorId = normalizeText(raw.validatorId);
  if (!validatorId) throw new Error('J_PREFIX_VALIDATOR_MISSING');
  const claim = normalizeClaim(state, raw);
  const { headers, signature } = normalizeAttestationClaimEvidence(raw, claim, state.config.validators);
  return {
    version: 1,
    entityId,
    targetEntityHeight,
    parentFrameHash,
    validatorId,
    ...claim,
    headers,
    signature,
  };
};

const assertBoardSigner = (config: ConsensusConfig, validatorId: string): void => {
  const matches = config.validators.filter(candidate => normalizeText(candidate) === validatorId);
  if (matches.length !== 1) throw new Error(`J_PREFIX_UNKNOWN_OR_DUPLICATE_VALIDATOR:${validatorId}`);
  const shares = Object.entries(config.shares)
    .filter(([candidate]) => normalizeText(candidate) === validatorId)
    .map(([, value]) => value);
  if (shares.length !== 1 || typeof shares[0] !== 'bigint' || shares[0] <= 0n) {
    throw new Error(`J_PREFIX_INVALID_VALIDATOR_SHARES:${validatorId}`);
  }
};

export type JPrefixAttestationTemporalDisposition = 'stale' | 'current' | 'future';

export const getJPrefixAttestationTemporalDisposition = (
  state: EntityState,
  raw: JPrefixAttestation,
): JPrefixAttestationTemporalDisposition => {
  const target = normalizeHeight(raw.targetEntityHeight, 'TARGET_ENTITY_HEIGHT');
  if (target < 1) throw new Error(`J_PREFIX_TARGET_ENTITY_HEIGHT_INVALID:${target}`);
  const expected = state.height + 1;
  return target < expected ? 'stale' : target > expected ? 'future' : 'current';
};

const findOutOfRoundAuthority = (
  authorityConfigs: readonly ConsensusConfig[],
  validatorId: string,
): ConsensusConfig | null =>
  authorityConfigs.find(config => {
    const validatorMatches = config.validators.filter(candidate => normalizeText(candidate) === validatorId);
    if (validatorMatches.length !== 1) return false;
    const shareMatches = Object.entries(config.shares)
      .filter(([candidate]) => normalizeText(candidate) === validatorId)
      .map(([, shares]) => shares);
    return shareMatches.length === 1 && typeof shareMatches[0] === 'bigint' && shareMatches[0] > 0n;
  }) ?? null;

/**
 * Authenticate a delayed or early vote without reinterpreting it against the
 * current Entity/J head. The full canonical body and signature are checked,
 * but no stale claim can mutate consensus state. Authority is deliberately
 * limited to the bounded configs already retained by this replica.
 */
export const verifyOutOfRoundJPrefixAttestation = (
  env: Env,
  state: EntityState,
  raw: JPrefixAttestation,
  authorityConfigs: readonly ConsensusConfig[],
): JPrefixAttestation => {
  const disposition = getJPrefixAttestationTemporalDisposition(state, raw);
  if (disposition === 'current') throw new Error('J_PREFIX_OUT_OF_ROUND_EXPECTED');
  if (raw.version !== 1) throw new Error(`J_PREFIX_VERSION_UNSUPPORTED:${String(raw.version)}`);
  const entityId = normalizeText(raw.entityId);
  if (entityId !== normalizeText(state.entityId)) {
    throw new Error(`J_PREFIX_ENTITY_MISMATCH:${entityId}:${normalizeText(state.entityId)}`);
  }
  const targetEntityHeight = normalizeHeight(raw.targetEntityHeight, 'TARGET_ENTITY_HEIGHT');
  const parentFrameHash = normalizeText(raw.parentFrameHash);
  if (targetEntityHeight === 1) {
    if (parentFrameHash !== 'genesis') {
      throw new Error(`J_PREFIX_PARENT_MISMATCH:${parentFrameHash}:genesis`);
    }
  } else {
    normalizeHash(parentFrameHash, 'PARENT_HASH');
  }
  const validatorId = normalizeText(raw.validatorId);
  if (!validatorId) throw new Error('J_PREFIX_VALIDATOR_MISSING');
  const authority = findOutOfRoundAuthority(authorityConfigs, validatorId);
  if (!authority) throw new Error(`J_PREFIX_OUT_OF_ROUND_AUTHORITY_MISSING:${validatorId}`);
  const claim = normalizeClaimEnvelope(getJEventJurisdictionRef(state.config.jurisdiction), raw);
  const { headers, signature } = normalizeAttestationClaimEvidence(raw, claim, authority.validators);
  const attestation: JPrefixAttestation = {
    version: 1,
    entityId,
    targetEntityHeight,
    parentFrameHash,
    validatorId,
    ...claim,
    headers,
    signature,
  };
  const { signature: _signature, ...unsigned } = attestation;
  if (!verifyAccountSignature(env, validatorId, hashJPrefixAttestation(unsigned), signature)) {
    throw new Error(`J_PREFIX_SIGNATURE_REJECTED:${validatorId}`);
  }
  return attestation;
};

export const verifyJPrefixAttestation = (env: Env, state: EntityState, raw: JPrefixAttestation): JPrefixAttestation => {
  const attestation = normalizeJPrefixAttestation(state, raw);
  assertBoardSigner(state.config, attestation.validatorId);
  const { signature, ...unsigned } = attestation;
  if (!verifyAccountSignature(env, attestation.validatorId, hashJPrefixAttestation(unsigned), signature)) {
    throw new Error(`J_PREFIX_SIGNATURE_REJECTED:${attestation.validatorId}`);
  }
  return attestation;
};

export const buildLocalJPrefixAttestation = (
  env: Env,
  replica: EntityReplica,
  history: ValidatorJHistory = replica.jHistory!,
): JPrefixAttestation | null => {
  if (!history) return null;
  if (history.scannedThroughHeight < replica.state.lastFinalizedJHeight) {
    throw new Error(
      `J_PREFIX_LOCAL_HISTORY_BEHIND:${history.scannedThroughHeight}:${replica.state.lastFinalizedJHeight}`,
    );
  }
  const claim = buildBudgetedLocalClaim(replica.state, history);
  if (!claim) return null;
  const unsigned: Omit<JPrefixAttestation, 'signature'> = {
    version: 1,
    entityId: normalizeText(replica.state.entityId),
    targetEntityHeight: replica.state.height + 1,
    parentFrameHash: normalizeText(currentParentFrameHash(replica.state)),
    validatorId: normalizeText(replica.signerId),
    ...claim,
    headers: buildValidatorJPrefixHeaders(replica.state, history, claim.scannedThroughHeight),
  };
  assertBoardSigner(replica.state.config, unsigned.validatorId);
  return { ...unsigned, signature: signAccountFrame(env, unsigned.validatorId, hashJPrefixAttestation(unsigned)) };
};

export const hasCurrentRoundJPrefixAttestation = (replica: EntityReplica): boolean => {
  const round = replica.jPrefixRound;
  if (!round) return false;
  return (
    round.targetEntityHeight === replica.state.height + 1 &&
    normalizeText(round.parentFrameHash) === normalizeText(currentParentFrameHash(replica.state)) &&
    normalizeText(round.jurisdictionRef) === getJEventJurisdictionRef(replica.state.config.jurisdiction) &&
    round.baseHeight === replica.state.lastFinalizedJHeight &&
    round.attestations.has(normalizeText(replica.signerId))
  );
};

const clipAttestation = (
  state: EntityState,
  attestation: JPrefixAttestation,
  scannedThroughHeight: number,
): JPrefixClaim => {
  if (scannedThroughHeight < attestation.baseHeight || scannedThroughHeight > attestation.scannedThroughHeight) {
    throw new Error(`J_PREFIX_CLIP_HEIGHT_INVALID:${scannedThroughHeight}`);
  }
  if (scannedThroughHeight === attestation.baseHeight) return buildCertifiedBaseClaim(state);
  const tip = attestation.headers[scannedThroughHeight - attestation.baseHeight - 1];
  if (!tip || tip.jHeight !== scannedThroughHeight) {
    throw new Error(`J_PREFIX_CLIP_HEADER_MISSING:${scannedThroughHeight}`);
  }
  const blocks = attestation.blocks
    .filter(block => block.blockNumber <= scannedThroughHeight)
    .map(block => structuredClone(block));
  return {
    jurisdictionRef: attestation.jurisdictionRef,
    baseHeight: attestation.baseHeight,
    scannedThroughHeight,
    tipBlockHash: tip.jBlockHash,
    eventHistoryRoot: foldJHistoryRoot(
      finalizedJHistoryRoot(state),
      blocks.map(block => ({
        jurisdictionRef: attestation.jurisdictionRef,
        jHeight: block.blockNumber,
        jBlockHash: block.blockHash,
        eventsHash: block.eventsHash,
        ...(block.disputeFinalizationEvidenceHash
          ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
          : {}),
      })),
    ),
    rangeHash: canonicalJEventRangeHash(attestation.jurisdictionRef, blocks),
    blocks,
  };
};

const claimKey = (claim: JPrefixClaim): string => encodeCanonicalEntityConsensusValue(claim);

export const calculateJPrefixQuorumPower = (config: ConsensusConfig, rawSigners: readonly string[]): bigint => {
  const signers = new Set<string>();
  let total = 0n;
  for (const rawSigner of rawSigners) {
    const signer = normalizeText(rawSigner);
    if (signers.has(signer)) throw new Error(`J_PREFIX_DUPLICATE_SIGNER:${rawSigner}`);
    signers.add(signer);
    assertBoardSigner(config, signer);
    const shares = Object.entries(config.shares).find(([candidate]) => normalizeText(candidate) === signer)![1];
    total += shares;
  }
  return total;
};

export type JPrefixSelection = {
  claim: JPrefixClaim;
  signerIds: string[];
};

export const selectHighestWeightedCommonJPrefix = (
  state: EntityState,
  attestations: ReadonlyMap<string, JPrefixAttestation>,
): JPrefixSelection | null => {
  if (attestations.size === 0) return null;
  const normalized = new Map<string, JPrefixAttestation>();
  for (const [rawKey, rawAttestation] of attestations) {
    const key = normalizeText(rawKey);
    const attestation = normalizeJPrefixAttestation(state, rawAttestation);
    if (key !== attestation.validatorId) throw new Error(`J_PREFIX_MAP_SIGNER_MISMATCH:${rawKey}`);
    if (normalized.has(key)) throw new Error(`J_PREFIX_DUPLICATE_SIGNER:${rawKey}`);
    assertBoardSigner(state.config, key);
    normalized.set(key, attestation);
  }
  const highestTip = Math.max(...Array.from(normalized.values(), head => head.scannedThroughHeight));
  // Before the first Entity-certified J anchor, the registration scan base is
  // still validator-local. A partial validator set must remain below quorum;
  // synthesizing a base certificate here makes the first multi-validator
  // observation fail before the remaining authenticated heads can arrive.
  const candidateFloor = state.jHistoryFinality ? state.lastFinalizedJHeight : state.lastFinalizedJHeight + 1;
  const candidates = Array.from(
    { length: Math.max(0, highestTip - candidateFloor + 1) },
    (_, index) => highestTip - index,
  );
  for (const height of candidates) {
    const groups = new Map<string, { claim: JPrefixClaim; signerIds: string[] }>();
    for (const [signerId, attestation] of normalized) {
      if (attestation.scannedThroughHeight < height) continue;
      const claim = clipAttestation(state, attestation, height);
      const key = claimKey(claim);
      const group = groups.get(key) ?? { claim, signerIds: [] };
      group.signerIds.push(signerId);
      groups.set(key, group);
    }
    const certified = Array.from(groups.values()).filter(
      group => calculateJPrefixQuorumPower(state.config, group.signerIds) >= state.config.threshold,
    );
    if (certified.length > 1) throw new Error(`J_PREFIX_CONFLICTING_QUORUMS:${height}`);
    if (certified.length === 1) {
      const selected = certified[0]!;
      selected.signerIds.sort(compareStableText);
      return selected;
    }
  }
  return null;
};

export const buildJPrefixCertificate = (
  state: EntityState,
  attestations: ReadonlyMap<string, JPrefixAttestation>,
): JPrefixCertificate | null => {
  const selection = selectHighestWeightedCommonJPrefix(state, attestations);
  if (!selection) return null;
  return {
    version: 1,
    entityId: normalizeText(state.entityId),
    targetEntityHeight: state.height + 1,
    parentFrameHash: normalizeText(currentParentFrameHash(state)),
    jurisdictionRef: selection.claim.jurisdictionRef,
    baseHeight: selection.claim.baseHeight,
    selected: structuredClone(selection.claim),
    attestations: new Map(
      Array.from(attestations.entries())
        .map(([signerId, attestation]) => [normalizeText(signerId), structuredClone(attestation)] as const)
        .sort(([left], [right]) => compareStableText(left, right)),
    ),
  };
};

export const verifyJPrefixCertificate = (
  env: Env,
  state: EntityState,
  certificate: JPrefixCertificate,
): JPrefixCertificate => {
  if (certificate.version !== 1) throw new Error('J_PREFIX_CERTIFICATE_VERSION_INVALID');
  if (!(certificate.attestations instanceof Map)) throw new Error('J_PREFIX_CERTIFICATE_ATTESTATIONS_INVALID');
  const verified = new Map<string, JPrefixAttestation>();
  for (const [rawSignerId, rawAttestation] of certificate.attestations) {
    const signerId = normalizeText(rawSignerId);
    if (verified.has(signerId)) throw new Error(`J_PREFIX_DUPLICATE_SIGNER:${rawSignerId}`);
    const attestation = verifyJPrefixAttestation(env, state, rawAttestation);
    if (attestation.validatorId !== signerId) throw new Error(`J_PREFIX_MAP_SIGNER_MISMATCH:${rawSignerId}`);
    verified.set(signerId, attestation);
  }
  const rebuilt = buildJPrefixCertificate(state, verified);
  if (!rebuilt) throw new Error('J_PREFIX_CERTIFICATE_QUORUM_MISSING');
  if (claimKey(rebuilt.selected) !== claimKey(normalizeClaim(state, certificate.selected))) {
    throw new Error('J_PREFIX_CERTIFICATE_NOT_HIGHEST_COMMON');
  }
  const expectedEnvelope = encodeCanonicalEntityConsensusValue({
    ...rebuilt,
    attestations: undefined,
  });
  const receivedEnvelope = encodeCanonicalEntityConsensusValue({
    ...certificate,
    entityId: normalizeText(certificate.entityId),
    parentFrameHash: normalizeText(certificate.parentFrameHash),
    jurisdictionRef: normalizeText(certificate.jurisdictionRef),
    attestations: undefined,
    selected: rebuilt.selected,
  });
  if (receivedEnvelope !== expectedEnvelope) throw new Error('J_PREFIX_CERTIFICATE_ROUND_MISMATCH');
  return { ...rebuilt, attestations: verified };
};

export const mergeJPrefixAttestations = (
  env: Env,
  state: EntityState,
  current: JPrefixRound | undefined,
  incoming: ReadonlyMap<string, JPrefixAttestation>,
): JPrefixRound => {
  const targetEntityHeight = state.height + 1;
  const parentFrameHash = normalizeText(currentParentFrameHash(state));
  const jurisdictionRef = getJEventJurisdictionRef(state.config.jurisdiction);
  const baseHeight = state.lastFinalizedJHeight;
  const expectedRound =
    current &&
    current.targetEntityHeight === targetEntityHeight &&
    normalizeText(current.parentFrameHash) === parentFrameHash &&
    normalizeText(current.jurisdictionRef) === jurisdictionRef &&
    current.baseHeight === baseHeight
      ? current
      : undefined;
  const attestations = new Map<string, JPrefixAttestation>(expectedRound?.attestations ?? []);
  const incomingSigners = new Set<string>();
  for (const [rawSignerId, rawAttestation] of incoming) {
    const signerId = normalizeText(rawSignerId);
    if (incomingSigners.has(signerId)) throw new Error(`J_PREFIX_DUPLICATE_SIGNER:${rawSignerId}`);
    incomingSigners.add(signerId);
    const attestation = verifyJPrefixAttestation(env, state, rawAttestation);
    if (attestation.validatorId !== signerId) throw new Error(`J_PREFIX_MAP_SIGNER_MISMATCH:${rawSignerId}`);
    const previous = attestations.get(signerId);
    if (!previous) {
      attestations.set(signerId, attestation);
      continue;
    }
    if (encodeCanonicalEntityConsensusValue(previous) === encodeCanonicalEntityConsensusValue(attestation)) continue;
    // In this minimal protocol the signed head is also the validator's vote for
    // the round. A later local scan is retained in jHistory and attested only
    // after this Entity height commits; signing two heads would authorize two
    // competing maximum-prefix certificates for the same parent.
    throw new Error(`J_PREFIX_ATTESTATION_EQUIVOCATION:${signerId}`);
  }
  const round: JPrefixRound = {
    targetEntityHeight,
    parentFrameHash,
    jurisdictionRef,
    baseHeight,
    attestations: new Map(Array.from(attestations.entries()).sort(([left], [right]) => compareStableText(left, right))),
  };
  const certificate = buildJPrefixCertificate(state, round.attestations);
  if (certificate) round.certificate = certificate;
  return round;
};

export const restoreJPrefixRound = (env: Env, state: EntityState, persisted: JPrefixRound): JPrefixRound => {
  if (!(persisted.attestations instanceof Map)) throw new Error('J_PREFIX_RESTORE_ATTESTATIONS_INVALID');
  const rebuilt = mergeJPrefixAttestations(env, state, undefined, persisted.attestations);
  const persistedEnvelope = encodeCanonicalEntityConsensusValue({
    targetEntityHeight: persisted.targetEntityHeight,
    parentFrameHash: normalizeText(persisted.parentFrameHash),
    jurisdictionRef: normalizeText(persisted.jurisdictionRef),
    baseHeight: persisted.baseHeight,
  });
  const rebuiltEnvelope = encodeCanonicalEntityConsensusValue({
    targetEntityHeight: rebuilt.targetEntityHeight,
    parentFrameHash: rebuilt.parentFrameHash,
    jurisdictionRef: rebuilt.jurisdictionRef,
    baseHeight: rebuilt.baseHeight,
  });
  if (persistedEnvelope !== rebuiltEnvelope) throw new Error('J_PREFIX_RESTORE_ROUND_MISMATCH');
  if (persisted.certificate) {
    const verified = verifyJPrefixCertificate(env, state, persisted.certificate);
    if (
      !rebuilt.certificate ||
      encodeCanonicalEntityConsensusValue(verified) !== encodeCanonicalEntityConsensusValue(rebuilt.certificate)
    ) {
      throw new Error('J_PREFIX_RESTORE_CERTIFICATE_MISMATCH');
    }
  }
  // A missing derived certificate is rebuildable; a conflicting persisted one
  // is corruption. This keeps restore deterministic without trusting metadata.
  return rebuilt;
};

const localClaimAtHeight = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
  height: number,
): JPrefixClaim => {
  if (!history || history.scannedThroughHeight < height) {
    throw new Error(`J_PREFIX_LOCAL_HISTORY_BEHIND:${history?.scannedThroughHeight ?? 0}:${height}`);
  }
  return buildUnsignedJEventRangeAtHeight(state, history, height) ?? buildBaseClaim(state, history);
};

export const assertJPrefixCertificateMatchesLocalHistory = (
  env: Env,
  state: EntityState,
  history: ValidatorJHistory | undefined,
  certificate: JPrefixCertificate,
): JPrefixCertificate => {
  const verified = verifyJPrefixCertificate(env, state, certificate);
  const local = localClaimAtHeight(state, history, verified.selected.scannedThroughHeight);
  if (claimKey(local) !== claimKey(verified.selected)) {
    throw new Error(`J_PREFIX_LOCAL_PREFIX_MISMATCH:${verified.selected.scannedThroughHeight}`);
  }
  return verified;
};

export const buildCertifiedJPrefixTx = (
  env: Env,
  replica: EntityReplica,
  certificate: JPrefixCertificate,
  proposerSignerId: string,
): Extract<EntityTx, { type: 'j_event' }> => {
  const verified = assertJPrefixCertificateMatchesLocalHistory(env, replica.state, replica.jHistory, certificate);
  const from = normalizeText(proposerSignerId);
  const digest = buildJEventRangeDigest({
    entityId: normalizeText(replica.state.entityId),
    signerId: from,
    ...verified.selected,
  });
  return {
    type: 'j_event',
    data: {
      from,
      signature: signAccountFrame(env, from, digest),
      observedAt: verified.selected.scannedThroughHeight,
      ...structuredClone(verified.selected),
    },
  };
};

export const hasPendingLocalJEvent = (state: EntityState, history: ValidatorJHistory | undefined): boolean =>
  Boolean(
    history &&
    Array.from(history.eventBlocks.keys()).some(
      height => height > state.lastFinalizedJHeight && height <= history.scannedThroughHeight,
    ),
  );

/**
 * Semantic J work that is already inside this validator's exact authenticated
 * prefix. A sparse future event remains a durable watcher obligation, but it
 * must not manufacture one empty Entity frame per intermediate header while
 * the watcher closes the gap.
 */
export const hasAttestablePendingLocalJEvent = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): boolean => {
  if (!history) return false;
  const attestableHeight = getLocalJPrefixAttestableHeight(state, history);
  if (attestableHeight === null) return false;
  return Array.from(history.eventBlocks.keys()).some(
    height => height > state.lastFinalizedJHeight && height <= attestableHeight,
  );
};

/**
 * Only semantic J work may create an otherwise-empty Entity frame. Header-only
 * scan progress stays validator-local and is certified by the next real Entity
 * input or hook. Chain liveness is transport evidence, not Entity consensus
 * state, so it must never manufacture financial history on its own.
 */
export const hasDueLocalJPrefixAdvance = (
  state: EntityState,
  history: ValidatorJHistory | undefined,
): boolean => hasAttestablePendingLocalJEvent(state, history);

/**
 * A validator that already signed the certified base cannot replace that vote
 * after learning a later J event without equivocating in the same Entity
 * round. A certificate selecting the common base may therefore roll one empty
 * frame so every validator can attest its latest head in the next round. The
 * validator's one signed head may be ahead of that common base, but it must be
 * included byte-for-byte in the certificate; no replacement vote is allowed.
 */
export const isFrozenBaseJPrefixRollAuthorized = (
  replica: Pick<EntityReplica, 'signerId' | 'state' | 'jHistory' | 'jPrefixRound'>,
  certificate: JPrefixCertificate | null | undefined,
): boolean => {
  if (!certificate || certificate.selected.scannedThroughHeight !== certificate.baseHeight) return false;
  const history = replica.jHistory;
  if (!hasDueLocalJPrefixAdvance(replica.state, history)) {
    return false;
  }
  const signerId = normalizeText(replica.signerId);
  const local = Array.from(replica.jPrefixRound?.attestations.entries() ?? []).find(
    ([rawSignerId]) => normalizeText(rawSignerId) === signerId,
  )?.[1];
  const certified = Array.from(certificate.attestations.entries()).find(
    ([rawSignerId]) => normalizeText(rawSignerId) === signerId,
  )?.[1];
  if (!local || !certified) return false;
  return encodeCanonicalEntityConsensusValue(local) === encodeCanonicalEntityConsensusValue(certified);
};

const isEmptyBaseJPrefixRollFrame = (certificate: JPrefixCertificate, txs: readonly EntityTx[]): boolean =>
  txs.length === 0 && certificate.selected.scannedThroughHeight === certificate.baseHeight;

export const assertFrameJPrefix = (
  env: Env,
  replica: Pick<EntityReplica, 'signerId' | 'state' | 'jHistory' | 'jPrefixRound'>,
  frame: Pick<
    import('../types').ProposedEntityFrame,
    'height' | 'parentFrameHash' | 'leader' | 'txs' | 'jPrefixCertificate'
  >,
): void => {
  const ranges = frame.txs.filter((tx): tx is Extract<EntityTx, { type: 'j_event' }> => tx.type === 'j_event');
  const locallyCertified = replica.jPrefixRound
    ? buildJPrefixCertificate(replica.state, replica.jPrefixRound.attestations)
    : null;
  if (!frame.jPrefixCertificate) {
    if (ranges.length > 0) throw new Error('J_PREFIX_CERTIFICATE_MISSING');
    if (entityRequiresJPrefixCertificate(replica.state)) {
      throw new Error('J_PREFIX_CERTIFICATE_REQUIRED_FOR_REGISTERED_ENTITY');
    }
    if (locallyCertified) throw new Error('J_PREFIX_STRONGER_LOCAL_CERTIFICATE');
    if (hasPendingLocalJEvent(replica.state, replica.jHistory)) {
      // Counterexample: a Byzantine active proposer can otherwise keep
      // committing ordinary frames forever while an honest validator has a
      // durable DisputeStarted at H+1. Absence is consensus data here.
      throw new Error('J_PREFIX_REQUIRED_LOCAL_EVENT');
    }
    return;
  }
  const certificate = assertJPrefixCertificateMatchesLocalHistory(
    env,
    replica.state,
    replica.jHistory,
    frame.jPrefixCertificate,
  );
  if (
    frame.height !== certificate.targetEntityHeight ||
    normalizeText(frame.parentFrameHash) !== certificate.parentFrameHash
  ) {
    throw new Error('J_PREFIX_FRAME_ROUND_MISMATCH');
  }
  const emptyBaseRollFrame = isEmptyBaseJPrefixRollFrame(certificate, frame.txs);
  if (
    locallyCertified &&
    locallyCertified.selected.scannedThroughHeight > certificate.selected.scannedThroughHeight &&
    !emptyBaseRollFrame
  ) {
    throw new Error('J_PREFIX_STRONGER_LOCAL_CERTIFICATE');
  }
  if (certificate.selected.scannedThroughHeight === certificate.baseHeight) {
    if (ranges.length !== 0) throw new Error(`J_PREFIX_RANGE_COUNT_INVALID:${ranges.length}`);
    const finalityDue = hasPendingLocalJEvent(replica.state, replica.jHistory);
    const emptyFrozenRoll = frame.txs.length === 0 && isFrozenBaseJPrefixRollAuthorized(replica, certificate);
    if (finalityDue && !emptyFrozenRoll && !emptyBaseRollFrame) {
      throw new Error('J_PREFIX_REQUIRED_LOCAL_EVENT');
    }
    return;
  }
  if (ranges.length !== 1) throw new Error(`J_PREFIX_RANGE_COUNT_INVALID:${ranges.length}`);
  const range = ranges[0]!.data;
  const receivedClaim: JPrefixClaim = {
    jurisdictionRef: range.jurisdictionRef,
    baseHeight: range.baseHeight,
    scannedThroughHeight: range.scannedThroughHeight,
    tipBlockHash: range.tipBlockHash,
    eventHistoryRoot: range.eventHistoryRoot,
    rangeHash: range.rangeHash,
    blocks: range.blocks,
  };
  const normalizedReceivedClaim = normalizeClaimEnvelope(
    getJEventJurisdictionRef(replica.state.config.jurisdiction),
    receivedClaim,
  );
  const reconciled = reconcileJEventRangeWithFinalizedState(replica.state, range);
  if (reconciled.kind === 'noop') throw new Error('J_PREFIX_FRAME_RANGE_STALE');
  const currentClaim: JPrefixClaim = {
    jurisdictionRef: normalizedReceivedClaim.jurisdictionRef,
    baseHeight: reconciled.baseHeight,
    scannedThroughHeight: reconciled.scannedThroughHeight,
    tipBlockHash: reconciled.tipBlockHash,
    eventHistoryRoot: reconciled.eventHistoryRoot,
    rangeHash: canonicalJEventRangeHash(normalizedReceivedClaim.jurisdictionRef, reconciled.blocks),
    blocks: reconciled.blocks,
  };
  if (claimKey(currentClaim) !== claimKey(certificate.selected)) {
    throw new Error('J_PREFIX_FRAME_RANGE_MISMATCH');
  }
  const proposerSignerId = normalizeText(frame.leader.proposerSignerId);
  if (normalizeText(range.from) !== proposerSignerId) throw new Error('J_PREFIX_RANGE_PROPOSER_MISMATCH');
  const digest = buildJEventRangeDigest({
    entityId: normalizeText(replica.state.entityId),
    signerId: proposerSignerId,
    ...normalizedReceivedClaim,
  });
  if (!verifyAccountSignature(env, proposerSignerId, digest, range.signature)) {
    throw new Error('J_PREFIX_RANGE_SIGNATURE_REJECTED');
  }
};
