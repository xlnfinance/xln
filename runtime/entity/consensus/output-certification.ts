import { keccak256, toUtf8Bytes } from 'ethers';

import type {
  AccountInput,
  CertifiedBoardAuthorityBinding,
  CertifiedBoardRecord,
  ConsensusOutputOrigin,
  EntityInput,
  EntityTx,
  Env,
  HashToSign,
} from '../../types';
import { cloneAccountInputWithoutPostCommitHankos } from './hanko-witness';
import { encodeCanonicalEntityConsensusValue } from './state-root';
import {
  accountInputAck,
  accountInputBoardReseal,
  accountInputDisputeSeal,
  accountInputProposal,
} from '../../account/consensus/flush';
import { verifyHankoForHash } from '../../hanko/signing';
import type { EntityState } from '../../types';
import {
  createCertifiedBoardAuthorityBinding,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  resolveObserverCertifiedBoardHash,
  resolveObserverCertifiedBoardRecord,
} from '../../jurisdiction/board-registry';
import { LIMITS } from '../../constants';
import { assertReliableCertifiedPayloadIsAtomic } from './output-envelope';
import { assertCertifiedEntityOutputAuthorization } from '../authorization';

const assertCertifiableOutput = (output: EntityInput, outputIndex: number): EntityTx[] => {
  if (
    !Array.isArray(output.entityTxs) ||
    output.entityTxs.length === 0 ||
    output.proposedFrame ||
    output.hashPrecommits ||
    output.leaderTimeoutVote
  ) {
    throw new Error(`CONSENSUS_OUTPUT_RECEIVER_DEDUP_UNAVAILABLE:index=${outputIndex}`);
  }
  if (output.entityTxs.some(tx =>
    tx.type === 'entityCommand' ||
    tx.type === 'consensusOutput' ||
    tx.type === 'reissueCertifiedOutput' ||
    tx.type === 'scheduledWake')) {
    throw new Error(`CONSENSUS_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:index=${outputIndex}`);
  }
  assertReliableCertifiedPayloadIsAtomic(output.entityTxs);
  return output.entityTxs;
};

export const isLocalRuntimeProtocolOutput = (output: EntityInput): boolean =>
  output.localRuntimeProtocol === 'cross-j';

export type NonMutatingEntityWakeOutput = EntityInput & { entityTxs: [] };

/** Empty EntityInput wakes the already-addressed replica but carries no state mutation. */
export const isNonMutatingEntityWakeOutput = (
  output: EntityInput,
): output is NonMutatingEntityWakeOutput =>
  Array.isArray(output.entityTxs) &&
  output.entityTxs.length === 0 &&
  output.proposedFrame === undefined &&
  output.hashPrecommits === undefined &&
  output.hashPrecommitFrame === undefined &&
  output.leaderTimeoutVote === undefined;

export const buildConsensusOutputOrigin = (
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
  env: Env,
  height: number,
  frameHash: string,
  outputIndex: number,
  semanticIdentity: Pick<ConsensusOutputOrigin, 'lane' | 'sequence' | 'semanticHash'>,
): ConsensusOutputOrigin => buildConsensusOutputOrigin(
  sourceState.entityId,
  height,
  frameHash,
  outputIndex,
  semanticIdentity,
  createCertifiedBoardAuthorityBinding(sourceState, getCertifiedBoardNodeStore(env)) ?? undefined,
);

const normalizeBytes32 = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
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
  if (raw['version'] !== 4) throw new Error('CONSENSUS_OUTPUT_BOARD_AUTHORITY_VERSION_INVALID');
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
  if (!Number.isSafeInteger(boardEpoch) || boardEpoch < 0 || isRotation !== (boardEpoch > 0)) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_EPOCH_INVALID');
  }
  if (isRotation !== (previousBoardHash !== `0x${'00'.repeat(32)}` && previousBoardValidUntil > 0)) {
    throw new Error('CONSENSUS_OUTPUT_BOARD_PREVIOUS_AUTHORITY_INCONSISTENT');
  }
  return {
    version: 4,
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
  if (
    lane !== 'generic' &&
    lane !== 'account-frame' &&
    lane !== 'account-ack' &&
    lane !== 'account-dispute' &&
    lane !== 'account-settlement'
  ) {
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

const sameCertifiedBoardRecord = (
  left: CertifiedBoardRecord,
  right: CertifiedBoardRecord,
): boolean =>
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

const certifiedBoardRecordPrecedes = (
  older: CertifiedBoardRecord,
  newer: CertifiedBoardRecord,
): boolean =>
  older.activatedAtJHeight < newer.activatedAtJHeight ||
  (
    older.activatedAtJHeight === newer.activatedAtJHeight &&
    older.logIndex < newer.logIndex
  );

const isImmediatePreviousBoardAuthorityLive = (
  bound: CertifiedBoardRecord,
  latest: CertifiedBoardRecord,
  observerTimestampMs: number,
): boolean => {
  if (!Number.isSafeInteger(observerTimestampMs) || observerTimestampMs < 0) {
    throw new Error(`CONSENSUS_OUTPUT_OBSERVER_TIMESTAMP_INVALID:${observerTimestampMs}`);
  }
  return latest.source === 'BoardActivated' &&
    certifiedBoardRecordPrecedes(bound, latest) &&
    bound.boardEpoch + 1 === latest.boardEpoch &&
    bound.boardHash === latest.previousBoardHash &&
    Math.floor(observerTimestampMs / 1_000) < latest.previousBoardValidUntil;
};

/** Compare the complete bound record with the receiver's current local authority. */
export const resolveConsensusOutputBoardAuthority = (
  origin: ConsensusOutputOrigin,
  observerState: EntityState,
  env: Env,
): ConsensusOutputBoardAuthorityResolution => {
  const binding = origin.boardAuthority;
  const store = getCertifiedBoardNodeStore(env);
  if (!binding) {
    if (resolveObserverCertifiedBoardRecord(observerState, store, origin.sourceEntityId)) {
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
  const latestRecord = resolveObserverCertifiedBoardRecord(observerState, store, origin.sourceEntityId);
  if (!latestRecord) {
    throw new Error(`CONSENSUS_OUTPUT_LATEST_BOARD_MEMBERSHIP_MISSING:${origin.sourceEntityId}`);
  }
  if (!sameCertifiedBoardRecord(latestRecord, binding.record)) {
    // A rotation does not instantly strand already-certified bilateral
    // Account traffic. EntityProvider keeps exactly the immediate previous
    // board live for the same exclusive grace boundary. Bind acceptance to
    // the receiver's certified latest record and deterministic Entity time;
    // never trust expiry or current authority supplied by the peer output.
    if (isImmediatePreviousBoardAuthorityLive(binding.record, latestRecord, observerState.timestamp)) {
      return { kind: 'registered', record: latestRecord };
    }
    if (
      certifiedBoardRecordPrecedes(binding.record, latestRecord)
    ) {
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

/**
 * Quorum Hankos are produced from the same signature manifest as the output
 * certificate, so including them in this digest would be circular. Remove only
 * those independently-verifiable witnesses; every routing field and unsigned
 * Account payload remains byte-for-byte bound by the output quorum.
 */
const canonicalCertifiedEntityTxs = (entityTxs: EntityTx[]): EntityTx[] => {
  const canonical = structuredClone(entityTxs);
  return canonical.map(tx => tx.type === 'accountInput'
    ? { ...tx, data: cloneAccountInputWithoutPostCommitHankos(tx.data) }
    : tx);
};

const accountInputLaneAndSequence = (
  input: AccountInput,
): Pick<ConsensusOutputOrigin, 'lane' | 'sequence'> => {
  const proposal = accountInputProposal(input);
  const ack = accountInputAck(input);
  if (proposal) {
    const sequence = BigInt(proposal.frame.height);
    if (sequence < 1n) throw new Error(`CONSENSUS_OUTPUT_ACCOUNT_FRAME_SEQUENCE_INVALID:${sequence}`);
    return { lane: 'account-frame', sequence };
  }
  if (ack) {
    const sequence = BigInt(ack.height);
    if (sequence < 1n) throw new Error(`CONSENSUS_OUTPUT_ACCOUNT_ACK_SEQUENCE_INVALID:${sequence}`);
    // A simultaneous bilateral race can make one Entity emit proposal H and,
    // after losing that race, ACK H for the peer's frame. They are distinct
    // certified effects even though the native Account height is identical.
    // Keeping ACK-only traffic in its own sparse lane preserves the useful
    // Account-height sequence without falsely classifying the pair as source
    // equivocation. A batched ACK + proposal belongs to the proposal lane;
    // the full payload remains bound by semanticHash.
    return { lane: 'account-ack', sequence };
  }
  if (input.kind === 'dispute') {
    const sequence = BigInt(input.disputeSeal.proofNonce);
    if (sequence < 0n) throw new Error(`CONSENSUS_OUTPUT_ACCOUNT_DISPUTE_SEQUENCE_INVALID:${sequence}`);
    return { lane: 'account-dispute', sequence };
  }
  if (input.kind === 'settle') {
    const rawSequence = input.settleAction.nonceAtSign ?? input.settleAction.version;
    if (!Number.isSafeInteger(rawSequence) || Number(rawSequence) < 0) {
      throw new Error(`CONSENSUS_OUTPUT_ACCOUNT_SETTLEMENT_SEQUENCE_INVALID:${String(rawSequence)}`);
    }
    return { lane: 'account-settlement', sequence: BigInt(rawSequence!) };
  }
  throw new Error(`CONSENSUS_OUTPUT_ACCOUNT_LANE_INVALID:${String((input as { kind?: unknown }).kind)}`);
};

const nativeOutputIdentity = (
  entityTxs: EntityTx[],
): Pick<ConsensusOutputOrigin, 'lane' | 'sequence'> | null => {
  const native = entityTxs.flatMap((tx) => tx.type === 'accountInput' && tx.data.kind !== 'board_reseal'
    ? [accountInputLaneAndSequence(tx.data)]
    : []);
  if (native.length === 0) return null;
  const first = native[0]!;
  if (native.some((entry) => entry.lane !== first.lane || entry.sequence !== first.sequence)) {
    throw new Error('CONSENSUS_OUTPUT_ACCOUNT_SEQUENCE_AMBIGUOUS');
  }
  return first;
};

export const hashCertifiedEntityOutputSemantic = (
  sourceEntityId: string,
  targetEntityId: string,
  lane: ConsensusOutputOrigin['lane'],
  sequence: bigint,
  entityTxs: EntityTx[],
): string => keccak256(toUtf8Bytes(encodeCanonicalEntityConsensusValue({
  version: 'xln:certified-entity-output-semantic:v1',
  sourceEntityId: sourceEntityId.toLowerCase(),
  targetEntityId: targetEntityId.toLowerCase(),
  lane,
  sequence,
  entityTxs: canonicalCertifiedEntityTxs(entityTxs),
})));

export const assertCertifiedOutputSemanticIdentity = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  entityTxs: EntityTx[],
): string => {
  const native = nativeOutputIdentity(entityTxs);
  if (native) {
    if (origin.lane !== native.lane || origin.sequence !== native.sequence) {
      throw new Error(
        `CONSENSUS_OUTPUT_NATIVE_IDENTITY_MISMATCH:${origin.lane}:${origin.sequence}:` +
        `${native.lane}:${native.sequence}`,
      );
    }
  } else if (origin.lane !== 'generic') {
    throw new Error(`CONSENSUS_OUTPUT_GENERIC_LANE_INVALID:${origin.lane}`);
  }
  const semanticHash = hashCertifiedEntityOutputSemantic(
    origin.sourceEntityId,
    targetEntityId,
    origin.lane,
    origin.sequence,
    entityTxs,
  );
  if (semanticHash !== origin.semanticHash.toLowerCase()) {
    throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH:${origin.sourceEntityId}:${origin.sequence}`);
  }
  return semanticHash;
};

/**
 * Allocate only generic source counters. Account lanes reuse their native
 * frame/proof/settlement nonce and therefore never create a parallel counter.
 * A pre-tagged generic output is a governance reissue and must match the exact
 * bounded last-issued source frontier.
 */
export const assignCertifiedOutputIdentities = (
  sourceState: EntityState,
  outputs: EntityInput[],
): EntityState => {
  const sourceEntityId = sourceState.entityId.toLowerCase();
  const sequences = new Map(sourceState.certifiedOutputSequences ?? []);
  if (sequences.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
    throw new Error(
      `CONSENSUS_OUTPUT_SOURCE_RELATIONSHIP_LIMIT_EXCEEDED:${sequences.size}:${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
    );
  }
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
    const entityTxs = assertCertifiableOutput(output, outputIndex);
    const targetEntityId = output.entityId.toLowerCase();
    const native = nativeOutputIdentity(entityTxs);
    const supplied = output.certifiedOutputIdentity;
    if (native) {
      const semanticHash = hashCertifiedEntityOutputSemantic(
        sourceEntityId,
        targetEntityId,
        native.lane,
        native.sequence,
        entityTxs,
      );
      if (supplied && (
        supplied.lane !== native.lane ||
        supplied.sequence !== native.sequence ||
        supplied.semanticHash.toLowerCase() !== semanticHash
      )) {
        throw new Error(`CONSENSUS_OUTPUT_NATIVE_IDENTITY_MISMATCH:index=${outputIndex}`);
      }
      output.certifiedOutputIdentity = { ...native, semanticHash };
      continue;
    }

    if (supplied) {
      if (supplied.lane !== 'generic') {
        throw new Error(`CONSENSUS_OUTPUT_GENERIC_LANE_INVALID:index=${outputIndex}:${supplied.lane}`);
      }
      const semanticHash = hashCertifiedEntityOutputSemantic(
        sourceEntityId,
        targetEntityId,
        supplied.lane,
        supplied.sequence,
        entityTxs,
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
    if (!previous && sequences.size >= LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
      throw new Error(
        `CONSENSUS_OUTPUT_SOURCE_RELATIONSHIP_LIMIT_EXCEEDED:${sequences.size}:${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
      );
    }
    const sequence = (previous?.lastSequence ?? 0n) + 1n;
    const semanticHash = hashCertifiedEntityOutputSemantic(
      sourceEntityId,
      targetEntityId,
      'generic',
      sequence,
      entityTxs,
    );
    output.certifiedOutputIdentity = { lane: 'generic', sequence, semanticHash };
    sequences.set(targetEntityId, { lastSequence: sequence, lastSemanticHash: semanticHash });
    sequenceStateChanged = true;
  }
  return sequenceStateChanged ? { ...sourceState, certifiedOutputSequences: sequences } : sourceState;
};

type OutputWitness = { context: string; hash: string; hanko: string };

const requiredWitness = (
  context: string,
  hash: string | undefined,
  hanko: string | undefined,
): OutputWitness => {
  if (!hash) throw new Error(`CONSENSUS_OUTPUT_WITNESS_HASH_MISSING:${context}`);
  if (!hanko) throw new Error(`CONSENSUS_OUTPUT_WITNESS_HANKO_MISSING:${context}:${hash}`);
  return { context, hash, hanko };
};

const collectAccountInputWitnesses = (input: AccountInput): OutputWitness[] => {
  const witnesses: OutputWitness[] = [];
  const ack = accountInputAck(input);
  if (ack) witnesses.push(requiredWitness('ack-frame', ack.frameHash, ack.frameHanko));
  const reseal = accountInputBoardReseal(input);
  if (reseal) witnesses.push(requiredWitness('board-reseal-frame', reseal.frameHash, reseal.frameHanko));
  const proposal = accountInputProposal(input);
  if (proposal) witnesses.push(requiredWitness('proposal-frame', proposal.frame.stateHash, proposal.frameHanko));
  for (const [context, seal] of [
    ['ack-dispute', ack?.disputeSeal],
    ['proposal-dispute', proposal?.disputeSeal],
    ['direct-dispute', accountInputDisputeSeal(input)],
  ] as const) {
    if (seal) witnesses.push(requiredWitness(context, seal.hash, seal.hanko));
  }
  if (input.kind === 'settle' && input.settleAction.type === 'approve') {
    witnesses.push(requiredWitness(
      'settlement',
      input.settleAction.settlementHash,
      input.settleAction.hanko,
    ));
  }
  return witnesses;
};

export const assertCertifiedEntityOutputWitnesses = async (
  entityTxs: EntityTx[],
  sourceEntityId: string,
  env: Env,
  observerState?: EntityState,
  authorityBoardHash?: string,
): Promise<void> => {
  const registeredBoardHash = authorityBoardHash ?? (observerState
    ? resolveObserverCertifiedBoardHash(observerState, getCertifiedBoardNodeStore(env), sourceEntityId)
    : null);
  const witnesses = entityTxs.flatMap(tx => tx.type === 'accountInput'
    ? collectAccountInputWitnesses(tx.data)
    : []);
  for (const witness of witnesses) {
    const verified = await verifyHankoForHash(
      witness.hanko,
      witness.hash,
      sourceEntityId,
      env,
      registeredBoardHash ? { registeredBoardHash } : undefined,
    );
    if (!verified.valid) {
      throw new Error(`CONSENSUS_OUTPUT_WITNESS_HANKO_INVALID:${witness.context}:${witness.hash}`);
    }
  }
};

export const hashCertifiedEntityOutput = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  entityTxs: EntityTx[],
): string => keccak256(toUtf8Bytes(encodeCanonicalEntityConsensusValue({
  version: 'xln:certified-entity-output:v3',
  origin,
  targetEntityId: targetEntityId.toLowerCase(),
  entityTxs: canonicalCertifiedEntityTxs(entityTxs),
})));

export type VerifiedCertifiedEntityOutput = {
  origin: ConsensusOutputOrigin;
  targetEntityId: string;
  entityTxs: EntityTx[];
  outputHash: string;
};

/**
 * Verify the immutable source certificate before any target-local hook reads
 * its nested Account ACK. Proposer enrichment and deterministic frame replay
 * deliberately share this boundary so neither path can trust transport bytes
 * that the other validators would later reject.
 */
export const verifyCertifiedEntityOutput = async (
  env: Env,
  observerState: EntityState,
  tx: Extract<EntityTx, { type: 'consensusOutput' }>,
): Promise<VerifiedCertifiedEntityOutput> => {
  const origin = normalizeConsensusOutputOrigin(tx.data.origin);
  if (typeof tx.data.outputHanko !== 'string' || tx.data.outputHanko.length === 0) {
    throw new Error('CONSENSUS_OUTPUT_HANKO_MISSING');
  }
  const targetEntityId = String(tx.data.targetEntityId ?? '')
    .trim()
    .toLowerCase();
  if (!targetEntityId) throw new Error('CONSENSUS_OUTPUT_TARGET_ENTITY_MISSING');
  if (targetEntityId !== observerState.entityId.toLowerCase()) {
    throw new Error(
      `CONSENSUS_OUTPUT_TARGET_ENTITY_MISMATCH:expected=${observerState.entityId.toLowerCase()}:` +
        `received=${targetEntityId}`,
    );
  }
  if (!Array.isArray(tx.data.entityTxs) || tx.data.entityTxs.length === 0) {
    throw new Error('CONSENSUS_OUTPUT_ENTITY_TXS_MISSING');
  }
  if (
    tx.data.entityTxs.some(
      nested => nested.type === 'entityCommand' || nested.type === 'consensusOutput' || nested.type === 'scheduledWake',
    )
  ) {
    throw new Error('CONSENSUS_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN');
  }
  const entityTxs = tx.data.entityTxs;
  assertCertifiedEntityOutputAuthorization(
    origin.sourceEntityId,
    targetEntityId,
    entityTxs,
    observerState,
  );
  const outputHash = hashCertifiedEntityOutput(origin, targetEntityId, entityTxs);
  assertCertifiedOutputSemanticIdentity(origin, targetEntityId, entityTxs);
  const authority = resolveConsensusOutputBoardAuthority(origin, observerState, env);
  if (authority.kind === 'defer') {
    throw new Error(
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
    registeredBoardHash ? { registeredBoardHash } : undefined,
  );
  if (!verified.valid) {
    throw new Error(`CONSENSUS_OUTPUT_HANKO_INVALID:${origin.sourceEntityId}:${origin.height}:${origin.outputIndex}`);
  }
  await assertCertifiedEntityOutputWitnesses(
    entityTxs,
    origin.sourceEntityId,
    env,
    observerState,
    registeredBoardHash,
  );
  return { origin, targetEntityId, entityTxs, outputHash };
};

export const buildCertifiedEntityOutputHashes = (
  sourceState: EntityState,
  env: Env,
  height: number,
  frameHash: string,
  outputs: EntityInput[],
): HashToSign[] => outputs.flatMap((output, outputIndex) => {
  if (isNonMutatingEntityWakeOutput(output)) return [];
  if (isLocalRuntimeProtocolOutput(output)) return [];
  const entityTxs = assertCertifiableOutput(output, outputIndex);
  const semanticIdentity = output.certifiedOutputIdentity;
  if (!semanticIdentity) throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_IDENTITY_MISSING:index=${outputIndex}`);
  const semanticHash = hashCertifiedEntityOutputSemantic(
    sourceState.entityId,
    output.entityId,
    semanticIdentity.lane,
    semanticIdentity.sequence,
    entityTxs,
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
  return [{
    hash: hashCertifiedEntityOutput(origin, output.entityId, entityTxs),
    type: 'entityOutput',
    context: `entity-output:${height}:${outputIndex}`,
  }];
});
