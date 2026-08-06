import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeReplica, ReliableDeliveryEvidenceBinding, ReliableDeliveryIdentity, RoutedEntityInput } from '../types';
import { keccak256, toUtf8Bytes } from 'ethers';
import { hasEntityCommitCertificate } from '../../entity/signatures';
import { normalizeRuntimeId } from '../../network/p2p/runtime-id';
import { txFingerprint } from '../../protocol/tx-multiset';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { buildPreparedFrameEvidence, hashEntityLeaderVoteBody } from '../../entity/consensus/leader';
import { hashJPrefixAttestation } from '../../jurisdiction/machine/j-prefix-consensus';

import { assertCertifiedOutputSemanticIdentity } from '../../entity/consensus/output-certification';
import { getCertifiedOutputNestedTxs, getEffectiveEntityInputTxs } from '../../entity/consensus/output-envelope';
import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';

export const carriesEntityCommitNotification = (output: RoutedEntityInput): boolean =>
  hasEntityCommitCertificate(output.proposedFrame);

type EntityFrameIdentity = {
  entityId: string;
  height: number;
  frameHash: string;
};

export type ReliableOutputIdentity = ReliableDeliveryIdentity & {
  order: number;
  /** Same-height evidence is applied from proposal/sparse to terminal/richer. */
  variantOrder: number;
};

const RELIABLE_OUTPUT_IDENTITY_CACHE_LIMIT = 32;
const reliableOutputIdentityCache = new Map<
  RoutedEntityInput,
  ReliableOutputIdentity | null
>();

const rememberReliableOutputIdentity = <T extends RoutedEntityInput>(
  output: T,
  identity: ReliableOutputIdentity | null,
): T => {
  if (reliableOutputIdentityCache.has(output)) {
    reliableOutputIdentityCache.delete(output);
  } else if (reliableOutputIdentityCache.size >= RELIABLE_OUTPUT_IDENTITY_CACHE_LIMIT) {
    const oldest = reliableOutputIdentityCache.keys().next().value;
    if (oldest) reliableOutputIdentityCache.delete(oldest);
  }
  reliableOutputIdentityCache.set(output, identity);
  return output;
};

export const invalidateReliableOutputIdentity = (output: RoutedEntityInput): void => {
  reliableOutputIdentityCache.delete(output);
};

export const cloneRoutedOutputWithCachedIdentity = <T extends RoutedEntityInput>(output: T): T => {
  const identity = getReliableOutputIdentity(output);
  const clone = structuredClone(output) as T;
  return rememberReliableOutputIdentity(clone, identity);
};

export const cacheRoutedOutputIdentity = <T extends RoutedEntityInput>(output: T): T =>
  rememberReliableOutputIdentity(output, computeReliableOutputIdentity(output));

export const normalizeRouteText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const requireReliableOrder = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${code}: ${String(value)}`);
  }
  return Number(value);
};

const requireReliableHash = (value: unknown, code: string): string => {
  const normalized = normalizeRouteText(value);
  if (!normalized) throw new Error(code);
  return normalized;
};

const reliableEvidenceDigest = (value: unknown): string =>
  keccak256(toUtf8Bytes(encodeCanonicalConsensusValue(value))).toLowerCase();

const getEntityFrameBodyDigest = (output: RoutedEntityInput): string => {
  const frame = buildPreparedFrameEvidence(output.proposedFrame);
  if (!frame) throw new Error('ROUTE_ENTITY_FRAME_BODY_MISSING');
  // A failover relayer may attach a relay certificate to the exact locked frame,
  // and commit adds signatures/Hankos. Those are independently checked evidence,
  // not frame-body fields. Every remaining field, including arbitrary tx metadata,
  // must stay bound or poison-first delivery could suppress the honest proposal.
  const { collectedSigs: _collectedSigs, ...body } = frame;
  return reliableEvidenceDigest({
    domain: 'xln.reliable.entity-frame-body.v1',
    frame: body,
  });
};

const getPrecommitEvidenceBindings = (bundles: Map<string, string[]>): ReliableDeliveryEvidenceBinding[] => {
  const bySigner = new Map<string, ReliableDeliveryEvidenceBinding>();
  for (const [rawSignerId, signatures] of bundles) {
    const subject = normalizeRouteText(rawSignerId);
    if (!subject) throw new Error('ROUTE_PRECOMMIT_SIGNER_MISSING');
    if (bySigner.has(subject)) {
      throw new Error(`ROUTE_PRECOMMIT_DUPLICATE_SIGNER:identity:${rawSignerId}`);
    }
    bySigner.set(subject, {
      subject,
      digest: reliableEvidenceDigest(signatures),
    });
  }
  return [...bySigner.values()].sort((left, right) => compareStableText(left.subject, right.subject));
};

const reliableLaneKey = (kind: ReliableOutputIdentity['kind'], output: RoutedEntityInput, scope?: unknown): string =>
  safeStringify({
    kind,
    entityId: normalizeRouteText(output.entityId),
    signerId: normalizeRouteText(output.signerId),
    ...(scope === undefined ? {} : { scope }),
  });

export const getEntityFrameIdentity = (output: RoutedEntityInput): EntityFrameIdentity | null => {
  if (!output.proposedFrame) return null;
  return {
    entityId: output.entityId,
    height: output.proposedFrame.height,
    frameHash: output.proposedFrame.hash,
  };
};

const getEntityFrameReliableIdentity = (output: RoutedEntityInput): ReliableOutputIdentity | null => {
  const frame = getEntityFrameIdentity(output);
  if (!frame) return null;
  const order = requireReliableOrder(frame.height, 'ROUTE_ENTITY_FRAME_HEIGHT_INVALID');
  const frameHash = requireReliableHash(frame.frameHash, 'ROUTE_ENTITY_FRAME_HASH_MISSING');
  const evidenceKind = carriesEntityCommitNotification(output) ? 'entity-certificate' : 'entity-proposal';
  const evidenceDigest = reliableEvidenceDigest({
    leader: output.proposedFrame?.leader ?? null,
    hashesToSign: output.proposedFrame?.hashesToSign ?? [],
    collectedSigs: output.proposedFrame?.collectedSigs ?? new Map(),
    hankos: output.proposedFrame?.hankos ?? [],
  });
  const bodyDigest = getEntityFrameBodyDigest(output);
  return {
    kind: 'entity-frame',
    entityId: normalizeRouteText(frame.entityId),
    signerId: normalizeRouteText(output.signerId),
    laneKey: reliableLaneKey('entity-frame', output),
    height: order,
    order,
    variantOrder: evidenceKind === 'entity-certificate' ? 1 : 0,
    frameHash,
    logicalKey: safeStringify({
      kind: 'entity-frame',
      entityId: normalizeRouteText(frame.entityId),
      height: order,
      frameHash,
    }),
    evidenceVersion: 1,
    evidenceKind,
    evidenceDigest,
    bodyDigest,
  };
};

const getHashPrecommitReliableIdentity = (output: RoutedEntityInput): ReliableOutputIdentity | null => {
  if (!output.hashPrecommits || output.hashPrecommits.size === 0) return null;
  const reference = output.hashPrecommitFrame;
  if (!reference) throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_MISSING');
  const order = requireReliableOrder(reference.height, 'ROUTE_PRECOMMIT_FRAME_HEIGHT_INVALID');
  const frameHash = requireReliableHash(reference.frameHash, 'ROUTE_PRECOMMIT_FRAME_HASH_MISSING');
  const evidenceBindings = getPrecommitEvidenceBindings(output.hashPrecommits);
  return {
    kind: 'hash-precommit',
    entityId: normalizeRouteText(output.entityId),
    signerId: normalizeRouteText(output.signerId),
    laneKey: reliableLaneKey('hash-precommit', output),
    height: order,
    order,
    variantOrder: evidenceBindings.length,
    frameHash,
    logicalKey: safeStringify({ kind: 'hash-precommit', height: order, frameHash }),
    evidenceVersion: 1,
    evidenceKind: 'hash-precommit',
    evidenceDigest: reliableEvidenceDigest(evidenceBindings),
    evidenceBindings,
  };
};

const getLeaderTimeoutVoteReliableIdentity = (output: RoutedEntityInput): ReliableOutputIdentity | null => {
  const vote = output.leaderTimeoutVote;
  if (!vote) return null;
  const entityId = normalizeRouteText(output.entityId);
  if (!entityId || normalizeRouteText(vote.entityId) !== entityId) {
    throw new Error('ROUTE_LEADER_VOTE_ENTITY_MISMATCH');
  }
  const order = requireReliableOrder(vote.targetHeight, 'ROUTE_LEADER_VOTE_HEIGHT_INVALID');
  const fromView = requireReliableOrder(vote.fromView, 'ROUTE_LEADER_VOTE_FROM_VIEW_INVALID');
  const toView = requireReliableOrder(vote.toView, 'ROUTE_LEADER_VOTE_TO_VIEW_INVALID');
  if (toView - fromView !== 1) throw new Error('ROUTE_LEADER_VOTE_VIEW_TRANSITION_INVALID');
  const previousFrameHash = requireReliableHash(
    vote.previousFrameHash,
    'ROUTE_LEADER_VOTE_PREVIOUS_FRAME_HASH_MISSING',
  );
  const previousLeaderId = requireReliableHash(vote.previousLeaderId, 'ROUTE_LEADER_VOTE_PREVIOUS_LEADER_MISSING');
  const nextLeaderId = requireReliableHash(vote.nextLeaderId, 'ROUTE_LEADER_VOTE_NEXT_LEADER_MISSING');
  const voterId = requireReliableHash(vote.voterId, 'ROUTE_LEADER_VOTE_VOTER_MISSING');
  const signature = requireReliableHash(vote.signature, 'ROUTE_LEADER_VOTE_SIGNATURE_MISSING');
  const voteHash = hashEntityLeaderVoteBody(vote).toLowerCase();
  const evidenceBindings = [{ subject: voterId, digest: reliableEvidenceDigest(signature) }];
  return {
    kind: 'leader-timeout-vote',
    entityId,
    signerId: normalizeRouteText(output.signerId),
    // Successive view transitions at one Entity height are independent lanes;
    // exact state validation rejects a stale transition. Reusing this lane for
    // the same voter/transition makes targetHeight the only ordered dimension.
    laneKey: reliableLaneKey('leader-timeout-vote', output, { voterId, fromView, toView }),
    height: order,
    order,
    variantOrder: 0,
    frameHash: voteHash,
    logicalKey: safeStringify({
      kind: 'leader-timeout-vote',
      entityId,
      targetHeight: order,
      previousFrameHash,
      fromView,
      toView,
      previousLeaderId,
      nextLeaderId,
      voterId,
      voteHash,
    }),
    evidenceVersion: 1,
    evidenceKind: 'leader-timeout-vote',
    evidenceDigest: reliableEvidenceDigest(evidenceBindings),
    bodyDigest: voteHash,
    evidenceBindings,
  };
};

const getJPrefixAttestationReliableIdentity = (output: RoutedEntityInput): ReliableOutputIdentity | null => {
  const bundle = output.jPrefixAttestations;
  if (!bundle || bundle.size === 0) return null;
  if (bundle.size !== 1) throw new Error('ROUTE_J_PREFIX_ATTESTATION_MUST_BE_SPLIT');
  const entry = bundle.entries().next().value;
  if (!entry) throw new Error('ROUTE_J_PREFIX_ATTESTATION_MISSING');
  const [rawSignerId, attestation] = entry;
  const sourceValidatorId = normalizeRouteText(rawSignerId);
  if (!sourceValidatorId || sourceValidatorId !== normalizeRouteText(attestation.validatorId)) {
    throw new Error('ROUTE_J_PREFIX_SOURCE_VALIDATOR_MISMATCH');
  }
  const order = requireReliableOrder(attestation.targetEntityHeight, 'ROUTE_J_PREFIX_TARGET_HEIGHT_INVALID');
  const jurisdictionRef = normalizeRouteText(attestation.jurisdictionRef);
  if (!jurisdictionRef) throw new Error('ROUTE_J_PREFIX_JURISDICTION_MISSING');
  const { signature, ...unsigned } = attestation;
  const frameHash = hashJPrefixAttestation(unsigned).toLowerCase();
  const logicalKey = safeStringify({
    kind: 'j-prefix-attestation',
    entityId: normalizeRouteText(attestation.entityId),
    height: order,
    frameHash,
  });
  return {
    kind: 'j-prefix-attestation',
    entityId: normalizeRouteText(output.entityId),
    signerId: normalizeRouteText(output.signerId),
    laneKey: reliableLaneKey('j-prefix-attestation', output, { jurisdictionRef, sourceValidatorId }),
    height: order,
    order,
    variantOrder: 0,
    frameHash,
    logicalKey,
    evidenceVersion: 1,
    evidenceKind: 'j-prefix-attestation',
    evidenceDigest: reliableEvidenceDigest(signature),
  };
};

const withoutDisputeHanko = (seal: { hanko?: string } | undefined): unknown => {
  if (!seal) return null;
  const { hanko: _hanko, ...identity } = seal;
  return identity;
};

type AccountInputData = Extract<EntityTx, { type: 'accountInput' }>['data'];

const getBoardResealIdentity = (
  output: RoutedEntityInput,
  data: Extract<AccountInputData, { kind: 'board_reseal' }>,
): ReliableOutputIdentity => {
  const order = requireReliableOrder(
    data.reseal.boardActivationJHeight,
    'ROUTE_ACCOUNT_BOARD_RESEAL_ACTIVATION_HEIGHT_INVALID',
  );
  const activationLogIndex = requireReliableOrder(
    data.reseal.boardActivationLogIndex,
    'ROUTE_ACCOUNT_BOARD_RESEAL_ACTIVATION_LOG_INDEX_INVALID',
  );
  const frameHeight = requireReliableOrder(data.reseal.height, 'ROUTE_ACCOUNT_BOARD_RESEAL_FRAME_HEIGHT_INVALID');
  const frameHash = requireReliableHash(data.reseal.frameHash, 'ROUTE_ACCOUNT_BOARD_RESEAL_FRAME_HASH_MISSING');
  const fromEntityId = normalizeRouteText(data.fromEntityId);
  const toEntityId = normalizeRouteText(data.toEntityId);
  const watchSeed = normalizeRouteText(data.watchSeed);
  const account = [fromEntityId, toEntityId].sort(compareStableText);
  const body = {
    kind: 'account-board-reseal',
    route: { fromEntityId, toEntityId, watchSeed },
    boardActivationJHeight: order,
    boardActivationLogIndex: activationLogIndex,
    frameHeight,
    frameHash,
    disputeSeal: withoutDisputeHanko(data.reseal.disputeSeal),
  };
  const bodyDigest = reliableEvidenceDigest({
    domain: 'xln.reliable.account-board-reseal-body.v1',
    body,
  });
  return {
    kind: 'account-board-reseal',
    entityId: normalizeRouteText(output.entityId),
    signerId: normalizeRouteText(output.signerId),
    laneKey: reliableLaneKey('account-board-reseal', output, account),
    height: order,
    order,
    logIndex: activationLogIndex,
    variantOrder: activationLogIndex,
    frameHash,
    logicalKey: safeStringify(body),
    evidenceVersion: 1,
    evidenceKind: 'account-board-reseal',
    evidenceDigest: reliableEvidenceDigest({
      domain: 'xln.reliable.account-board-reseal-evidence.v1',
      bodyDigest,
    }),
    bodyDigest,
  };
};

const getAccountAckIdentity = (
  output: RoutedEntityInput,
  data: Extract<AccountInputData, { kind: 'ack' | 'frame_ack' }>,
): ReliableOutputIdentity => {
  const order = requireReliableOrder(data.ack.height, 'ROUTE_ACCOUNT_ACK_HEIGHT_INVALID');
  const frameHash = requireReliableHash(data.ack.frameHash, 'ROUTE_ACCOUNT_ACK_FRAME_HASH_MISSING');
  const fromEntityId = normalizeRouteText(data.fromEntityId);
  const toEntityId = normalizeRouteText(data.toEntityId);
  const watchSeed = normalizeRouteText(data.watchSeed);
  const account = [fromEntityId, toEntityId].sort(compareStableText);
  const proposalIdentity =
    data.kind === 'frame_ack'
      ? {
          frame: data.proposal.frame,
          disputeSeal: withoutDisputeHanko(data.proposal.disputeSeal),
        }
      : null;
  const bodyDigest = reliableEvidenceDigest({
    domain: 'xln.reliable.account-ack-body.v1',
    route: { fromEntityId, toEntityId, watchSeed },
    ack: {
      height: order,
      frameHash,
      disputeSeal: withoutDisputeHanko(data.ack.disputeSeal),
    },
  });
  const evidenceKind = data.kind === 'frame_ack' ? 'account-frame-ack' : 'account-ack';

  // ACK and frame_ack acknowledge the same Account frame, so they share one
  // ordered slot. The proposal is richer evidence, not a different ACK.
  return {
    kind: 'account-ack',
    entityId: normalizeRouteText(output.entityId),
    signerId: normalizeRouteText(output.signerId),
    laneKey: reliableLaneKey('account-ack', output, account),
    height: order,
    order,
    variantOrder: evidenceKind === 'account-frame-ack' ? 1 : 0,
    frameHash,
    logicalKey: safeStringify({
      kind: 'account-ack',
      fromEntityId,
      toEntityId,
      watchSeed,
      height: order,
      frameHash,
    }),
    evidenceVersion: 1,
    evidenceKind,
    evidenceDigest: reliableEvidenceDigest({
      domain: 'xln.reliable.account-ack-evidence.v1',
      bodyDigest,
      evidenceKind,
      proposal: proposalIdentity,
    }),
    bodyDigest,
  };
};

const getJFinalityIdentity = (
  output: RoutedEntityInput,
  data: Extract<EntityTx, { type: 'j_event' }>['data'],
): ReliableOutputIdentity => {
  const order = requireReliableOrder(data.scannedThroughHeight, 'ROUTE_J_FINALITY_HEIGHT_INVALID');
  const { signature: _signature, observedAt: _observedAt, ...unsignedRange } = data;
  const jurisdictionRef = normalizeRouteText(data.jurisdictionRef);
  if (!jurisdictionRef) throw new Error('ROUTE_J_FINALITY_JURISDICTION_MISSING');
  const sourceValidatorId = normalizeRouteText(data.from);
  if (!sourceValidatorId) throw new Error('ROUTE_J_FINALITY_SOURCE_VALIDATOR_MISSING');
  const logicalKey = safeStringify({ kind: 'j-finality', unsignedRange });
  return {
    kind: 'j-finality',
    entityId: normalizeRouteText(output.entityId),
    signerId: normalizeRouteText(output.signerId),
    laneKey: reliableLaneKey('j-finality', output, { jurisdictionRef, sourceValidatorId }),
    height: order,
    order,
    variantOrder: 0,
    frameHash: keccak256(toUtf8Bytes(logicalKey)).toLowerCase(),
    logicalKey,
    evidenceVersion: 1,
    evidenceKind: 'j-finality',
    evidenceDigest: reliableEvidenceDigest(logicalKey),
  };
};

const getDirectReliableTxIdentity = (output: RoutedEntityInput, tx: EntityTx): ReliableOutputIdentity | null => {
  if (tx.type === 'accountInput' && tx.data.kind === 'board_reseal') {
    return getBoardResealIdentity(output, tx.data);
  }
  if (tx.type === 'accountInput' && (tx.data.kind === 'ack' || tx.data.kind === 'frame_ack')) {
    return getAccountAckIdentity(output, tx.data);
  }
  return tx.type === 'j_event' ? getJFinalityIdentity(output, tx.data) : null;
};

const requireCertifiedSequence = (value: unknown): bigint => {
  const sequence =
    typeof value === 'bigint' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : -1n;
  if (sequence < 0n || sequence > (1n << 64n) - 1n) {
    throw new Error(`ROUTE_CERTIFIED_SEQUENCE_INVALID:${String(value)}`);
  }
  return sequence;
};

const getReliableTxIdentity = (output: RoutedEntityInput, tx: EntityTx): ReliableOutputIdentity | null => {
  const direct = getDirectReliableTxIdentity(output, tx);
  if (direct) return direct;
  const nested = getCertifiedOutputNestedTxs(tx);
  if (!nested) return null;
  const nestedIdentities = nested
    .map(candidate => getDirectReliableTxIdentity(output, candidate))
    .filter((identity): identity is ReliableOutputIdentity => identity !== null);
  if (nestedIdentities.length === 0) return null;
  if (nested.length !== 1 || nestedIdentities.length !== 1) {
    throw new Error('ROUTE_CERTIFIED_RELIABLE_OUTPUT_MUST_BE_ATOMIC');
  }
  if (tx.type !== 'consensusOutput') throw new Error('ROUTE_CERTIFIED_OUTPUT_TYPE_INVALID');
  const targetEntityId = normalizeRouteText(tx.data.targetEntityId);
  if (!targetEntityId || targetEntityId !== normalizeRouteText(output.entityId)) {
    throw new Error('ROUTE_CERTIFIED_TARGET_ENTITY_MISMATCH');
  }
  const origin = tx.data.origin;
  const sourceEntityId = requireReliableHash(origin.sourceEntityId, 'ROUTE_CERTIFIED_SOURCE_ENTITY_MISSING');
  const semanticHash = requireReliableHash(origin.semanticHash, 'ROUTE_CERTIFIED_SEMANTIC_HASH_MISSING');
  const sequence = requireCertifiedSequence(origin.sequence);
  assertCertifiedOutputSemanticIdentity(origin, targetEntityId, tx.data.entityTxs);
  const payload = nested[0]!;
  if (
    payload.type === 'accountInput' &&
    (normalizeRouteText(payload.data.fromEntityId) !== sourceEntityId ||
      normalizeRouteText(payload.data.toEntityId) !== targetEntityId)
  ) {
    throw new Error('ROUTE_CERTIFIED_ACCOUNT_PARTICIPANT_MISMATCH');
  }
  const inner = nestedIdentities[0]!;
  return {
    ...inner,
    evidenceDigest: reliableEvidenceDigest({
      domain: 'xln.reliable.certified-output-evidence.v1',
      innerEvidenceDigest: inner.evidenceDigest,
      semantic: {
        sourceEntityId,
        targetEntityId,
        lane: origin.lane,
        sequence,
        semanticHash,
      },
    }),
  };
};

const computeReliableOutputIdentity = (output: RoutedEntityInput): ReliableOutputIdentity | null => {
  const reliableTxIdentities = (output.entityTxs ?? []).map(tx => getReliableTxIdentity(output, tx));
  const identities = [
    getEntityFrameReliableIdentity(output),
    getHashPrecommitReliableIdentity(output),
    getLeaderTimeoutVoteReliableIdentity(output),
    getJPrefixAttestationReliableIdentity(output),
    ...reliableTxIdentities,
  ].filter((identity): identity is ReliableOutputIdentity => identity !== null);
  if (identities.length === 0) return null;
  const reliableTxCount = reliableTxIdentities.filter(identity => identity !== null).length;
  const hasOrdinaryTxs = (output.entityTxs?.length ?? 0) > reliableTxCount;
  if (identities.length !== 1 || hasOrdinaryTxs) {
    throw new Error('ROUTE_MIXED_RELIABLE_OUTPUT_MUST_BE_SPLIT');
  }
  return identities[0]!;
};

export const getReliableOutputIdentity = (output: RoutedEntityInput): ReliableOutputIdentity | null => {
  if (reliableOutputIdentityCache.has(output)) {
    return reliableOutputIdentityCache.get(output)!;
  }
  return computeReliableOutputIdentity(output);
};

export const assertReliableEvidenceCompatible = (
  existing: ReliableOutputIdentity,
  incoming: ReliableOutputIdentity,
): void => {
  if (
    existing.laneKey !== incoming.laneKey ||
    existing.order !== incoming.order ||
    existing.variantOrder !== incoming.variantOrder
  )
    return;
  if (existing.logicalKey !== incoming.logicalKey || existing.frameHash !== incoming.frameHash) {
    throw new Error(`ROUTE_RELIABLE_LANE_ORDER_CONFLICT:${incoming.kind}:${incoming.order}`);
  }
  if (
    existing.kind === 'entity-frame' &&
    incoming.kind === 'entity-frame' &&
    existing.bodyDigest !== incoming.bodyDigest
  ) {
    throw new Error(`ROUTE_ENTITY_FRAME_BODY_CONFLICT:${incoming.order}`);
  }
  if (existing.kind === 'account-ack' && incoming.kind === 'account-ack') {
    if (existing.bodyDigest !== incoming.bodyDigest) {
      throw new Error(`ROUTE_ACCOUNT_ACK_BODY_CONFLICT:${incoming.order}`);
    }
    if (existing.evidenceKind === incoming.evidenceKind && existing.evidenceDigest !== incoming.evidenceDigest) {
      throw new Error(`ROUTE_ACCOUNT_ACK_EVIDENCE_CONFLICT:${incoming.order}`);
    }
    return;
  }
  if (
    existing.kind === 'j-prefix-attestation' &&
    incoming.kind === 'j-prefix-attestation' &&
    existing.evidenceDigest !== incoming.evidenceDigest
  ) {
    throw new Error(`ROUTE_J_PREFIX_EVIDENCE_CONFLICT:${incoming.order}`);
  }
  if (existing.kind === 'leader-timeout-vote' && incoming.kind === 'leader-timeout-vote') {
    if (existing.bodyDigest !== incoming.bodyDigest) {
      throw new Error(`ROUTE_LEADER_VOTE_BODY_CONFLICT:${incoming.order}`);
    }
    const existingBindings = new Map(
      (existing.evidenceBindings ?? []).map(binding => [binding.subject, binding.digest]),
    );
    for (const binding of incoming.evidenceBindings ?? []) {
      const priorDigest = existingBindings.get(binding.subject);
      if (priorDigest && priorDigest !== binding.digest) {
        throw new Error(`ROUTE_LEADER_VOTE_EQUIVOCATION:${binding.subject}`);
      }
    }
    return;
  }
  if (existing.kind !== 'hash-precommit' || incoming.kind !== 'hash-precommit') return;
  const existingBindings = new Map((existing.evidenceBindings ?? []).map(binding => [binding.subject, binding.digest]));
  for (const binding of incoming.evidenceBindings ?? []) {
    const priorDigest = existingBindings.get(binding.subject);
    if (priorDigest && priorDigest !== binding.digest) {
      throw new Error(`ROUTE_PRECOMMIT_EQUIVOCATION:${binding.subject}`);
    }
  }
};

export const splitRoutedOutputByDeliveryLane = <T extends RoutedEntityInput>(output: T): T[] => {
  if (reliableOutputIdentityCache.has(output)) return [output];
  const {
    entityTxs = [],
    proposedFrame,
    hashPrecommits,
    hashPrecommitFrame,
    jPrefixAttestations,
    leaderTimeoutVote,
    ...route
  } = output;
  const split: RoutedEntityInput[] = [];
  const routeInput = route as RoutedEntityInput;

  const appendSplit = (
    candidate: RoutedEntityInput,
    identity?: ReliableOutputIdentity | null,
  ): void => {
    split.push(
      identity === undefined
        ? cacheRoutedOutputIdentity(candidate)
        : rememberReliableOutputIdentity(candidate, identity),
    );
  };

  if (proposedFrame) {
    const candidate = { ...routeInput, proposedFrame };
    appendSplit(candidate, getEntityFrameReliableIdentity(candidate));
  }
  if (hashPrecommits && hashPrecommits.size > 0) {
    if (!hashPrecommitFrame) throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_MISSING');
    const candidate = { ...routeInput, hashPrecommitFrame, hashPrecommits };
    appendSplit(candidate, getHashPrecommitReliableIdentity(candidate));
  } else if (hashPrecommitFrame) {
    throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_WITHOUT_SIGNATURES');
  }
  if (leaderTimeoutVote) {
    const candidate = { ...routeInput, leaderTimeoutVote };
    appendSplit(candidate, getLeaderTimeoutVoteReliableIdentity(candidate));
  }
  if (jPrefixAttestations) {
    for (const [signerId, attestation] of jPrefixAttestations) {
      const candidate = {
        ...routeInput,
        jPrefixAttestations: new Map([[signerId, structuredClone(attestation)]]),
      };
      appendSplit(candidate, getJPrefixAttestationReliableIdentity(candidate));
    }
  }

  const ordinaryTxs: EntityTx[] = [];
  for (const tx of entityTxs) {
    const identity = getReliableTxIdentity(output, tx);
    if (identity) appendSplit({ ...routeInput, entityTxs: [tx] }, identity);
    else ordinaryTxs.push(tx);
  }
  if (ordinaryTxs.length > 0) appendSplit({ ...routeInput, entityTxs: ordinaryTxs }, null);
  if (split.length === 0) appendSplit({ ...routeInput, entityTxs: [] }, null);

  return split as T[];
};

export const accountProposalOutputIdentity = (output: RoutedEntityInput): string | null => {
  const txs = getEffectiveEntityInputTxs(output);
  if (txs.length === 0) return null;
  const proposals = txs.flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    return proposal ? [{ accountInput: tx.data, proposal }] : [];
  });
  if (proposals.length !== txs.length) return null;
  return safeStringify({
    runtimeId: normalizeRuntimeId(output.runtimeId),
    entityId: output.entityId.toLowerCase(),
    signerId: output.signerId.toLowerCase(),
    from: normalizeRuntimeId(output.from),
    proposals: proposals.map(({ accountInput, proposal }) => ({
      fromEntityId: accountInput.fromEntityId.toLowerCase(),
      toEntityId: accountInput.toEntityId.toLowerCase(),
      height: proposal.frame.height,
      stateHash: proposal.frame.stateHash.toLowerCase(),
    })),
  });
};

export const accountProposalEvidenceRank = (output: RoutedEntityInput): number =>
  getEffectiveEntityInputTxs(output).reduce((rank, tx) => {
    if (tx.type !== 'accountInput') return rank;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return rank;
    return rank + Number(Boolean(proposal.frameHanko)) + Number(Boolean(proposal.disputeSeal));
  }, 0);

const senderAccountForProposal = (
  env: RuntimeReplica,
  fromEntityId: string,
  toEntityId: string,
) => {
  const owner = fromEntityId.toLowerCase();
  const counterparty = toEntityId.toLowerCase();
  for (const replica of env.state.eReplicas.values()) {
    if (replica.entityId.toLowerCase() !== owner) continue;
    const account = [...replica.state.accounts.entries()].find(
      ([counterpartyId]) => counterpartyId.toLowerCase() === counterparty,
    )?.[1];
    if (account) return account;
  }
  return null;
};

/**
 * Bilateral Account consensus allows exactly one pending frame per account, so a
 * proposal is live in the outbox for exactly as long as it *is* that frame.
 *
 * Keying the outbox on "committed by the sender" instead recognised only one of
 * a proposal's two terminals. The other is rollback: the RIGHT side discards its
 * own frame when it loses a same-height collision, and that frame can never
 * commit. Such a proposal used to stay in the outbox forever, and a stale
 * sibling makes every later cross-j cohort find two matching candidates where
 * the exact-pair selector demands one - so the whole cohort is rejected and its
 * legs reach dispatch alone. Asking whether the sender still holds the frame
 * covers both terminals with one question and cannot leave a duplicate behind.
 */
export const accountProposalSettledBySender = (env: RuntimeReplica, output: RoutedEntityInput): boolean => {
  const proposals = getEffectiveEntityInputTxs(output).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    return proposal ? [{ accountInput: tx.data, proposal }] : [];
  });
  if (proposals.length === 0) return false;
  return proposals.every(({ accountInput, proposal }) => {
    const account = senderAccountForProposal(env, accountInput.fromEntityId, accountInput.toEntityId);
    // An account the sender no longer hosts cannot advance this proposal either.
    if (!account) return true;
    const pending = account.pendingFrame;
    return !(
      pending?.height === proposal.frame.height &&
      pending.stateHash.toLowerCase() === proposal.frame.stateHash.toLowerCase()
    );
  });
};

const senderAccountForInput = (
  env: RuntimeReplica,
  input: AccountInputData,
) => [...env.state.eReplicas.values()].flatMap(replica => {
  if (replica.entityId.toLowerCase() !== input.fromEntityId.toLowerCase()) return [];
  const counterpartyId = input.toEntityId.toLowerCase();
  const account = [...replica.state.accounts.entries()].find(
    ([candidateId]) => candidateId.toLowerCase() === counterpartyId,
  )?.[1];
  return account ? [account] : [];
})[0];

const accountFrameMatches = (
  frame: { height: number; stateHash: string } | undefined,
  expected: { height: number; stateHash: string },
): boolean => frame?.height === expected.height &&
  frame.stateHash.toLowerCase() === expected.stateHash.toLowerCase();

/** A newer local Account frontier is deterministic proof that this signed proposal was retired. */
export const accountProposalRetiredBySender = (env: RuntimeReplica, output: RoutedEntityInput): boolean => {
  const txs = getEffectiveEntityInputTxs(output);
  if (txs.length === 0) return false;
  return txs.every(tx => {
    if (tx.type !== 'accountInput') return false;
    const proposal = accountInputProposal(tx.data)?.frame;
    const account = senderAccountForInput(env, tx.data);
    if (!proposal || !account) return false;
    if (accountFrameMatches(account.currentFrame, proposal) || accountFrameMatches(account.pendingFrame, proposal)) {
      return false;
    }
    const frontierHeight = Math.max(account.currentFrame.height, account.pendingFrame?.height ?? -1);
    const ack = accountInputAck(tx.data);
    return frontierHeight >= proposal.height && (!ack || account.currentFrame.height > ack.height);
  });
};

export const buildRouteOutputKey = (output: RoutedEntityInput): string => {
  const reliableIdentity = getReliableOutputIdentity(output);
  if (reliableIdentity) return safeStringify({ reliableIdentity });
  if (output.leaderTimeoutVote) {
    return safeStringify({
      runtimeId: output.runtimeId ?? '',
      entityId: output.entityId.toLowerCase(),
      signerId: output.signerId.toLowerCase(),
      targetHeight: output.leaderTimeoutVote.targetHeight,
      voterId: output.leaderTimeoutVote.voterId.toLowerCase(),
      voteHash: hashEntityLeaderVoteBody(output.leaderTimeoutVote),
    });
  }
  const accountProposalIdentity = accountProposalOutputIdentity(output);
  if (accountProposalIdentity) return accountProposalIdentity;
  return safeStringify({
    runtimeId: output.runtimeId ?? '',
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    entityId: output.entityId,
    signerId: output.signerId,
    from: output.from ?? '',
    txs: (output.entityTxs || []).map(tx => txFingerprint(tx)),
  });
};
