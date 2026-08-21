import { countOp } from '../../../support/performance/op-counters';
import { keccakTextHash } from '../../../protocol/crypto/keccak-text';
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';

import type { CertifiedBoardAuthorityBinding, CertifiedBoardRecord } from '../../../types/entity-board-registry';
import type { ConsensusOutputOrigin, EntityTx } from '../../../types/entity-tx';
import type { EntityInput, EntityOutput, EntityState, HashToSign } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { verifyHankoForHash } from '../../../hanko/signing';
import {
  createCertifiedBoardAuthorityBinding,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveObserverCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';
import { assertCertifiedJEventIsAtomic, getAccountOnlyEntityTx } from './envelope';
import { assertCertifiedEntityOutputAuthorization } from '../../auth/authorization';
import { haltRuntimeFailure, rejectFailure, retryFailure } from '../../../protocol/errors/failure-taxonomy';
import { toUnixMs, unixMsToUnixSFloor } from '../../../protocol/units';

const assertCertifiableOutput = (output: EntityOutput, outputIndex: number): EntityTx[] => {
  if (
    !Array.isArray(output.entityTxs) ||
    output.entityTxs.length === 0 ||
    output.proposedFrame ||
    output.hashPrecommits ||
    output.leaderTimeoutVote
  ) {
    throw new Error(`CONSENSUS_OUTPUT_RECEIVER_DEDUP_UNAVAILABLE:index=${outputIndex}`);
  }
  if (
    output.entityTxs.some(
      tx =>
        tx.type === 'entityCommand' ||
        tx.type === 'consensusOutput' ||
        tx.type === 'reissueCertifiedOutput' ||
        tx.type === 'scheduledWake',
    )
  ) {
    throw new Error(`CONSENSUS_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:index=${outputIndex}`);
  }
  if (getAccountOnlyEntityTx(output.entityTxs)) {
    throw new Error(`CONSENSUS_OUTPUT_ACCOUNT_INPUT_FORBIDDEN:index=${outputIndex}`);
  }
  assertCertifiedJEventIsAtomic(output.entityTxs);
  return output.entityTxs;
};

/**
 * AccountInput already carries the bilateral Account Hankos that authorize its
 * only financial transition. It is committed by the source Entity frame,
 * released only after Runtime WAL commit, and committed verbatim by the target
 * Entity frame before `applyAccountInput`. Never reintroduce an outer output
 * certificate, sequence, receipt, or consumption proof for this path.
 */
export const getRawAccountOutputTx = (
  sourceEntityId: string,
  output: EntityOutput,
  outputIndex: number,
): Extract<EntityTx, { type: 'accountInput' }> | null => {
  const tx = getAccountOnlyEntityTx(output.entityTxs);
  if (!tx) return null;
  if (
    output.proposedFrame ||
    output.hashPrecommits ||
    output.hashPrecommitFrame ||
    output.leaderTimeoutVote ||
    output.localRuntimeProtocol
  ) {
    throw new Error(`ACCOUNT_OUTPUT_PROTOCOL_FIELDS_FORBIDDEN:index=${outputIndex}`);
  }
  if (output.certifiedOutputIdentity) {
    throw new Error(`ACCOUNT_OUTPUT_CERTIFIED_IDENTITY_FORBIDDEN:index=${outputIndex}`);
  }
  const source = sourceEntityId.trim().toLowerCase();
  const claimedSource = tx.data.fromEntityId.trim().toLowerCase();
  const target = output.entityId.trim().toLowerCase();
  const claimedTarget = tx.data.toEntityId.trim().toLowerCase();
  if (claimedSource !== source) {
    throw haltRuntimeFailure(
      'ACCOUNT_OUTPUT_SOURCE_MISMATCH',
      `ACCOUNT_OUTPUT_SOURCE_MISMATCH:index=${outputIndex}:` +
        `source=${source}:claimed=${claimedSource}:target=${claimedTarget}`,
    );
  }
  if (!target || claimedTarget !== target) {
    throw haltRuntimeFailure(
      'ACCOUNT_OUTPUT_TARGET_MISMATCH',
      `ACCOUNT_OUTPUT_TARGET_MISMATCH:index=${outputIndex}:route=${target || 'missing'}:claimed=${claimedTarget}`,
    );
  }
  return tx;
};

export const isLocalRuntimeProtocolOutput = (
  output: EntityOutput,
): output is EntityInput & { localRuntimeProtocol: 'cross-j' } =>
  output.localRuntimeProtocol === 'cross-j';

export type NonMutatingEntityWakeOutput = EntityInput & { entityTxs: [] };

/** Empty EntityInput wakes the already-addressed replica but carries no state mutation. */
export const isNonMutatingEntityWakeOutput = (output: EntityOutput): output is NonMutatingEntityWakeOutput =>
  Array.isArray(output.entityTxs) &&
  output.entityTxs.length === 0 &&
  output.proposedFrame === undefined &&
  output.hashPrecommits === undefined &&
  output.hashPrecommitFrame === undefined &&
  output.leaderTimeoutVote === undefined;

const buildConsensusOutputOrigin = (
  sourceEntityId: string,
  height: number,
  frameHash: string,
  outputIndex: number,
  semanticIdentity: Pick<ConsensusOutputOrigin, 'lane' | 'sequence' | 'semanticHash'>,
  boardAuthority?: CertifiedBoardAuthorityBinding,
): ConsensusOutputOrigin => ({
  sourceEntityId: sourceEntityId.toLowerCase(),
  lane: semanticIdentity.lane,
  sequence: semanticIdentity.sequence,
  semanticHash: semanticIdentity.semanticHash.toLowerCase(),
  height,
  frameHash: frameHash.toLowerCase(),
  outputIndex,
  ...(boardAuthority ? { boardAuthority: structuredClone(boardAuthority) } : {}),
});

export const buildConsensusOutputOriginForState = (
  sourceState: EntityState,
  env: EntityRuntimeContext,
  height: number,
  frameHash: string,
  outputIndex: number,
  semanticIdentity: Pick<ConsensusOutputOrigin, 'lane' | 'sequence' | 'semanticHash'>,
): ConsensusOutputOrigin =>
  buildConsensusOutputOrigin(
    sourceState.entityId,
    height,
    frameHash,
    outputIndex,
    semanticIdentity,
    createCertifiedBoardAuthorityBinding(sourceState, getCertifiedBoardNodeStore(env)) ?? undefined,
  );

const normalizeBytes32 = (value: unknown, code: string): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${code}:${normalized || 'missing'}`);
  return normalized;
};

export const normalizeConsensusOutputBoardAuthority = (
  value: unknown,
  sourceEntityId: string,
): CertifiedBoardAuthorityBinding | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_AUTHORITY_INVALID');
  }
  const raw = value as Record<string, unknown>;
  if (raw['version'] !== 1) throw new Error('CONSENSUS_OUTPUT_BOARD_AUTHORITY_VERSION_INVALID');
  const stackKey = normalizeBytes32(raw['stackKey'], 'CONSENSUS_OUTPUT_BOARD_STACK_INVALID');
  const recordValue = raw['record'];
  if (!recordValue || typeof recordValue !== 'object' || Array.isArray(recordValue)) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_RECORD_INVALID');
  }
  const rawRecord = recordValue as Record<string, unknown>;
  const entityId = normalizeBytes32(rawRecord['entityId'], 'CONSENSUS_OUTPUT_BOARD_ENTITY_INVALID');
  const normalizedSourceId = normalizeBytes32(sourceEntityId, 'CONSENSUS_OUTPUT_SOURCE_ENTITY_INVALID');
  if (entityId !== normalizedSourceId) {
    throw new Error(`CONSENSUS_OUTPUT_BOARD_RECORD_ENTITY_MISMATCH:${entityId}:${normalizedSourceId}`);
  }
  const recordStackKey = normalizeBytes32(rawRecord['stackKey'], 'CONSENSUS_OUTPUT_BOARD_RECORD_STACK_INVALID');
  if (recordStackKey !== stackKey) {
    throw new Error(`CONSENSUS_OUTPUT_BOARD_RECORD_STACK_MISMATCH:${recordStackKey}:${stackKey}`);
  }
  const activatedAtJHeight = Number(rawRecord['activatedAtJHeight']);
  if (!Number.isSafeInteger(activatedAtJHeight) || activatedAtJHeight < 1) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_RECORD_HEIGHT_INVALID');
  }
  const logIndex = Number(rawRecord['logIndex']);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0 || logIndex > 0xffff_ffff) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_RECORD_LOG_INDEX_INVALID');
  }
  const source = rawRecord['source'];
  if (source !== 'FoundationBootstrapped' && source !== 'EntityRegistered' && source !== 'BoardActivated') {
    throw new Error('CONSENSUS_OUTPUT_BOARD_RECORD_SOURCE_INVALID');
  }
  const previousBoardHash = normalizeBytes32(
    rawRecord['previousBoardHash'],
    'CONSENSUS_OUTPUT_BOARD_PREVIOUS_HASH_INVALID',
  );
  const previousBoardValidUntil = Number(rawRecord['previousBoardValidUntil']);
  if (!Number.isSafeInteger(previousBoardValidUntil) || previousBoardValidUntil < 0) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_PREVIOUS_EXPIRY_INVALID');
  }
  const isRotation = source === 'BoardActivated';
  const boardEpoch = Number(rawRecord['boardEpoch']);
  if (!Number.isSafeInteger(boardEpoch) || boardEpoch < 0 || isRotation !== boardEpoch > 0) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_EPOCH_INVALID');
  }
  if (isRotation !== (previousBoardHash !== `0x${'00'.repeat(32)}` && previousBoardValidUntil > 0)) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_PREVIOUS_AUTHORITY_INCONSISTENT');
  }
  return {
    version: 1,
    stackKey,
    record: {
      stackKey: recordStackKey,
      entityId,
      boardHash: normalizeBytes32(rawRecord['boardHash'], 'CONSENSUS_OUTPUT_BOARD_HASH_INVALID'),
      boardEpoch,
      previousBoardHash,
      previousBoardValidUntil,
      activatedAtJHeight,
      logIndex,
      blockHash: normalizeBytes32(rawRecord['blockHash'], 'CONSENSUS_OUTPUT_BOARD_BLOCK_HASH_INVALID'),
      transactionHash: normalizeBytes32(
        rawRecord['transactionHash'],
        'CONSENSUS_OUTPUT_BOARD_TRANSACTION_HASH_INVALID',
      ),
      source,
    },
  };
};

export const normalizeConsensusOutputOrigin = (value: unknown): ConsensusOutputOrigin => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CONSENSUS_OUTPUT_ORIGIN_INVALID');
  }
  const origin = value as Record<string, unknown>;
  const sourceEntityId = String(origin['sourceEntityId'] ?? '')
    .trim()
    .toLowerCase();
  const lane = String(origin['lane'] ?? '') as ConsensusOutputOrigin['lane'];
  const sequence = origin['sequence'];
  const semanticHash = String(origin['semanticHash'] ?? '')
    .trim()
    .toLowerCase();
  const height = Number(origin['height']);
  const frameHash = String(origin['frameHash'] ?? '')
    .trim()
    .toLowerCase();
  const outputIndex = Number(origin['outputIndex']);
  if (!sourceEntityId) throw new Error('CONSENSUS_OUTPUT_SOURCE_ENTITY_MISSING');
  if (lane !== 'generic') {
    throw new Error(`CONSENSUS_OUTPUT_LANE_INVALID:${lane || 'missing'}`);
  }
  if (typeof sequence !== 'bigint' || sequence < 0n || sequence > (1n << 64n) - 1n) {
    throw new Error(`CONSENSUS_OUTPUT_SEQUENCE_INVALID:${String(sequence)}`);
  }
  if (!/^0x[0-9a-f]{64}$/.test(semanticHash)) throw new Error('CONSENSUS_OUTPUT_SEMANTIC_HASH_INVALID');
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error('CONSENSUS_OUTPUT_HEIGHT_INVALID');
  if (!/^0x[0-9a-f]{64}$/.test(frameHash)) throw new Error('CONSENSUS_OUTPUT_FRAME_HASH_INVALID');
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw new Error('CONSENSUS_OUTPUT_INDEX_INVALID');
  }
  const boardAuthority = normalizeConsensusOutputBoardAuthority(origin['boardAuthority'], sourceEntityId);
  return {
    sourceEntityId,
    lane,
    sequence,
    semanticHash,
    height,
    frameHash,
    outputIndex,
    ...(boardAuthority ? { boardAuthority } : {}),
  };
};

export type ConsensusOutputBoardAuthorityResolution =
  | { kind: 'defer'; requiredJHeight: number; observerJHeight: number }
  | { kind: 'lazy' }
  | { kind: 'registered'; record: CertifiedBoardRecord };

const sameCertifiedBoardRecord = (left: CertifiedBoardRecord, right: CertifiedBoardRecord): boolean =>
  left.stackKey === right.stackKey &&
  left.entityId === right.entityId &&
  left.boardHash === right.boardHash &&
  left.boardEpoch === right.boardEpoch &&
  left.previousBoardHash === right.previousBoardHash &&
  left.previousBoardValidUntil === right.previousBoardValidUntil &&
  left.activatedAtJHeight === right.activatedAtJHeight &&
  left.logIndex === right.logIndex &&
  left.blockHash === right.blockHash &&
  left.transactionHash === right.transactionHash &&
  left.source === right.source;

const certifiedBoardRecordPrecedes = (older: CertifiedBoardRecord, newer: CertifiedBoardRecord): boolean =>
  older.activatedAtJHeight < newer.activatedAtJHeight ||
  (older.activatedAtJHeight === newer.activatedAtJHeight && older.logIndex < newer.logIndex);

const isImmediatePreviousBoardAuthorityLive = (
  bound: CertifiedBoardRecord,
  latest: CertifiedBoardRecord,
  observerTimestampMs: number,
): boolean => {
  if (!Number.isSafeInteger(observerTimestampMs) || observerTimestampMs < 0) {
    throw new Error(`CONSENSUS_OUTPUT_OBSERVER_TIMESTAMP_INVALID:${observerTimestampMs}`);
  }
  return (
    latest.source === 'BoardActivated' &&
    certifiedBoardRecordPrecedes(bound, latest) &&
    bound.boardEpoch + 1 === latest.boardEpoch &&
    bound.boardHash === latest.previousBoardHash &&
    unixMsToUnixSFloor(toUnixMs(observerTimestampMs)) < latest.previousBoardValidUntil
  );
};

/** Compare the complete bound record with the receiver's current local authority. */
export const resolveConsensusOutputBoardAuthority = (
  origin: ConsensusOutputOrigin,
  observerState: EntityState,
  env: EntityRuntimeContext,
): ConsensusOutputBoardAuthorityResolution => {
  const binding = origin.boardAuthority;
  const store = getCertifiedBoardNodeStore(env);
  if (!binding) {
    let registered: CertifiedBoardRecord | null;
    try {
      registered = resolveObserverCertifiedBoardRecord(observerState, store, origin.sourceEntityId);
    } catch (error) {
      throw haltRuntimeFailure('CONSENSUS_OUTPUT_BOARD_RESOLUTION_FAILED', undefined, error);
    }
    if (registered) {
      throw new Error(`CONSENSUS_OUTPUT_BOARD_AUTHORITY_MISSING:${origin.sourceEntityId}`);
    }
    return { kind: 'lazy' };
  }
  const jurisdiction = observerState.config.jurisdiction;
  if (!jurisdiction) throw new Error('CONSENSUS_OUTPUT_OBSERVER_JURISDICTION_MISSING');
  const expectedStackKey = getCertifiedBoardStackKey(jurisdiction);
  if (binding.stackKey !== expectedStackKey) {
    throw new Error(`CONSENSUS_OUTPUT_BOARD_STACK_MISMATCH:${binding.stackKey}:${expectedStackKey}`);
  }
  const observerJHeight = Number(observerState.lastFinalizedJHeight || 0);
  if (observerJHeight < binding.record.activatedAtJHeight) {
    return {
      kind: 'defer',
      requiredJHeight: binding.record.activatedAtJHeight,
      observerJHeight,
    };
  }
  let latestRecord: CertifiedBoardRecord | null;
  try {
    latestRecord = resolveObserverCertifiedBoardRecord(observerState, store, origin.sourceEntityId);
  } catch (error) {
    throw haltRuntimeFailure('CONSENSUS_OUTPUT_BOARD_RESOLUTION_FAILED', undefined, error);
  }
  if (!latestRecord) {
    throw new Error(`CONSENSUS_OUTPUT_LATEST_BOARD_MEMBERSHIP_MISSING:${origin.sourceEntityId}`);
  }
  if (!sameCertifiedBoardRecord(latestRecord, binding.record)) {
    // DESIGN INVARIANT — a rotation must not repudiate bilateral state already
    // signed by the retired board. Only the immediate previous board remains
    // historical Account evidence for the exclusive seven-day window. It does
    // not regain processBatch, settlement, governance, or watchtower authority;
    // those paths remain current-board-only. Bind grace to the receiver's
    // certified latest record and deterministic Entity time, never peer claims.
    // Regression: registered-board-authority.test.ts / BoardRotationGrace.test.ts.
    if (isImmediatePreviousBoardAuthorityLive(binding.record, latestRecord, observerState.timestamp)) {
      return { kind: 'registered', record: latestRecord };
    }
    if (certifiedBoardRecordPrecedes(binding.record, latestRecord)) {
      throw new Error(
        `CONSENSUS_OUTPUT_BOARD_AUTHORITY_STALE:source=${origin.sourceEntityId}:` +
          `bound=${binding.record.activatedAtJHeight}:${binding.record.logIndex}:${binding.record.boardHash}:` +
          `latest=${latestRecord.activatedAtJHeight}:${latestRecord.logIndex}:${latestRecord.boardHash}`,
      );
    }
    throw new Error(
      `CONSENSUS_OUTPUT_BOARD_RECORD_CONFLICT:source=${origin.sourceEntityId}:` +
        `bound=${binding.record.activatedAtJHeight}:${binding.record.logIndex}:${binding.record.boardHash}:` +
        `local=${latestRecord.activatedAtJHeight}:${latestRecord.logIndex}:${latestRecord.boardHash}`,
    );
  }
  return { kind: 'registered', record: latestRecord };
};

const canonicalCertifiedEntityTxs = (entityTxs: EntityTx[]): unknown[] => {
  countOp('certified.canonicalCertifiedEntityTxs');
  return structuredClone(entityTxs);
};

const computeCertifiedEntityOutputSemanticHash = (
  sourceEntityId: string,
  targetEntityId: string,
  lane: ConsensusOutputOrigin['lane'],
  sequence: bigint,
  entityTxs: EntityTx[],
): string => computeCertifiedEntityOutputSemanticHashFromCanonical(
  sourceEntityId,
  targetEntityId,
  lane,
  sequence,
  canonicalCertifiedEntityTxs(entityTxs),
);

const computeCertifiedEntityOutputSemanticHashFromCanonical = (
  sourceEntityId: string,
  targetEntityId: string,
  lane: ConsensusOutputOrigin['lane'],
  sequence: bigint,
  canonicalTxs: unknown[],
): string =>
  keccakTextHash(
    encodeCanonicalConsensusValue({
      version: 'xln:certified-entity-output-semantic:v2',
      sourceEntityId: sourceEntityId.toLowerCase(),
      targetEntityId: targetEntityId.toLowerCase(),
      lane,
      sequence,
      entityTxs: canonicalTxs,
    }),
  );

export const hashCertifiedEntityOutputSemantic = (
  sourceEntityId: string,
  targetEntityId: string,
  lane: ConsensusOutputOrigin['lane'],
  sequence: bigint,
  entityTxs: EntityTx[],
): string => {
  countOp('certified.hashCertifiedEntityOutputSemantic');
  return computeCertifiedEntityOutputSemanticHash(sourceEntityId, targetEntityId, lane, sequence, entityTxs);
};

export const assertCertifiedOutputSemanticIdentity = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  entityTxs: EntityTx[],
  precomputedCanonicalTxs?: unknown[],
): string => {
  countOp('certified.assertCertifiedOutputSemanticIdentity');
  if (getAccountOnlyEntityTx(entityTxs)) {
    throw rejectFailure('CONSENSUS_OUTPUT_ACCOUNT_INPUT_FORBIDDEN');
  }
  if (origin.lane !== 'generic') {
    throw rejectFailure(
      'CONSENSUS_OUTPUT_GENERIC_LANE_INVALID',
      `CONSENSUS_OUTPUT_GENERIC_LANE_INVALID:${origin.lane}`,
    );
  }
  const semanticHash = precomputedCanonicalTxs === undefined
    ? hashCertifiedEntityOutputSemantic(
        origin.sourceEntityId,
        targetEntityId,
        origin.lane,
        origin.sequence,
        entityTxs,
      )
    : computeCertifiedEntityOutputSemanticHashFromCanonical(
        origin.sourceEntityId,
        targetEntityId,
        origin.lane,
        origin.sequence,
        precomputedCanonicalTxs,
      );
  if (semanticHash !== origin.semanticHash.toLowerCase()) {
    throw rejectFailure(
      'CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH',
      `CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH:${origin.sourceEntityId}:${origin.sequence}`,
    );
  }
  return semanticHash;
};

/**
 * Allocate generic source counters. AccountInput bypasses this entire outer
 * certification layer and relies on native Account consensus.
 * A pre-tagged generic output is a governance reissue and must match the exact
 * bounded last-issued source frontier.
 */
export const assignCertifiedOutputIdentities = (sourceState: EntityState, outputs: EntityOutput[]): EntityState => {
  const sourceEntityId = sourceState.entityId.toLowerCase();
  const sequences = new Map(sourceState.certifiedOutputSequences ?? []);
  let sequenceStateChanged = false;
  for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
    const output = outputs[outputIndex]!;
    if (isNonMutatingEntityWakeOutput(output)) continue;
    if (isLocalRuntimeProtocolOutput(output)) {
      if (output.certifiedOutputIdentity) {
        throw new Error(`RUNTIME_OUTPUT_CERTIFIED_IDENTITY_FORBIDDEN:index=${outputIndex}`);
      }
      continue;
    }
    if (getRawAccountOutputTx(sourceEntityId, output, outputIndex)) continue;
    const entityTxs = assertCertifiableOutput(output, outputIndex);
    const targetEntityId = output.entityId.toLowerCase();
    const supplied = output.certifiedOutputIdentity;
    if (supplied) {
      if (supplied.lane !== 'generic') {
        throw new Error(`CONSENSUS_OUTPUT_GENERIC_LANE_INVALID:index=${outputIndex}:${supplied.lane}`);
      }
      const canonicalTxs = canonicalCertifiedEntityTxs(entityTxs);
      countOp('certified.hashCertifiedEntityOutputSemantic');
      const semanticHash = computeCertifiedEntityOutputSemanticHashFromCanonical(
        sourceEntityId,
        targetEntityId,
        supplied.lane,
        supplied.sequence,
        canonicalTxs,
      );
      const frontier = sequences.get(targetEntityId);
      if (!frontier) throw new Error(`CONSENSUS_OUTPUT_REISSUE_FRONTIER_MISSING:${targetEntityId}`);
      if (
        supplied.sequence !== frontier.lastSequence ||
        supplied.semanticHash.toLowerCase() !== frontier.lastSemanticHash.toLowerCase() ||
        supplied.semanticHash.toLowerCase() !== semanticHash
      ) {
        throw new Error(`CONSENSUS_OUTPUT_REISSUE_IDENTITY_MISMATCH:${targetEntityId}`);
      }
      output.certifiedOutputIdentity = { lane: 'generic', sequence: supplied.sequence, semanticHash };
      continue;
    }

    const previous = sequences.get(targetEntityId);
    const sequence = (previous?.lastSequence ?? 0n) + 1n;
    const canonicalTxs = canonicalCertifiedEntityTxs(entityTxs);
    countOp('certified.hashCertifiedEntityOutputSemantic');
    const semanticHash = computeCertifiedEntityOutputSemanticHashFromCanonical(
      sourceEntityId,
      targetEntityId,
      'generic',
      sequence,
      canonicalTxs,
    );
    output.certifiedOutputIdentity = { lane: 'generic', sequence, semanticHash };
    sequences.set(targetEntityId, { lastSequence: sequence, lastSemanticHash: semanticHash });
    sequenceStateChanged = true;
  }
  return sequenceStateChanged ? { ...sourceState, certifiedOutputSequences: sequences } : sourceState;
};

const computeCertifiedEntityOutputHash = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  entityTxs: EntityTx[],
): string => computeCertifiedEntityOutputHashFromCanonical(
  origin,
  targetEntityId,
  canonicalCertifiedEntityTxs(entityTxs),
);

const computeCertifiedEntityOutputHashFromCanonical = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  canonicalTxs: unknown[],
): string =>
  keccakTextHash(
    encodeCanonicalConsensusValue({
      version: 'xln:certified-entity-output:v2',
      origin,
      targetEntityId: targetEntityId.toLowerCase(),
      entityTxs: canonicalTxs,
    }),
  );

export const hashCertifiedEntityOutput = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  entityTxs: EntityTx[],
): string => {
  countOp('certified.hashCertifiedEntityOutput');
  return computeCertifiedEntityOutputHash(origin, targetEntityId, entityTxs);
};

/** Validate generic semantic identity and derive the outer certificate hash. */
export const hashCertifiedEntityOutputAndAssertSemantic = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  entityTxs: EntityTx[],
): string => {
  const canonicalTxs = canonicalCertifiedEntityTxs(entityTxs);
  countOp('certified.hashCertifiedEntityOutputSemantic');
  assertCertifiedOutputSemanticIdentity(origin, targetEntityId, entityTxs, canonicalTxs);
  countOp('certified.hashCertifiedEntityOutput');
  return computeCertifiedEntityOutputHashFromCanonical(origin, targetEntityId, canonicalTxs);
};

export type VerifiedCertifiedEntityOutput = {
  origin: ConsensusOutputOrigin;
  targetEntityId: string;
  entityTxs: EntityTx[];
  outputHash: string;
};

/**
 * Verify a generic immutable source certificate. AccountInput is forbidden in
 * this envelope because native Account consensus is its sole authority.
 */
export const verifyCertifiedEntityOutput = async (
  env: EntityRuntimeContext,
  observerState: EntityState,
  tx: Extract<EntityTx, { type: 'consensusOutput' }>,
): Promise<VerifiedCertifiedEntityOutput> =>
  verifyCertifiedEntityOutputUnchecked(env, observerState, tx);

const verifyCertifiedEntityOutputUnchecked = async (
  env: EntityRuntimeContext,
  observerState: EntityState,
  tx: Extract<EntityTx, { type: 'consensusOutput' }>,
): Promise<VerifiedCertifiedEntityOutput> => {
  countOp('certified.verifyCertifiedEntityOutput');
  const origin = normalizeConsensusOutputOrigin(tx.data.origin);
  if (typeof tx.data.outputHanko !== 'string' || tx.data.outputHanko.length === 0) {
    throw rejectFailure('CONSENSUS_OUTPUT_HANKO_MISSING');
  }
  const targetEntityId = String(tx.data.targetEntityId ?? '')
    .trim()
    .toLowerCase();
  if (!targetEntityId) throw rejectFailure('CONSENSUS_OUTPUT_TARGET_ENTITY_MISSING');
  if (targetEntityId !== observerState.entityId.toLowerCase()) {
    throw rejectFailure(
      'CONSENSUS_OUTPUT_TARGET_ENTITY_MISMATCH',
      `CONSENSUS_OUTPUT_TARGET_ENTITY_MISMATCH:expected=${observerState.entityId.toLowerCase()}:` +
        `received=${targetEntityId}`,
    );
  }
  if (!Array.isArray(tx.data.entityTxs) || tx.data.entityTxs.length === 0) {
    throw rejectFailure('CONSENSUS_OUTPUT_ENTITY_TXS_MISSING');
  }
  if (
    tx.data.entityTxs.some(
      nested =>
        nested.type === 'accountInput' ||
        nested.type === 'entityCommand' ||
        nested.type === 'consensusOutput' ||
        nested.type === 'scheduledWake',
    )
  ) {
    throw rejectFailure('CONSENSUS_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN');
  }
  const entityTxs = tx.data.entityTxs;
  assertCertifiedEntityOutputAuthorization(origin.sourceEntityId, targetEntityId, entityTxs, observerState);
  // Both hashes walk the same canonicalized tx bodies; canonicalize once.
  const canonicalTxs = canonicalCertifiedEntityTxs(entityTxs);
  countOp('certified.hashCertifiedEntityOutput');
  const outputHash = computeCertifiedEntityOutputHashFromCanonical(origin, targetEntityId, canonicalTxs);
  assertCertifiedOutputSemanticIdentity(origin, targetEntityId, entityTxs, canonicalTxs);
  const authority = resolveConsensusOutputBoardAuthority(origin, observerState, env);
  if (authority.kind === 'defer') {
    throw retryFailure('CONSENSUS_OUTPUT_AUTHORITY_PREFIX_BEHIND',
      `CONSENSUS_OUTPUT_AUTHORITY_PREFIX_BEHIND:required=${authority.requiredJHeight}:` +
        `observer=${authority.observerJHeight}`,
    );
  }
  const registeredBoardHash = authority.kind === 'registered' ? authority.record.boardHash : undefined;
  const verified = await verifyHankoForHash(
    tx.data.outputHanko,
    outputHash,
    origin.sourceEntityId,
    env,
    {
      ...(registeredBoardHash ? { registeredBoardHash } : {}),
      observerState,
    },
  );
  if (!verified.valid) {
    throw rejectFailure(
      'CONSENSUS_OUTPUT_HANKO_INVALID',
      `CONSENSUS_OUTPUT_HANKO_INVALID:${origin.sourceEntityId}:${origin.height}:${origin.outputIndex}`,
    );
  }
  return { origin, targetEntityId, entityTxs, outputHash };
};

export const buildCertifiedEntityOutputHashes = (
  sourceState: EntityState,
  env: EntityRuntimeContext,
  height: number,
  frameHash: string,
  outputs: EntityOutput[],
): HashToSign[] =>
  outputs.flatMap((output, outputIndex) => {
  countOp('certified.buildCertifiedEntityOutputHashes');
    if (isNonMutatingEntityWakeOutput(output)) return [];
    if (isLocalRuntimeProtocolOutput(output)) return [];
    if (getRawAccountOutputTx(sourceState.entityId, output, outputIndex)) return [];
    const entityTxs = assertCertifiableOutput(output, outputIndex);
    const semanticIdentity = output.certifiedOutputIdentity;
    if (!semanticIdentity) throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_IDENTITY_MISSING:index=${outputIndex}`);
    // The semantic and certificate digests bind the same generic payload.
    const canonicalTxs = canonicalCertifiedEntityTxs(entityTxs);
    countOp('certified.hashCertifiedEntityOutputSemantic');
    const semanticHash = computeCertifiedEntityOutputSemanticHashFromCanonical(
      sourceState.entityId,
      output.entityId,
      semanticIdentity.lane,
      semanticIdentity.sequence,
      canonicalTxs,
    );
    if (semanticHash !== semanticIdentity.semanticHash.toLowerCase()) {
      throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH:index=${outputIndex}`);
    }
    const origin = buildConsensusOutputOriginForState(
      sourceState,
      env,
      height,
      frameHash,
      outputIndex,
      semanticIdentity,
    );
    countOp('certified.hashCertifiedEntityOutput');
    const outputHash = computeCertifiedEntityOutputHashFromCanonical(
      origin,
      output.entityId,
      canonicalTxs,
    );
    return [
      {
        hash: outputHash,
        type: 'entityOutput',
        context: `entity-output:${height}:${outputIndex}`,
      },
    ];
  });
