import type {
  DeliverableEntityInput,
  EntityTx,
  Env,
  ReliableDeliveryEvidenceBinding,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
} from '../types';
import { keccak256, toUtf8Bytes } from 'ethers';
import { hasEntityCommitCertificate } from '../protocol/signatures';
import {
  entityInputHasCrossJurisdictionIntraRuntimeTx,
} from '../extensions/cross-j/boundary';
import { createStructuredLogger, shortId } from '../infra/logger';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { txFingerprint } from '../state-helpers';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { getWallClockMs } from '../utils';
import { validateDeliverableEntityInput } from '../validation-utils';
import {
  buildPreparedFrameEvidence,
  hashEntityLeaderVoteBody,
} from '../entity/consensus/leader';
import { hashJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';
import { encodeCanonicalEntityConsensusValue } from '../entity/consensus/state-root';
import { assertCertifiedOutputSemanticIdentity } from '../entity/consensus/output-certification';
import {
  getCertifiedOutputNestedTxs,
  getEffectiveEntityInputTxs,
  orderCertifiedOutputsBySequence,
} from '../entity/consensus/output-envelope';
import { accountInputAck, accountInputProposal } from '../account/consensus/flush';
import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryQueued,
  isDeliveryDelivered,
  requireDeliveryDelivered,
  requireDeliveryResult,
  shouldRetryDelivery,
  type DeliveryResult,
} from '../protocol/payments/delivery-result';
import {
  reliableReceiptCoversIdentity,
  senderFrontierKey,
  senderFrontierKeyForIdentity,
} from './reliable-frontier';
import { selectPotentialCrossJAccountInputPairs } from './entity-routing';

const routeLog = createStructuredLogger('network.route');

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

const cloneRoutedOutputWithCachedIdentity = <T extends RoutedEntityInput>(output: T): T => {
  return structuredClone(output) as T;
};

const normalizeRouteText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

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
  keccak256(toUtf8Bytes(encodeCanonicalEntityConsensusValue(value))).toLowerCase();

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

const getPrecommitEvidenceBindings = (
  bundles: Map<string, string[]>,
): ReliableDeliveryEvidenceBinding[] => {
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

const reliableLaneKey = (
  kind: ReliableOutputIdentity['kind'],
  output: RoutedEntityInput,
  scope?: unknown,
): string => safeStringify({
  kind,
  entityId: normalizeRouteText(output.entityId),
  signerId: normalizeRouteText(output.signerId),
  ...(scope === undefined ? {} : { scope }),
});

const getEntityFrameIdentity = (output: RoutedEntityInput): EntityFrameIdentity | null => {
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
  const evidenceKind = carriesEntityCommitNotification(output)
    ? 'entity-certificate'
    : 'entity-proposal';
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

const getLeaderTimeoutVoteReliableIdentity = (
  output: RoutedEntityInput,
): ReliableOutputIdentity | null => {
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
  const previousLeaderId = requireReliableHash(
    vote.previousLeaderId,
    'ROUTE_LEADER_VOTE_PREVIOUS_LEADER_MISSING',
  );
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

const getJPrefixAttestationReliableIdentity = (
  output: RoutedEntityInput,
): ReliableOutputIdentity | null => {
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
  const order = requireReliableOrder(
    attestation.targetEntityHeight,
    'ROUTE_J_PREFIX_TARGET_HEIGHT_INVALID',
  );
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

const getDirectReliableTxIdentity = (
  output: RoutedEntityInput,
  tx: EntityTx,
): ReliableOutputIdentity | null => {
  if (tx.type === 'accountInput' && tx.data.kind === 'board_reseal') {
    const order = requireReliableOrder(
      tx.data.reseal.boardActivationJHeight,
      'ROUTE_ACCOUNT_BOARD_RESEAL_ACTIVATION_HEIGHT_INVALID',
    );
    const activationLogIndex = requireReliableOrder(
      tx.data.reseal.boardActivationLogIndex,
      'ROUTE_ACCOUNT_BOARD_RESEAL_ACTIVATION_LOG_INDEX_INVALID',
    );
    const frameHeight = requireReliableOrder(
      tx.data.reseal.height,
      'ROUTE_ACCOUNT_BOARD_RESEAL_FRAME_HEIGHT_INVALID',
    );
    const frameHash = requireReliableHash(
      tx.data.reseal.frameHash,
      'ROUTE_ACCOUNT_BOARD_RESEAL_FRAME_HASH_MISSING',
    );
    const fromEntityId = normalizeRouteText(tx.data.fromEntityId);
    const toEntityId = normalizeRouteText(tx.data.toEntityId);
    const watchSeed = normalizeRouteText(tx.data.watchSeed);
    const account = [fromEntityId, toEntityId].sort(compareStableText);
    const body = {
      kind: 'account-board-reseal',
      route: { fromEntityId, toEntityId, watchSeed },
      boardActivationJHeight: order,
      boardActivationLogIndex: activationLogIndex,
      frameHeight,
      frameHash,
      disputeSeal: withoutDisputeHanko(tx.data.reseal.disputeSeal),
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
  }
  if (tx.type === 'accountInput' && (tx.data.kind === 'ack' || tx.data.kind === 'frame_ack')) {
    const order = requireReliableOrder(tx.data.ack.height, 'ROUTE_ACCOUNT_ACK_HEIGHT_INVALID');
    const frameHash = requireReliableHash(tx.data.ack.frameHash, 'ROUTE_ACCOUNT_ACK_FRAME_HASH_MISSING');
    const fromEntityId = normalizeRouteText(tx.data.fromEntityId);
    const toEntityId = normalizeRouteText(tx.data.toEntityId);
    const watchSeed = normalizeRouteText(tx.data.watchSeed);
    const account = [
      fromEntityId,
      toEntityId,
    ].sort(compareStableText);
    const proposalIdentity = tx.data.kind === 'frame_ack'
      ? {
          frame: tx.data.proposal.frame,
          disputeSeal: withoutDisputeHanko(tx.data.proposal.disputeSeal),
        }
      : null;
    const bodyDigest = reliableEvidenceDigest({
      domain: 'xln.reliable.account-ack-body.v1',
      route: { fromEntityId, toEntityId, watchSeed },
      ack: {
        height: order,
        frameHash,
        disputeSeal: withoutDisputeHanko(tx.data.ack.disputeSeal),
      },
    });
    const evidenceKind = tx.data.kind === 'frame_ack'
      ? 'account-frame-ack'
      : 'account-ack';
    // ACK and frame_ack acknowledge the same Account frame, so they share one
    // ordered slot. The proposal is richer evidence, not a different ACK:
    // putting it in logicalKey makes a normal plain-then-rich flush look like
    // equivocation. Keep exact evidence identities separate so the plain ACK
    // receipt can never collect the still-pending proposal.
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
  }
  if (tx.type === 'j_event') {
    const order = requireReliableOrder(
      tx.data.scannedThroughHeight,
      'ROUTE_J_FINALITY_HEIGHT_INVALID',
    );
    const { signature: _signature, observedAt: _observedAt, ...unsignedRange } = tx.data;
    const jurisdictionRef = normalizeRouteText(tx.data.jurisdictionRef);
    if (!jurisdictionRef) throw new Error('ROUTE_J_FINALITY_JURISDICTION_MISSING');
    const sourceValidatorId = normalizeRouteText(tx.data.from);
    if (!sourceValidatorId) throw new Error('ROUTE_J_FINALITY_SOURCE_VALIDATOR_MISSING');
    const logicalKey = safeStringify({
      kind: 'j-finality',
      unsignedRange,
    });
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
  }
  return null;
};

const requireCertifiedSequence = (value: unknown): bigint => {
  const sequence = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : -1n;
  if (sequence < 0n || sequence > ((1n << 64n) - 1n)) {
    throw new Error(`ROUTE_CERTIFIED_SEQUENCE_INVALID:${String(value)}`);
  }
  return sequence;
};

const getReliableTxIdentity = (
  output: RoutedEntityInput,
  tx: EntityTx,
): ReliableOutputIdentity | null => {
  const direct = getDirectReliableTxIdentity(output, tx);
  if (direct) return direct;
  const nested = getCertifiedOutputNestedTxs(tx);
  if (!nested) return null;
  const nestedIdentities = nested
    .map((candidate) => getDirectReliableTxIdentity(output, candidate))
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
  const sourceEntityId = requireReliableHash(
    origin.sourceEntityId,
    'ROUTE_CERTIFIED_SOURCE_ENTITY_MISSING',
  );
  const semanticHash = requireReliableHash(
    origin.semanticHash,
    'ROUTE_CERTIFIED_SEMANTIC_HASH_MISSING',
  );
  const sequence = requireCertifiedSequence(origin.sequence);
  assertCertifiedOutputSemanticIdentity(origin, targetEntityId, tx.data.entityTxs);
  const payload = nested[0]!;
  if (payload.type === 'accountInput' && (
    normalizeRouteText(payload.data.fromEntityId) !== sourceEntityId ||
    normalizeRouteText(payload.data.toEntityId) !== targetEntityId
  )) {
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

const computeReliableOutputIdentity = (
  output: RoutedEntityInput,
): ReliableOutputIdentity | null => {
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

export const getReliableOutputIdentity = (
  output: RoutedEntityInput,
): ReliableOutputIdentity | null => computeReliableOutputIdentity(output);

const assertReliableEvidenceCompatible = (
  existing: ReliableOutputIdentity,
  incoming: ReliableOutputIdentity,
): void => {
  if (
    existing.laneKey !== incoming.laneKey ||
    existing.order !== incoming.order ||
    existing.variantOrder !== incoming.variantOrder
  ) return;
  if (
    existing.logicalKey !== incoming.logicalKey ||
    existing.frameHash !== incoming.frameHash
  ) {
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
    if (
      existing.evidenceKind === incoming.evidenceKind &&
      existing.evidenceDigest !== incoming.evidenceDigest
    ) {
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
  const existingBindings = new Map(
    (existing.evidenceBindings ?? []).map(binding => [binding.subject, binding.digest]),
  );
  for (const binding of incoming.evidenceBindings ?? []) {
    const priorDigest = existingBindings.get(binding.subject);
    if (priorDigest && priorDigest !== binding.digest) {
      throw new Error(`ROUTE_PRECOMMIT_EQUIVOCATION:${binding.subject}`);
    }
  }
};

export const splitRoutedOutputByDeliveryLane = <T extends RoutedEntityInput>(output: T): T[] => {
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
  ): void => { split.push(candidate); };

  if (proposedFrame) {
    const candidate = { ...routeInput, proposedFrame };
    appendSplit(candidate);
  }
  if (hashPrecommits && hashPrecommits.size > 0) {
    if (!hashPrecommitFrame) throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_MISSING');
    const candidate = { ...routeInput, hashPrecommitFrame, hashPrecommits };
    appendSplit(candidate);
  } else if (hashPrecommitFrame) {
    throw new Error('ROUTE_PRECOMMIT_FRAME_REFERENCE_WITHOUT_SIGNATURES');
  }
  if (leaderTimeoutVote) {
    const candidate = { ...routeInput, leaderTimeoutVote };
    appendSplit(candidate);
  }
  if (jPrefixAttestations) {
    for (const [signerId, attestation] of jPrefixAttestations) {
      const candidate = {
        ...routeInput,
        jPrefixAttestations: new Map([[signerId, structuredClone(attestation)]]),
      };
      appendSplit(candidate);
    }
  }

  const ordinaryTxs: EntityTx[] = [];
  for (const tx of entityTxs) {
    const identity = getReliableTxIdentity(output, tx);
    if (identity) appendSplit({ ...routeInput, entityTxs: [tx] });
    else ordinaryTxs.push(tx);
  }
  if (ordinaryTxs.length > 0) appendSplit({ ...routeInput, entityTxs: ordinaryTxs });
  if (split.length === 0) appendSplit({ ...routeInput, entityTxs: [] });

  return split as T[];
};

const accountProposalOutputIdentity = (output: RoutedEntityInput): string | null => {
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

const accountProposalEvidenceRank = (output: RoutedEntityInput): number =>
  getEffectiveEntityInputTxs(output).reduce((rank, tx) => {
    if (tx.type !== 'accountInput') return rank;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return rank;
    return rank + Number(Boolean(proposal.frameHanko)) + Number(Boolean(proposal.disputeSeal));
  }, 0);

const accountProposalCommittedBySender = (
  env: Env,
  output: RoutedEntityInput,
): boolean => {
  const proposals = getEffectiveEntityInputTxs(output).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    return proposal ? [{ accountInput: tx.data, proposal }] : [];
  });
  if (proposals.length === 0) return false;
  return proposals.every(({ accountInput, proposal }) => [...env.eReplicas.values()].some(replica => {
    if (replica.entityId.toLowerCase() !== accountInput.fromEntityId.toLowerCase()) return false;
    const targetCounterparty = accountInput.toEntityId.toLowerCase();
    const account = [...replica.state.accounts.entries()].find(([counterpartyId]) =>
      counterpartyId.toLowerCase() === targetCounterparty)?.[1];
    return account?.currentFrame.height === proposal.frame.height &&
      account.currentFrame.stateHash.toLowerCase() === proposal.frame.stateHash.toLowerCase();
  }));
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

export const MAX_PENDING_NETWORK_OUTPUTS = 10_000;
const NETWORK_RETRY_BASE_MS = 1_000;
const NETWORK_RETRY_MAX_MS = 30_000;
// Consensus lanes are bounded and HOL-ordered, so retrying only the lane head
// every few seconds is cheap. Letting that head inherit the 30s best-effort
// backoff can cross the bilateral liveness alarm during a normal peer restart.
const RELIABLE_NETWORK_RETRY_MAX_MS = 4_000;
const RESTORED_RELIABLE_OUTPUTS_DUE = Symbol('restored-reliable-outputs-due');

type RestoredReliableDueEnv = Env & { [RESTORED_RELIABLE_OUTPUTS_DUE]?: true };

const hasRestoredReliableOutputsDue = (env: Env): boolean =>
  (env as RestoredReliableDueEnv)[RESTORED_RELIABLE_OUTPUTS_DUE] === true;

const clearRestoredReliableOutputsDue = (env: Env): void => {
  delete (env as RestoredReliableDueEnv)[RESTORED_RELIABLE_OUTPUTS_DUE];
};

const isAccountAckIdentity = (identity: ReliableOutputIdentity): boolean =>
  identity.kind === 'account-ack';

const isCrossJAdmissionSourceProposal = (output: RoutedEntityInput): boolean =>
  getEffectiveEntityInputTxs(output).some((tx) => {
    if (tx.type !== 'accountInput') return false;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return false;
    const sourcePull = proposal.frame.accountTxs.find(accountTx =>
      accountTx.type === 'pull_lock' &&
      accountTx.data.crossJurisdiction?.leg === 'source');
    const binding = sourcePull?.type === 'pull_lock' ? sourcePull.data.crossJurisdiction : undefined;
    if (!binding) return false;
    return proposal.frame.accountTxs.some(accountTx =>
      accountTx.type === 'swap_offer' &&
      accountTx.data.crossJurisdiction?.orderId === binding.orderId &&
      String(accountTx.data.crossJurisdiction.routeHash || '').toLowerCase() ===
        String(binding.routeHash || '').toLowerCase());
  });

const isCrossJAdmissionProposal = (output: RoutedEntityInput): boolean =>
  getEffectiveEntityInputTxs(output).some(tx => {
    if (tx.type !== 'accountInput') return false;
    const proposal = accountInputProposal(tx.data);
    return Boolean(proposal?.frame.accountTxs.some(accountTx =>
      accountTx.type === 'pull_lock' && accountTx.data.crossJurisdiction));
  });

const summarizeAccountEnvelopeOutputs = (outputs: readonly RoutedEntityInput[]) =>
  outputs.map(output => ({
    entityId: output.entityId,
    signerId: output.signerId,
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    accountInputs: getEffectiveEntityInputTxs(output).flatMap(tx => {
      if (tx.type !== 'accountInput') return [];
      const ack = accountInputAck(tx.data);
      const proposal = accountInputProposal(tx.data);
      return [{
        kind: tx.data.kind,
        fromEntityId: tx.data.fromEntityId,
        toEntityId: tx.data.toEntityId,
        ackHeight: ack?.height ?? null,
        proposalHeight: proposal?.frame.height ?? null,
        crossPulls: proposal?.frame.accountTxs.flatMap(accountTx =>
          accountTx.type === 'pull_lock' && accountTx.data.crossJurisdiction
            ? [{
                leg: accountTx.data.crossJurisdiction.leg,
                orderId: accountTx.data.crossJurisdiction.orderId,
                routeHash: accountTx.data.crossJurisdiction.routeHash,
              }]
            : []) ?? [],
      }];
    }),
  }));

const groupAtomicCrossJAdmissionOutputs = <T extends RoutedEntityInput>(
  outputs: readonly T[],
): Array<{ outputs: T[]; atomic: boolean; complete: boolean }> => {
  type IndexedUnit = {
    firstIndex: number;
    outputs: T[];
    atomic: boolean;
    complete: boolean;
  };
  const claimed = new Set<number>();
  const indexed: IndexedUnit[] = [];

  // ACK pairs already carry their proposal cohort identity. Group that exact
  // identity before any target batching so two sequential cohorts can never be
  // collapsed into one envelope with one misleading pairKey.
  const explicitGroups = new Map<string, number[]>();
  for (const [index, output] of outputs.entries()) {
    const pair = output.atomicCrossJurisdictionPair;
    if (!pair) continue;
    const key = safeStringify(pair);
    const indexes = explicitGroups.get(key) ?? [];
    indexes.push(index);
    explicitGroups.set(key, indexes);
  }
  for (const indexes of explicitGroups.values()) {
    indexes.forEach(index => claimed.add(index));
    indexed.push({
      firstIndex: Math.min(...indexes),
      outputs: indexes.map(index => outputs[index]!),
      atomic: true,
      complete: indexes.length === 2,
    });
  }

  // Sibling Entity consensus can certify the two Account legs in adjacent
  // Runtime frames. Neither leg leaves this outbox alone. Pair exact route
  // bytes here, then buildRuntimeEntityInputsEnvelope assigns one shared
  // transport frame that the receiver requires before applying either leg.
  for (const pair of selectPotentialCrossJAccountInputPairs(outputs, {
    allowDifferentSourceRuntimeFrames: true,
  })) {
    const indexes = [pair.sourceInputIndex, pair.targetInputIndex];
    if (indexes.some(index => claimed.has(index))) continue;
    indexes.forEach(index => claimed.add(index));
    indexed.push({
      firstIndex: Math.min(...indexes),
      outputs: [outputs[pair.targetInputIndex]!, outputs[pair.sourceInputIndex]!],
      atomic: true,
      complete: true,
    });
  }

  for (const [index, output] of outputs.entries()) {
    if (claimed.has(index)) continue;
    const incompleteCrossJ = isCrossJAdmissionProposal(output);
    indexed.push({
      firstIndex: index,
      outputs: [output],
      atomic: incompleteCrossJ,
      complete: !incompleteCrossJ,
    });
  }
  return indexed
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(({ firstIndex: _firstIndex, ...unit }) => unit);
};

const overwriteRoutedEntityOutput = <T extends RoutedEntityInput>(target: T, source: T): T => {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, source);
  return target;
};

const selectCanonicalReliableOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T =>
  compareStableText(
    encodeCanonicalEntityConsensusValue(existing),
    encodeCanonicalEntityConsensusValue(incoming),
  ) <= 0 ? existing : incoming;

export const mergeRoutedEntityOutput = <T extends RoutedEntityInput>(existing: T, incoming: T): T => {
  const existingReliable = getReliableOutputIdentity(existing);
  const incomingReliable = getReliableOutputIdentity(incoming);
  if (existingReliable || incomingReliable) {
    if (!existingReliable || !incomingReliable) {
      throw new Error('ROUTE_RELIABLE_MERGE_KIND_MISMATCH');
    }
    assertReliableEvidenceCompatible(existingReliable, incomingReliable);
    if (
      existingReliable.laneKey === incomingReliable.laneKey &&
      existingReliable.order === incomingReliable.order &&
      existingReliable.variantOrder === incomingReliable.variantOrder &&
      existingReliable.logicalKey !== incomingReliable.logicalKey
    ) {
      throw new Error(
        `ROUTE_RELIABLE_LANE_ORDER_CONFLICT:${existingReliable.kind}:${existingReliable.order}`,
      );
    }
    if (
      existingReliable.kind !== incomingReliable.kind ||
      existingReliable.logicalKey !== incomingReliable.logicalKey
    ) {
      throw new Error('ROUTE_RELIABLE_IDENTITY_MISMATCH');
    }
    const existingRuntimeId = normalizeRuntimeId(existing.runtimeId);
    const incomingRuntimeId = normalizeRuntimeId(incoming.runtimeId);
    if (
      existingRuntimeId &&
      incomingRuntimeId &&
      existingRuntimeId !== incomingRuntimeId
    ) {
      throw new Error(
        `ROUTE_RELIABLE_RUNTIME_BINDING_CONFLICT:${existingReliable.kind}:${existingReliable.order}`,
      );
    }
    // runtimeId is transport binding, not reliable evidence. Deterministic
    // Entity replay can re-materialize the same signed output without that
    // binding. Never let canonical payload selection erase the already
    // verified destination: a receiver can then return an exact signed receipt
    // that the restored sender cannot associate with its durable outbox.
    const retainedRuntimeId = existingRuntimeId || incomingRuntimeId;
    const retainRuntimeBinding = (output: T): T => {
      if (retainedRuntimeId) output.runtimeId = retainedRuntimeId;
      return output;
    };

    if (existingReliable.kind === 'hash-precommit') {
      const normalizePrecommits = (
        bundles: Map<string, string[]>,
        source: string,
      ): Map<string, string[]> => {
        const normalized = new Map<string, string[]>();
        for (const [rawSignerId, signatures] of bundles) {
          const signerId = normalizeRouteText(rawSignerId);
          if (normalized.has(signerId)) {
            throw new Error(`ROUTE_PRECOMMIT_DUPLICATE_SIGNER:${source}:${rawSignerId}`);
          }
          normalized.set(signerId, [...signatures]);
        }
        return normalized;
      };
      const mergedPrecommits = normalizePrecommits(existing.hashPrecommits!, 'existing');
      const normalizedIncoming = normalizePrecommits(incoming.hashPrecommits!, 'incoming');
      for (const [signerId, signatures] of normalizedIncoming) {
        const previous = mergedPrecommits.get(signerId);
        if (previous) {
          const exactDuplicate = previous.length === signatures.length &&
            previous.every((signature, index) => signature === signatures[index]);
          if (!exactDuplicate) throw new Error(`ROUTE_PRECOMMIT_EQUIVOCATION:${signerId}`);
          continue;
        }
        mergedPrecommits.set(signerId, [...signatures]);
      }
      existing.hashPrecommits = new Map(
        [...mergedPrecommits.entries()].sort(([left], [right]) => compareStableText(left, right)),
      );
      return retainRuntimeBinding(existing);
    }

    if (existingReliable.kind === 'entity-frame') {
      const existingIsCommit = carriesEntityCommitNotification(existing);
      const incomingIsCommit = carriesEntityCommitNotification(incoming);
      if (existingIsCommit !== incomingIsCommit) {
        return retainRuntimeBinding(
          incomingIsCommit ? overwriteRoutedEntityOutput(existing, incoming) : existing,
        );
      }
    }
    const canonical = selectCanonicalReliableOutput(existing, incoming);
    return retainRuntimeBinding(
      canonical === existing ? existing : overwriteRoutedEntityOutput(existing, incoming),
    );
  }

  const existingAccountProposal = accountProposalOutputIdentity(existing);
  if (existingAccountProposal && existingAccountProposal === accountProposalOutputIdentity(incoming)) {
    const evidenceDelta = accountProposalEvidenceRank(incoming) - accountProposalEvidenceRank(existing);
    if (evidenceDelta !== 0) {
      return evidenceDelta > 0 ? overwriteRoutedEntityOutput(existing, incoming) : existing;
    }
    const existingFrame = existing.sourceRuntimeFrame;
    const incomingFrame = incoming.sourceRuntimeFrame;
    const incomingIsNewer = Boolean(incomingFrame && (!existingFrame ||
      incomingFrame.height > existingFrame.height ||
      (incomingFrame.height === existingFrame.height && incomingFrame.timestamp > existingFrame.timestamp)));
    if (incomingIsNewer) return overwriteRoutedEntityOutput(existing, incoming);
    const canonical = selectCanonicalReliableOutput(existing, incoming);
    return canonical === existing ? existing : overwriteRoutedEntityOutput(existing, incoming);
  }

  if (incoming.leaderTimeoutVote || existing.leaderTimeoutVote) {
    if (
      encodeCanonicalEntityConsensusValue(incoming.leaderTimeoutVote) !==
      encodeCanonicalEntityConsensusValue(existing.leaderTimeoutVote)
    ) {
      throw new Error(`ROUTE_LEADER_VOTE_EQUIVOCATION:${incoming.leaderTimeoutVote?.voterId ?? 'missing'}`);
    }
  }
  if (incoming.entityTxs?.length) {
    existing.entityTxs = [...(existing.entityTxs || []), ...incoming.entityTxs];
  }
  if (incoming.proposedFrame) {
    const existingIsCommit = carriesEntityCommitNotification(existing);
    const incomingIsCommit = carriesEntityCommitNotification(incoming);
    if (!existing.proposedFrame || (incomingIsCommit && !existingIsCommit)) {
      existing.proposedFrame = incoming.proposedFrame;
    }
  }
  return existing;
};

export type PlannedRemoteOutput = {
  output: DeliverableEntityInput;
  targetRuntimeId: string;
};

type RuntimeP2PDispatch = {
  enqueueEntityInputsDelivery(targetRuntimeId: string, envelope: RuntimeEntityInputsEnvelope, ingressTimestamp?: number): DeliveryResult;
  getVerifiedRuntimeRoute?(entityId: string): { runtimeId: string; lastUpdated: number } | null;
};

export type RuntimeDirectEntityInputDispatchResult = DeliveryResult;

export type RuntimeEntityInputRoutingResult = {
  delivery: DeliveryResult;
};

export type RuntimeOutputRoutingDeps = {
  ensureRuntimeState(env: Env): NonNullable<Env['runtimeState']>;
  getP2P(env: Env): RuntimeP2PDispatch | null;
  enqueueRuntimeInputs(
    env: Env,
    entityInputs: RoutedEntityInput[],
    runtimeTxs?: never,
    jInputs?: never,
    ingressTimestamp?: number,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: Env, entityId: string): boolean;
  hasLocalSignerForEntitySigner(env: Env, entityId: string, signerId: string): boolean;
  resolveSoleLocalSignerForEntity(env: Env, entityId: string): string | null;
  resolveRuntimeIdForEntity(env: Env, entityId: string): string | null;
  resolveRuntimeIdForCrossJurisdictionEntity(env: Env, entityId: string): string | null;
};

const getDeferredNetworkMeta = (
  env: Env,
  deps: RuntimeOutputRoutingDeps,
): NonNullable<NonNullable<Env['runtimeState']>['deferredNetworkMeta']> => {
  const state = deps.ensureRuntimeState(env);
  if (!state.deferredNetworkMeta) {
    state.deferredNetworkMeta = new Map();
  }
  return state.deferredNetworkMeta;
};

const reportRetryableRouteDefer = (
  env: Env,
  deps: RuntimeOutputRoutingDeps,
  output: RoutedEntityInput,
  details: Record<string, unknown>,
): void => {
  const attempts = (getDeferredNetworkMeta(env, deps).get(buildRouteOutputKey(output))?.attempts ?? 0) + 1;
  const payload = { ...details, attempts };
  routeLog.info('output.deferred', {
    ...payload,
    entityId: output.entityId,
    signerId: output.signerId,
    runtimeId: output.runtimeId ?? null,
    sourceRuntimeFrame: output.sourceRuntimeFrame ?? null,
    reliableIdentity: getReliableOutputIdentity(output),
    txTypes: (output.entityTxs ?? []).map(tx => tx.type),
  });
  // A deferred output remains durably queued and retryable. Repetition is
  // backpressure telemetry, not a degraded-state verdict; terminal delivery
  // failures are reported by their explicit terminal path.
  env.info?.('network', 'ROUTE_SEND_DEFERRED', payload);
};

const getRuntimeNowMs = (env: Env): number => env.timestamp ?? 0;

// Retry metadata must stay in one clock domain. Deterministic scenarios own
// logical time explicitly; production transport retries are wall-clock I/O.
// Mixing Unix time into a scenario retry makes the envelope unreachable forever.
const getNetworkRetryNowMs = (env: Env): number =>
  env.scenarioMode ? getRuntimeNowMs(env) : getWallClockMs();

const toDeliverableEntityInput = (
  output: RoutedEntityInput,
  targetRuntimeId: string,
): DeliverableEntityInput => {
  const deliverable: DeliverableEntityInput = {
    ...output,
    runtimeId: targetRuntimeId,
  };
  return validateDeliverableEntityInput(deliverable);
};

const isTriggerOnlyOutput = (output: RoutedEntityInput): boolean =>
  (output.entityTxs?.length ?? 0) === 0 &&
  !output.proposedFrame &&
  !output.leaderTimeoutVote &&
  (!output.jPrefixAttestations || output.jPrefixAttestations.size === 0) &&
  (!output.hashPrecommits || output.hashPrecommits.size === 0);

const isTxBearingOutput = (output: RoutedEntityInput): boolean =>
  (output.entityTxs?.length ?? 0) > 0;

const buildRoutingDeliveryResult = (input: {
  remoteCount: number;
  localCount: number;
  pendingCount: number;
}): DeliveryResult => {
  if (input.pendingCount > 0) {
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DEFERRED_OUTPUTS',
    });
  }
  if (input.remoteCount > 0 && input.localCount > 0) {
    return deliveryAccepted('ROUTE_REMOTE_AND_LOCAL_ACCEPTED');
  }
  if (input.remoteCount > 0) {
    return deliveryAccepted('ROUTE_REMOTE_DELIVERED');
  }
  if (input.localCount > 0) {
    return deliveryQueued({
      code: 'ROUTE_LOCAL_QUEUED',
      retryable: false,
      terminal: true,
    });
  }
  return deliveryAccepted('ROUTE_NOOP');
};

const enqueueP2PEntityInputsDelivery = (
  p2p: RuntimeP2PDispatch,
  targetRuntimeId: string,
  envelope: RuntimeEntityInputsEnvelope,
  ingressTimestamp: number | undefined,
): DeliveryResult => {
  return requireDeliveryResult(
    p2p.enqueueEntityInputsDelivery(targetRuntimeId, envelope, ingressTimestamp),
    'ROUTE_P2P_INVALID_DELIVERY_RESULT',
  );
};

const readBoardValidatorSignerId = (validator: unknown): string => {
  if (typeof validator === 'string') return validator.trim();
  if (!validator || typeof validator !== 'object') return '';
  const raw = validator as { signerId?: unknown; signer?: unknown };
  return String(raw.signerId || raw.signer || '').trim();
};

const resolveGossipBoardSignerIds = (env: Env, entityId: string): string[] => {
  const targetEntityId = String(entityId || '').trim().toLowerCase();
  if (!targetEntityId || !env.gossip?.getProfiles) return [];
  const profile = env.gossip.getProfiles().find(candidate =>
    String(candidate?.entityId || '').trim().toLowerCase() === targetEntityId,
  );
  const validators = profile?.metadata?.board?.validators;
  if (!Array.isArray(validators) || validators.length === 0) return [];
  return validators.map(readBoardValidatorSignerId).filter(Boolean);
};

export const splitPendingOutputsByRetryWindow = (
  env: Env,
  pending: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): { ready: RoutedEntityInput[]; waiting: RoutedEntityInput[] } => {
  if (pending.length === 0) return { ready: [], waiting: [] };
  const nowMs = getNetworkRetryNowMs(env);
  const meta = getDeferredNetworkMeta(env, deps);
  const ready: RoutedEntityInput[] = [];
  const waiting: RoutedEntityInput[] = [];
  const restoredReliableDue = hasRestoredReliableOutputsDue(env);
  // HOL is scoped to an exact comparable protocol lane. Entity-frame,
  // account-ACK and J-finality heights are not mutually comparable; a
  // universal per-Entity queue can deadlock the protocols against each other.
  const blockedReliableLanes = new Set<string>();
  const orderedPending = buildPendingNetworkOutputs(pending);
  const readyAccountAckLanes = new Set(
    orderedPending.flatMap(output => {
      const identity = getReliableOutputIdentity(output);
      if (!identity || !isAccountAckIdentity(identity)) return [];
      const retry = meta.get(buildRouteOutputKey(output));
      return !retry || (!retry.manual && retry.nextRetryAt <= nowMs) ? [identity.laneKey] : [];
    }),
  );

  for (const unit of groupAtomicCrossJAdmissionOutputs(orderedPending)) {
    if (unit.atomic) {
      if (!unit.complete) {
        waiting.push(...unit.outputs);
        continue;
      }
      const reliableOutputs = unit.outputs.filter(output => getReliableOutputIdentity(output) !== null);
      const reliable = reliableOutputs
        .map(output => getReliableOutputIdentity(output)!)
        .filter((identity): identity is ReliableOutputIdentity => identity !== null);
      const retryFenceOutputs = reliableOutputs.length > 0 ? reliableOutputs : unit.outputs;
      const manuallyPaused = retryFenceOutputs.some(output =>
        meta.get(buildRouteOutputKey(output))?.manual === true);
      const due = !manuallyPaused && ((restoredReliableDue && reliable.length > 0) || retryFenceOutputs.some(output => {
        const entry = meta.get(buildRouteOutputKey(output));
        return !entry || entry.nextRetryAt <= nowMs;
      }));
      if (due) {
        ready.push(...unit.outputs);
      } else {
        waiting.push(...unit.outputs);
        reliable.forEach(identity => blockedReliableLanes.add(identity.laneKey));
      }
      continue;
    }
    const output = unit.outputs[0]!;
    const reliable = getReliableOutputIdentity(output);
    if (
      reliable &&
      reliable.kind !== 'account-ack' &&
      blockedReliableLanes.has(reliable.laneKey)
    ) {
      waiting.push(output);
      continue;
    }
    const key = buildRouteOutputKey(output);
    const entry = meta.get(key);
    if ((restoredReliableDue && reliable) || !entry || entry.nextRetryAt <= nowMs) {
      ready.push(output);
      continue;
    }
    if (reliable && isAccountAckIdentity(reliable) && readyAccountAckLanes.has(reliable.laneKey)) {
      // A newly produced ACK proves the peer already signed the Account chain
      // through its predecessor. Wake and emit every older ACK first, then the
      // new ACK in the same pass; a separate delivery receipt must not add a
      // Runtime-frame boundary to bilateral consensus.
      ready.push(output);
      continue;
    }
    waiting.push(output);
    if (reliable && reliable.kind !== 'account-ack') blockedReliableLanes.add(reliable.laneKey);
  }
  return { ready, waiting };
};

export const getNextNetworkRetryTimestamp = (
  env: Env,
  deps: RuntimeOutputRoutingDeps,
): number | null => {
  const pending = env.pendingNetworkOutputs ?? [];
  if (pending.length === 0) return null;
  const meta = getDeferredNetworkMeta(env, deps);
  if (
    hasRestoredReliableOutputsDue(env) &&
    pending.some(output =>
      getReliableOutputIdentity(output) !== null &&
      meta.get(buildRouteOutputKey(output))?.manual !== true)
  ) return 0;
  let nextRetryAt = Infinity;
  const blockedUntilByReliableLane = new Map<string, number>();
  const retryScheduledOutputs = groupAtomicCrossJAdmissionOutputs(buildPendingNetworkOutputs(pending))
    .flatMap((unit) => {
      if (!unit.atomic) return unit.outputs;
      if (!unit.complete) return [];
      const reliableOutputs = unit.outputs.filter(
        output => getReliableOutputIdentity(output) !== null,
      );
      // The ordinary source proposal is inseparable from its reliable target
      // ACK. It deliberately has no independent retry metadata: using its
      // implicit deadline=0 here made hasRuntimeWork() spin while the atomic
      // splitter correctly kept the whole envelope in its waiting set.
      return reliableOutputs.length > 0 ? reliableOutputs : unit.outputs;
    });
  for (const output of retryScheduledOutputs) {
    const retry = meta.get(buildRouteOutputKey(output));
    if (retry?.manual) continue;
    const ownRetryAt = retry?.nextRetryAt ?? 0;
    const reliable = getReliableOutputIdentity(output);
    if (!reliable) {
      nextRetryAt = Math.min(nextRetryAt, ownRetryAt);
      continue;
    }
    const effectiveRetryAt = reliable.kind === 'account-ack'
      ? ownRetryAt
      : Math.max(ownRetryAt, blockedUntilByReliableLane.get(reliable.laneKey) ?? 0);
    if (reliable.kind !== 'account-ack') {
      blockedUntilByReliableLane.set(reliable.laneKey, effectiveRetryAt);
    }
    nextRetryAt = Math.min(nextRetryAt, effectiveRetryAt);
  }
  return Number.isFinite(nextRetryAt) ? nextRetryAt : null;
};

export const hasReadyPendingNetworkOutputs = (
  env: Env,
  deps: RuntimeOutputRoutingDeps,
  now = getNetworkRetryNowMs(env),
): boolean => {
  const nextRetryAt = getNextNetworkRetryTimestamp(env, deps);
  const comparableNow = env.scenarioMode ? getNetworkRetryNowMs(env) : now;
  return nextRetryAt !== null && nextRetryAt <= comparableNow;
};

const outputDeliveryPriority = (output: RoutedEntityInput): number => {
  if (output.proposedFrame) return 0;
  if (output.leaderTimeoutVote) return 0;
  if (output.hashPrecommits && output.hashPrecommits.size > 0) return 0;
  const txTypes = new Set((output.entityTxs ?? []).map(tx => tx.type));
  if ([...txTypes].some(type => type === 'j_event' || type.startsWith('dispute'))) return 0;
  if (txTypes.has('accountInput')) return 2;
  return 3;
};

const compareEntityFrameDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number => {
  const leftIdentity = getEntityFrameIdentity(left);
  const rightIdentity = getEntityFrameIdentity(right);
  if (!leftIdentity) return rightIdentity ? 1 : 0;
  if (!rightIdentity) return -1;
  return compareStableText(left.runtimeId ?? '', right.runtimeId ?? '') ||
    compareStableText(leftIdentity.entityId, rightIdentity.entityId) ||
    compareStableText(left.signerId, right.signerId) ||
    leftIdentity.height - rightIdentity.height ||
    compareStableText(leftIdentity.frameHash, rightIdentity.frameHash);
};

const certifiedOutputDeliveryOrder = (output: RoutedEntityInput): {
  sourceEntityId: string;
  targetEntityId: string;
  lane: string;
  sequence: bigint;
} | null => {
  const tx = output.entityTxs?.find(candidate => candidate.type === 'consensusOutput');
  if (!tx || tx.type !== 'consensusOutput') return null;
  return {
    sourceEntityId: tx.data.origin.sourceEntityId.toLowerCase(),
    targetEntityId: tx.data.targetEntityId.toLowerCase(),
    lane: tx.data.origin.lane,
    sequence: tx.data.origin.sequence,
  };
};

const compareCertifiedOutputDelivery = (
  left: RoutedEntityInput,
  right: RoutedEntityInput,
): number => {
  const leftOrder = certifiedOutputDeliveryOrder(left);
  const rightOrder = certifiedOutputDeliveryOrder(right);
  if (!leftOrder || !rightOrder) return 0;
  return compareStableText(left.runtimeId ?? '', right.runtimeId ?? '') ||
    compareStableText(leftOrder.sourceEntityId, rightOrder.sourceEntityId) ||
    compareStableText(leftOrder.targetEntityId, rightOrder.targetEntityId) ||
    compareStableText(leftOrder.lane, rightOrder.lane) ||
    (leftOrder.sequence < rightOrder.sequence ? -1 : leftOrder.sequence > rightOrder.sequence ? 1 : 0);
};

const compareOutputDelivery = (left: RoutedEntityInput, right: RoutedEntityInput): number => {
  const leftReliable = getReliableOutputIdentity(left);
  const rightReliable = getReliableOutputIdentity(right);
  if (leftReliable && rightReliable) {
    return compareStableText(leftReliable.laneKey, rightReliable.laneKey) ||
      leftReliable.order - rightReliable.order ||
      leftReliable.variantOrder - rightReliable.variantOrder ||
      compareStableText(leftReliable.evidenceKind, rightReliable.evidenceKind) ||
      compareStableText(leftReliable.evidenceDigest, rightReliable.evidenceDigest) ||
      compareStableText(leftReliable.logicalKey, rightReliable.logicalKey);
  }
  if (leftReliable) return -1;
  if (rightReliable) return 1;
  return compareCertifiedOutputDelivery(left, right) ||
    outputDeliveryPriority(left) - outputDeliveryPriority(right) ||
    compareEntityFrameDelivery(left, right) ||
    compareStableText(buildRouteOutputKey(left), buildRouteOutputKey(right));
};

export const buildPendingNetworkOutputs = (outputs: RoutedEntityInput[]): RoutedEntityInput[] => {
  const deduped = new Map<string, RoutedEntityInput>();
  const identitiesByLaneOrder = new Map<string, ReliableOutputIdentity[]>();
  const splitOutputs = outputs.flatMap(output => splitRoutedOutputByDeliveryLane(output));
  for (const output of splitOutputs) {
    const reliable = getReliableOutputIdentity(output);
    if (reliable) {
      const laneOrderKey = safeStringify({
        laneKey: reliable.laneKey,
        order: reliable.order,
        variantOrder: reliable.variantOrder,
      });
      const existingIdentities = identitiesByLaneOrder.get(laneOrderKey) ?? [];
      for (const existingIdentity of existingIdentities) {
        assertReliableEvidenceCompatible(existingIdentity, reliable);
      }
      existingIdentities.push(reliable);
      identitiesByLaneOrder.set(laneOrderKey, existingIdentities);
    }
    const key = buildRouteOutputKey(output);
    const existing = deduped.get(key);
    if (existing) mergeRoutedEntityOutput(existing, output);
    else deduped.set(key, cloneRoutedOutputWithCachedIdentity(output));
  }
  const pending = [...deduped.values()]
    .map(output => output.entityTxs
      ? { ...output, entityTxs: orderCertifiedOutputsBySequence(output.entityTxs) }
      : output)
    .sort(compareOutputDelivery);
  const certifiedEntityFrames = new Set<string>();
  for (const output of pending) {
    const identity = getReliableOutputIdentity(output);
    if (identity?.kind !== 'entity-frame' || identity.evidenceKind !== 'entity-certificate') continue;
    certifiedEntityFrames.add(safeStringify({
      runtimeId: normalizeRuntimeId(output.runtimeId),
      laneKey: identity.laneKey,
      logicalKey: identity.logicalKey,
    }));
  }
  const superseded = pending.filter(output => {
    const identity = getReliableOutputIdentity(output);
    if (identity?.kind !== 'entity-frame' || identity.evidenceKind !== 'entity-proposal') return true;
    return !certifiedEntityFrames.has(safeStringify({
      runtimeId: normalizeRuntimeId(output.runtimeId),
      laneKey: identity.laneKey,
      logicalKey: identity.logicalKey,
    }));
  });
  if (superseded.length > MAX_PENDING_NETWORK_OUTPUTS) {
    throw new Error(
      `NETWORK_OUTBOX_CAPACITY_EXCEEDED: pending=${superseded.length} max=${MAX_PENDING_NETWORK_OUTPUTS}`,
    );
  }
  return superseded;
};

/**
 * A persisted reliable outbox is authoritative, but its wall-clock deadline is
 * not. Restarting begins a new transport session, so every committed lane head
 * is immediately eligible for one real send attempt. Preserve the attempt
 * counter for diagnostics; only reset the operational deadline. A subsequent
 * failed attempt records a fresh bounded backoff in the new process.
 */
export const markRestoredReliableOutputsDue = (env: Env): void => {
  if (!(env.pendingNetworkOutputs ?? []).some(output => getReliableOutputIdentity(output) !== null)) return;
  Object.defineProperty(env, RESTORED_RELIABLE_OUTPUTS_DUE, {
    configurable: true,
    // Runtime frames execute on a shallow-cloned Env. Keep this Symbol
    // enumerable so object spread carries the volatile wake marker into that
    // transaction; string-keyed storage/canonical codecs still exclude it.
    enumerable: true,
    value: true,
  });
};

/**
 * A committed receiver receipt is authoritative for the exact reliable output.
 * Entity replay may deterministically re-emit that output later; retaining it
 * would let an already-finished lane head block the next sparse Account ACK.
 * Coverage remains exact: a lower height, richer evidence, or conflicting hash
 * is never collected by a higher/different receipt.
 */
export const pruneReceiptedReliableOutputs = (
  env: Env,
  outputs: RoutedEntityInput[],
  appliedReceipts: readonly ReliableDeliveryReceipt[] = [],
): RoutedEntityInput[] => {
  // Proposal cohorts intentionally have no transport receipt. Their business
  // terminal is the ordinary bilateral Account ACK that commits the exact
  // proposed frame on both Hub sibling Entities. Once both frames are current,
  // keep no transport retry state: retaining the original proposal envelope
  // would either leak outbox entries forever or invite a manual duplicate.
  const uncommittedOutputs = groupAtomicCrossJAdmissionOutputs(outputs).flatMap(unit => {
    const committedProposalCohort = unit.atomic && unit.complete &&
      unit.outputs.every(output =>
        getReliableOutputIdentity(output) === null && accountProposalCommittedBySender(env, output));
    if (!committedProposalCohort) return unit.outputs;
    for (const output of unit.outputs) {
      env.runtimeState?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
    }
    return [];
  });
  const active = env.runtimeState?.receivedReliableReceiptLedger;
  const terminal = env.runtimeState?.receivedReliableTerminalWatermarks;
  if ((!active || active.size === 0) && (!terminal || terminal.size === 0)) {
    return uncommittedOutputs;
  }
  const receiptsByFrontier = new Map<string, ReliableDeliveryReceipt[]>();
  for (const receipt of appliedReceipts) {
    const key = senderFrontierKey(receipt);
    const lane = receiptsByFrontier.get(key) ?? [];
    lane.push(receipt);
    receiptsByFrontier.set(key, lane);
  }
  const isReceipted = (output: RoutedEntityInput): boolean => {
    const identity = getReliableOutputIdentity(output);
    const receiverRuntimeId = normalizeRuntimeId(output.runtimeId);
    if (!identity || !receiverRuntimeId) return false;
    const frontierKey = senderFrontierKeyForIdentity(receiverRuntimeId, identity);
    return [
      active?.get(frontierKey),
      terminal?.get(frontierKey),
      ...(receiptsByFrontier.get(frontierKey) ?? []),
    ]
      .some(receipt => receipt && reliableReceiptCoversIdentity(receipt, identity));
  };
  const retained: RoutedEntityInput[] = [];
  for (const unit of groupAtomicCrossJAdmissionOutputs(uncommittedOutputs)) {
    if (!unit.complete) {
      retained.push(...unit.outputs);
      continue;
    }
    const reliableOutputs = unit.outputs.filter(output => getReliableOutputIdentity(output) !== null);
    if (
      unit.atomic &&
      reliableOutputs.length > 0 &&
      reliableOutputs.every(isReceipted)
    ) {
      for (const output of unit.outputs) {
        env.runtimeState?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
      }
      continue;
    }
    for (const output of unit.outputs) {
      if (!isReceipted(output)) {
        retained.push(output);
        continue;
      }
      env.runtimeState?.deferredNetworkMeta?.delete(buildRouteOutputKey(output));
    }
  }
  return retained;
};

export const rescheduleDeferredOutputs = (
  env: Env,
  attemptedPending: RoutedEntityInput[],
  failed: RoutedEntityInput[],
  waiting: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): RoutedEntityInput[] => {
  const meta = getDeferredNetworkMeta(env, deps);
  const failedKeys = new Set(failed.map(output => buildRouteOutputKey(output)));

  for (const output of attemptedPending) {
    const key = buildRouteOutputKey(output);
    if (!failedKeys.has(key)) {
      meta.delete(key);
    }
  }

  const nowMs = getNetworkRetryNowMs(env);
  const retriedReliableLanes = new Set<string>();
  for (const unit of groupAtomicCrossJAdmissionOutputs(buildPendingNetworkOutputs(failed))) {
    if (!unit.complete) continue;
    // A cross-j Account cohort must remain one durable envelope, but it must not
    // replay itself after a peer outage. The operator explicitly re-arms it once
    // that peer is known online; until then both Account frames stay paused here.
    // Proposal cohorts are ordinary Account frames, while ACK cohorts carry
    // reliable identities. Both phases still have the same retry contract:
    // after one transport attempt the complete envelope stays paused until an
    // operator explicitly re-arms it. Fencing only reliable outputs made the
    // proposal phase immediately due again and replayed both money legs on
    // every Runtime tick.
    const retryOutputs = unit.outputs;
    for (const output of retryOutputs) {
      const reliable = getReliableOutputIdentity(output);
      if (
        !unit.atomic
        && reliable
        && reliable.kind !== 'account-ack'
        && retriedReliableLanes.has(reliable.laneKey)
      ) {
        meta.delete(buildRouteOutputKey(output));
        continue;
      }
      const key = buildRouteOutputKey(output);
      const attempts = (meta.get(key)?.attempts ?? 0) + 1;
      const retryMaxMs = reliable ? RELIABLE_NETWORK_RETRY_MAX_MS : NETWORK_RETRY_MAX_MS;
      const delayMs = Math.min(retryMaxMs, NETWORK_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 5)));
      meta.set(key, {
        attempts,
        nextRetryAt: unit.atomic ? nowMs : nowMs + delayMs,
        ...(unit.atomic ? { manual: true as const } : {}),
      });
      if (reliable) retriedReliableLanes.add(reliable.laneKey);
    }
  }

  if (attemptedPending.some(output => getReliableOutputIdentity(output) !== null)) {
    clearRestoredReliableOutputsDue(env);
  }

  return buildPendingNetworkOutputs([...failed, ...waiting]);
};

export const markPendingCrossJAdmissionOutputsReady = (
  env: Env,
  deps: RuntimeOutputRoutingDeps,
  targetRuntimeId?: string,
): number => {
  const normalizedTarget = targetRuntimeId ? normalizeRuntimeId(targetRuntimeId) : '';
  const meta = getDeferredNetworkMeta(env, deps);
  const nowMs = getNetworkRetryNowMs(env);
  let readyEnvelopes = 0;
  for (const unit of groupAtomicCrossJAdmissionOutputs(
    buildPendingNetworkOutputs(env.pendingNetworkOutputs ?? []),
  )) {
    if (!unit.atomic || !unit.complete) continue;
    if (normalizedTarget && unit.outputs.some(output => normalizeRuntimeId(output.runtimeId) !== normalizedTarget)) {
      continue;
    }
    const retryOutputs = unit.outputs;
    if (!retryOutputs.some(output => meta.get(buildRouteOutputKey(output))?.manual === true)) continue;
    for (const output of retryOutputs) {
      const key = buildRouteOutputKey(output);
      meta.set(key, {
        attempts: meta.get(key)?.attempts ?? 0,
        nextRetryAt: nowMs,
      });
    }
    readyEnvelopes += 1;
  }
  return readyEnvelopes;
};

export const planEntityOutputs = (
  env: Env,
  outputs: RoutedEntityInput[],
  deps: RuntimeOutputRoutingDeps,
): {
  localOutputs: RoutedEntityInput[];
  remoteOutputs: PlannedRemoteOutput[];
  deferredOutputs: RoutedEntityInput[];
} => {
  const localOutputs: RoutedEntityInput[] = [];
  const remoteOutputs: PlannedRemoteOutput[] = [];
  const deduped = new Map<string, RoutedEntityInput>();
  for (const output of outputs.flatMap(candidate => splitRoutedOutputByDeliveryLane(candidate))) {
    const key = buildRouteOutputKey(output);
    const existing = deduped.get(key);
    if (existing) {
      mergeRoutedEntityOutput(existing, output);
    } else {
      deduped.set(key, cloneRoutedOutputWithCachedIdentity(output));
    }
  }
  const allOutputs = [...deduped.values()];
  const deferredOutputs: RoutedEntityInput[] = [];

  for (const output of allOutputs) {
    if (deps.hasLocalSignerForEntitySigner(env, output.entityId, output.signerId)) {
      localOutputs.push(output);
      continue;
    }
    if (deps.hasLocalSignerForEntity(env, output.entityId)) {
      const resolvedSignerId = deps.resolveSoleLocalSignerForEntity(env, output.entityId);
      if (resolvedSignerId && isTriggerOnlyOutput(output)) {
        env.warn('network', 'ROUTE_RETARGET_LOCAL_TRIGGER_SIGNER', {
          entityId: output.entityId,
          inputSignerId: output.signerId,
          resolvedSignerId,
        }, output.entityId);
        localOutputs.push({ ...output, signerId: resolvedSignerId });
        continue;
      }
      if (resolvedSignerId) {
        if (!isTxBearingOutput(output)) {
          env.error?.('network', 'ROUTE_LOCAL_SIGNER_MISMATCH', {
            entityId: output.entityId,
            signerId: output.signerId,
            resolvedSignerId,
            hasProposedFrame: Boolean(output.proposedFrame),
            hasHashPrecommits: Boolean(output.hashPrecommits && output.hashPrecommits.size > 0),
          }, output.entityId);
          throw new Error(
            `ROUTE_LOCAL_SIGNER_MISMATCH: entity=${output.entityId} signer=${output.signerId} ` +
            `resolved=${resolvedSignerId} consensusOnly=true`,
          );
        }
        env.error?.('network', 'ROUTE_LOCAL_SIGNER_MISMATCH', {
          entityId: output.entityId,
          signerId: output.signerId,
          txTypes: (output.entityTxs || []).map(tx => tx.type),
        }, output.entityId);
        throw new Error(
          `ROUTE_LOCAL_SIGNER_MISMATCH: entity=${output.entityId} signer=${output.signerId} ` +
          `txTypes=${(output.entityTxs || []).map(tx => tx.type).join(',')}`,
        );
      }
    }
    let outputToRoute = output;
    const gossipSignerIds = resolveGossipBoardSignerIds(env, output.entityId);
    const preferredGossipSignerId = gossipSignerIds[0] || '';
    const outputSignerId = String(output.signerId || '').trim();
    const outputSignerKnownByGossip = gossipSignerIds.some(
      signerId => signerId.toLowerCase() === outputSignerId.toLowerCase(),
    );
    if (preferredGossipSignerId && preferredGossipSignerId.toLowerCase() !== outputSignerId.toLowerCase()) {
      if (isTriggerOnlyOutput(output)) {
        env.warn?.('network', 'ROUTE_RETARGET_REMOTE_PROFILE_SIGNER', {
          entityId: output.entityId,
          inputSignerId: output.signerId,
          resolvedSignerId: preferredGossipSignerId,
        }, output.entityId);
        outputToRoute = { ...output, signerId: preferredGossipSignerId };
      } else if (isTxBearingOutput(output) && !outputSignerKnownByGossip) {
        const txTypes = (output.entityTxs || []).map(tx => tx.type);
        env.error?.('network', 'ROUTE_REMOTE_SIGNER_MISMATCH', {
          entityId: output.entityId,
          signerId: output.signerId,
          resolvedSignerId: preferredGossipSignerId,
          boardSignerIds: gossipSignerIds,
          txTypes,
          hasProposedFrame: Boolean(output.proposedFrame),
          hasHashPrecommits: Boolean(output.hashPrecommits && output.hashPrecommits.size > 0),
        }, output.entityId);
        throw new Error(
          `ROUTE_REMOTE_SIGNER_MISMATCH: entity=${output.entityId} signer=${output.signerId} ` +
          `resolved=${preferredGossipSignerId} txTypes=${txTypes.join(',')}`,
        );
      }
    }

    const persistedTargetRuntimeId = normalizeRuntimeId(String(outputToRoute.runtimeId || ''));
    const resolvedTargetRuntimeId = deps.resolveRuntimeIdForEntity(env, outputToRoute.entityId);
    const verifiedTargetRuntimeId = normalizeRuntimeId(
      deps.getP2P(env)?.getVerifiedRuntimeRoute?.(outputToRoute.entityId)?.runtimeId ?? '',
    );
    // A verified profile is transport-authenticated current routing metadata.
    // It must supersede both a durable output destination and a short-lived
    // hint: after a runtime restart those two stale values can agree and would
    // otherwise route the bilateral message to the retired runtime forever.
    if (verifiedTargetRuntimeId && persistedTargetRuntimeId !== verifiedTargetRuntimeId) {
      const routeBindingData = {
        entityId: outputToRoute.entityId,
        persistedRuntimeId: persistedTargetRuntimeId || null,
        resolvedRuntimeId: verifiedTargetRuntimeId,
      };
      if (persistedTargetRuntimeId) {
        env.warn?.('network', 'ROUTE_TARGET_RUNTIME_REBOUND', routeBindingData);
      } else {
        env.info?.('network', 'ROUTE_TARGET_RUNTIME_BOUND', routeBindingData);
      }
      outputToRoute = { ...outputToRoute, runtimeId: verifiedTargetRuntimeId };
    } else if (
      persistedTargetRuntimeId &&
      resolvedTargetRuntimeId &&
      persistedTargetRuntimeId !== resolvedTargetRuntimeId
    ) {
      if (verifiedTargetRuntimeId && verifiedTargetRuntimeId === resolvedTargetRuntimeId) {
        env.warn?.('network', 'ROUTE_TARGET_RUNTIME_REBOUND', {
          entityId: outputToRoute.entityId,
          persistedRuntimeId: persistedTargetRuntimeId,
          resolvedRuntimeId: resolvedTargetRuntimeId,
        });
        outputToRoute = { ...outputToRoute, runtimeId: resolvedTargetRuntimeId };
      } else {
        env.warn?.('network', 'ROUTE_TARGET_RUNTIME_CHANGE_UNVERIFIED', {
          entityId: outputToRoute.entityId,
          persistedRuntimeId: persistedTargetRuntimeId,
          resolvedRuntimeId: resolvedTargetRuntimeId,
        });
      }
    }
    const targetRuntimeId = normalizeRuntimeId(String(outputToRoute.runtimeId || '')) ||
      verifiedTargetRuntimeId ||
      resolvedTargetRuntimeId;
    routeLog.debug('plan.output', {
      entity: shortId(outputToRoute.entityId),
      runtime: targetRuntimeId ? shortId(targetRuntimeId, 8) : 'unknown',
    });
    if (!targetRuntimeId) {
      if (entityInputHasCrossJurisdictionIntraRuntimeTx(outputToRoute)) {
        const txTypes = (outputToRoute.entityTxs || []).map(tx => tx.type);
        env.error?.('network', 'ROUTE_TARGET_RUNTIME_UNKNOWN', {
          entityId: outputToRoute.entityId,
          txTypes,
          protocol: 'cross-j',
        });
        throw new Error(
          `ROUTE_TARGET_RUNTIME_UNKNOWN: cross-j sibling entity=${outputToRoute.entityId} ` +
          `txTypes=${txTypes.join(',')}`,
        );
      }
      reportRetryableRouteDefer(env, deps, outputToRoute, {
        entityId: outputToRoute.entityId,
        reason: 'target-runtime-unknown',
        txTypes: (outputToRoute.entityTxs || []).map(tx => tx.type),
      });
      deferredOutputs.push(outputToRoute);
      continue;
    }
    const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
    if (localRuntimeId && targetRuntimeId === localRuntimeId) {
      env.error?.('network', 'ROUTE_STALE_SELF_HINT', {
        entityId: outputToRoute.entityId,
        runtimeId: targetRuntimeId,
      });
      throw new Error(
        `ROUTE_STALE_SELF_HINT: entity=${outputToRoute.entityId} runtime=${targetRuntimeId} ` +
        `txTypes=${(outputToRoute.entityTxs || []).map(tx => tx.type).join(',')}`,
      );
    }
    if (entityInputHasCrossJurisdictionIntraRuntimeTx(outputToRoute)) {
      throw new Error(
        `CROSS_J_REMOTE_OUTPUT_FORBIDDEN: entity=${String(outputToRoute.entityId || '').toLowerCase()} ` +
        `targetRuntime=${targetRuntimeId} txTypes=${(outputToRoute.entityTxs || []).map(tx => tx.type).join(',')}`,
      );
    }
    remoteOutputs.push({ output: toDeliverableEntityInput(outputToRoute, targetRuntimeId), targetRuntimeId });
  }

  return { localOutputs, remoteOutputs, deferredOutputs };
};

const batchOutputsByTarget = (outputs: DeliverableEntityInput[]): DeliverableEntityInput[] => {
  const batched = new Map<string, DeliverableEntityInput>();

  for (const output of outputs.flatMap(candidate => splitRoutedOutputByDeliveryLane(candidate))) {
    const reliable = getReliableOutputIdentity(output);
    const laneKey = `${output.runtimeId}:${output.entityId}:${output.signerId || ''}`;
    const key = reliable
      ? `${laneKey}:${buildRouteOutputKey(output)}`
      : output.leaderTimeoutVote
        ? `${laneKey}:${buildRouteOutputKey(output)}`
        : laneKey;
    const existing = batched.get(key);

    if (existing) {
      mergeRoutedEntityOutput(existing, output);
      routeLog.debug('batch.merge', { key, txs: existing.entityTxs?.length || 0 });
    } else {
      batched.set(key, validateDeliverableEntityInput(structuredClone(output)));
    }
  }

  return Array.from(batched.values()).sort(compareOutputDelivery);
};

const requireOutputRuntimeFrame = (
  output: RoutedEntityInput,
): NonNullable<RoutedEntityInput['sourceRuntimeFrame']> => {
  const frame = output.sourceRuntimeFrame;
  if (
    !frame ||
    !Number.isSafeInteger(frame.height) ||
    frame.height < 0 ||
    !Number.isSafeInteger(frame.timestamp) ||
    frame.timestamp < 0
  ) {
    throw new Error(
      `ROUTE_SOURCE_RUNTIME_FRAME_INVALID:entity=${output.entityId}:` +
      `height=${String(frame?.height)}:timestamp=${String(frame?.timestamp)}`,
    );
  }
  return frame;
};

const outputEnvelopeGroupKey = (output: DeliverableEntityInput): string => {
  return safeStringify({
    runtimeId: normalizeRuntimeId(output.runtimeId),
  });
};

const buildRuntimeEntityInputsEnvelope = (
  env: Env,
  outputs: readonly DeliverableEntityInput[],
): RuntimeEntityInputsEnvelope => {
  if (outputs.length === 0) throw new Error('ROUTE_ENTITY_INPUTS_ENVELOPE_EMPTY');
  const sourceRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (!sourceRuntimeId) throw new Error('ROUTE_SOURCE_RUNTIME_ID_INVALID');
  const firstFrame = requireOutputRuntimeFrame(outputs[0]!);
  const explicitPair = outputs[0]?.atomicCrossJurisdictionPair;
  if (explicitPair && !outputs.every(output =>
    output.atomicCrossJurisdictionPair?.phase === explicitPair.phase &&
    output.atomicCrossJurisdictionPair.pairKey === explicitPair.pairKey)) {
    throw new Error('ROUTE_CROSS_J_ATOMIC_COHORT_MISMATCH');
  }
  const structuralPairs = selectPotentialCrossJAccountInputPairs(outputs, {
    allowDifferentSourceRuntimeFrames: true,
  });
  const inferredProposalPair = !explicitPair && outputs.length === 2 && structuralPairs.length === 1;
  const atomicCrossJurisdictionPair = explicitPair ?? (inferredProposalPair
    ? {
        phase: 'proposal' as const,
        pairKey: structuralPairs[0]!.pairKey,
      }
    : undefined);
  const envelopeFrame = atomicCrossJurisdictionPair
    ? { height: env.height, timestamp: env.timestamp }
    : firstFrame;
  const entityInputs = outputs.map(output => {
    const frame = requireOutputRuntimeFrame(output);
    if (
      !atomicCrossJurisdictionPair &&
      (frame.height !== firstFrame.height || frame.timestamp !== firstFrame.timestamp)
    ) {
      throw new Error('ROUTE_ENTITY_INPUTS_ENVELOPE_FRAME_MISMATCH');
    }
    const {
      sourceRuntimeFrame: _sourceRuntimeFrame,
      atomicCrossJurisdictionPair: _atomicCrossJurisdictionPair,
      ...input
    } = output;
    return validateDeliverableEntityInput(input);
  });
  return {
    sourceRuntimeId,
    sourceRuntimeHeight: envelopeFrame.height,
    sourceRuntimeTimestamp: envelopeFrame.timestamp,
    entityInputs,
    ...(atomicCrossJurisdictionPair ? { atomicCrossJurisdictionPair } : {}),
  };
};

const awaitsDurableEntityCertificate = (
  env: Env,
  targetRuntimeId: string,
  identity: ReliableOutputIdentity,
): boolean => {
  if (identity.kind !== 'entity-frame') return false;
  const normalizedTarget = normalizeRuntimeId(targetRuntimeId);
  if (!normalizedTarget) throw new Error('ROUTE_RELIABLE_TARGET_RUNTIME_INVALID');
  const priorReceipts = [
    ...(env.runtimeState?.receivedReliableReceiptLedger?.values() ?? []),
    ...(env.runtimeState?.receivedReliableTerminalWatermarks?.values() ?? []),
  ]
    .filter(receipt =>
      receipt.body.receiverRuntimeId === normalizedTarget &&
      receipt.body.identity.laneKey === identity.laneKey &&
      receipt.body.identity.height < identity.height);
  const proposals = new Set(
    priorReceipts
      .filter(receipt => receipt.body.identity.evidenceKind === 'entity-proposal')
      .map(receipt => receipt.body.identity.height),
  );
  const certificates = new Set(
    priorReceipts
      .filter(receipt => receipt.body.identity.evidenceKind === 'entity-certificate')
      .map(receipt => receipt.body.identity.height),
  );
  return [...proposals].some(height => !certificates.has(height));
};

export const dispatchEntityOutputs = (
  env: Env,
  outputs: PlannedRemoteOutput[],
  deps: RuntimeOutputRoutingDeps,
): RoutedEntityInput[] => {
  const state = deps.ensureRuntimeState(env);
  const directDispatch = state.directEntityInputsDispatch;
  const p2p = deps.getP2P(env);

  const groupedByEnvelope = new Map<string, {
    targetRuntimeId: string;
    outputs: DeliverableEntityInput[];
  }>();
  for (const { output, targetRuntimeId } of outputs) {
    const key = outputEnvelopeGroupKey(output);
    const group = groupedByEnvelope.get(key) ?? { targetRuntimeId, outputs: [] };
    if (group.targetRuntimeId !== targetRuntimeId) {
      throw new Error('ROUTE_ENTITY_INPUTS_ENVELOPE_TARGET_MISMATCH');
    }
    group.outputs.push(output);
    groupedByEnvelope.set(key, group);
  }

  const envelopeGroups = [...groupedByEnvelope.values()]
    .flatMap(group => {
      const units = groupAtomicCrossJAdmissionOutputs(group.outputs);
      const atomicUnits = units.filter(unit => unit.atomic);
      const ordinaryOutputs = units.filter(unit => !unit.atomic).flatMap(unit => unit.outputs);
      const ordinaryUnits = ordinaryOutputs.length > 0
        ? groupAtomicCrossJAdmissionOutputs(batchOutputsByTarget(ordinaryOutputs))
        : [];
      return [...atomicUnits, ...ordinaryUnits]
        .map(unit => ({ targetRuntimeId: group.targetRuntimeId, ...unit }));
    })
    .sort((left, right) =>
      compareStableText(left.targetRuntimeId, right.targetRuntimeId) ||
      compareOutputDelivery(left.outputs[0]!, right.outputs[0]!));

  const deferredOutputs: RoutedEntityInput[] = [];
  // Every reliable lane except Account ACK serializes handoff until exact
  // durable application. Account ACKs are emitted in canonical height order
  // without a receipt-gated pause: ACK H+1 can only exist after this same peer
  // signed Account frame H+1 on top of H, so its signed frame is already the
  // causal proof that waiting for a separate transport receipt would duplicate.
  // The receiver still queues out-of-order delivery and rejects equivocation.
  const blockedReliableLanes = new Set<string>();
  for (const group of envelopeGroups) {
    if (!group.complete) {
      throw new Error(
        `ROUTE_CROSS_J_INCOMPLETE_COHORT_MARKED_READY:${safeStringify({
          targetRuntimeId: group.targetRuntimeId,
          outputs: summarizeAccountEnvelopeOutputs(group.outputs),
          atomicPairs: group.outputs.map(output => output.atomicCrossJurisdictionPair ?? null),
          plannedOutputs: outputs.map(({ output, targetRuntimeId }) => ({
            targetRuntimeId,
            ...summarizeAccountEnvelopeOutputs([output])[0],
          })),
        })}`,
      );
    }
    const atomicCrossJAdmission = group.atomic;
    const sendable: DeliverableEntityInput[] = [];
    for (const output of group.outputs) {
      const reliable = getReliableOutputIdentity(output);
      if (
        !atomicCrossJAdmission &&
        reliable &&
        reliable.kind !== 'account-ack' &&
        blockedReliableLanes.has(reliable.laneKey)
      ) {
        deferredOutputs.push(output);
        continue;
      }
      if (reliable && awaitsDurableEntityCertificate(env, group.targetRuntimeId, reliable)) {
        deferredOutputs.push(output);
        blockedReliableLanes.add(reliable.laneKey);
        continue;
      }
      sendable.push(output);
      // A reliable lane head remains pending until its durable application
      // receipt, so later lane entries cannot share this transport envelope.
      if (reliable && reliable.kind !== 'account-ack') blockedReliableLanes.add(reliable.laneKey);
    }
    if (sendable.length === 0) continue;

    const envelope = buildRuntimeEntityInputsEnvelope(env, sendable);
    if (atomicCrossJAdmission || sendable.some(isCrossJAdmissionSourceProposal)) {
      routeLog.info('crossj.admission_envelope_dispatch', {
        atomic: atomicCrossJAdmission,
        targetRuntimeId: group.targetRuntimeId,
        sourceRuntimeHeight: envelope.sourceRuntimeHeight,
        inputCount: sendable.length,
        outputs: summarizeAccountEnvelopeOutputs(sendable),
      });
    }
    const retainReliable = (): void => {
      if (atomicCrossJAdmission) {
        deferredOutputs.push(...sendable);
        return;
      }
      deferredOutputs.push(...sendable.filter(output => getReliableOutputIdentity(output) !== null));
    };
    if (directDispatch) {
      const directDelivery = requireDeliveryResult(
        directDispatch(group.targetRuntimeId, envelope, envelope.sourceRuntimeTimestamp),
        'ROUTE_DIRECT_INVALID_DELIVERY_RESULT',
      );
      if (isDeliveryDelivered(directDelivery)) {
        routeLog.info('output.accepted', {
          atMs: getWallClockMs(),
          transport: 'direct',
          code: directDelivery.code,
          targetRuntimeId: group.targetRuntimeId,
          sourceRuntimeHeight: envelope.sourceRuntimeHeight,
          outputs: summarizeAccountEnvelopeOutputs(sendable),
        });
        retainReliable();
        continue;
      }
    }
    if (!p2p) {
      for (const output of sendable) {
        const reliable = getReliableOutputIdentity(output);
        const details = { entityId: output.entityId, runtimeId: group.targetRuntimeId };
        if (reliable) env.warn?.('network', 'ROUTE_RELIABLE_DEFERRED_NO_P2P', details);
        else env.info?.('network', 'ROUTE_DEFERRED_NO_P2P', details);
      }
      deferredOutputs.push(...sendable);
      continue;
    }

    routeLog.debug('p2p.enqueue_envelope', {
      runtime: shortId(group.targetRuntimeId, 8),
      sourceHeight: envelope.sourceRuntimeHeight,
      inputs: envelope.entityInputs.length,
    });
    let p2pDelivery: DeliveryResult | null = null;
    try {
      p2pDelivery = enqueueP2PEntityInputsDelivery(
        p2p,
        group.targetRuntimeId,
        envelope,
        envelope.sourceRuntimeTimestamp,
      );
      if (isDeliveryDelivered(p2pDelivery)) {
        routeLog.info('output.accepted', {
          atMs: getWallClockMs(),
          transport: 'p2p',
          code: p2pDelivery.code,
          targetRuntimeId: group.targetRuntimeId,
          sourceRuntimeHeight: envelope.sourceRuntimeHeight,
          outputs: summarizeAccountEnvelopeOutputs(sendable),
        });
        retainReliable();
        continue;
      }
      if (shouldRetryDelivery(p2pDelivery)) {
        for (const output of sendable) {
          reportRetryableRouteDefer(env, deps, output, {
            entityId: output.entityId,
            runtimeId: group.targetRuntimeId,
            delivery: p2pDelivery,
          });
        }
        deferredOutputs.push(...sendable);
        continue;
      }
      requireDeliveryDelivered(p2pDelivery, delivery =>
        `ROUTE_SEND_NOT_DELIVERED: runtime=${group.targetRuntimeId} ` +
        `code=${delivery.code} inputs=${sendable.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transientTransportFailure = [
        'P2P_ENTITY_INPUTS_NOT_DELIVERED',
        'P2P_ENTITY_INPUTS_SEND_THROW',
        'P2P_TRANSPORT',
        'WebSocket',
      ].some(marker => message.includes(marker));
      if ((p2pDelivery !== null && shouldRetryDelivery(p2pDelivery)) || transientTransportFailure) {
        for (const output of sendable) {
          reportRetryableRouteDefer(env, deps, output, {
            entityId: output.entityId,
            runtimeId: group.targetRuntimeId,
            error: message,
            ...(p2pDelivery ? { delivery: p2pDelivery } : {}),
          });
        }
        deferredOutputs.push(...sendable);
        continue;
      }
      env.error?.('network', 'ROUTE_SEND_FAILED', {
        runtimeId: group.targetRuntimeId,
        inputCount: sendable.length,
        error: message,
        ...(p2pDelivery ? { delivery: p2pDelivery } : {}),
      });
      throw error;
    }
  }
  return deferredOutputs.sort(compareOutputDelivery);
};

export const sendEntityInputWithRouting = (
  env: Env,
  input: RoutedEntityInput,
  deps: RuntimeOutputRoutingDeps,
): RuntimeEntityInputRoutingResult => {
  const state = deps.ensureRuntimeState(env);
  const originatedInput: RoutedEntityInput = input.sourceRuntimeFrame
    ? input
    : {
        ...input,
        sourceRuntimeFrame: {
          height: env.height,
          timestamp: env.timestamp,
        },
      };
  const pendingBeforePlan = buildPendingNetworkOutputs(pruneReceiptedReliableOutputs(env, [
    ...(env.pendingNetworkOutputs ?? []),
    originatedInput,
  ]));
  const { ready: readyPendingOutputs, waiting: waitingPendingOutputs } = splitPendingOutputsByRetryWindow(
    env,
    pendingBeforePlan,
    deps,
  );
  const { localOutputs, remoteOutputs, deferredOutputs } = planEntityOutputs(env, readyPendingOutputs, deps);
  if (remoteOutputs.length > 0 && state.recoveryBackupBarrier) {
    throw new Error('DIRECT_NETWORK_SEND_REQUIRES_COMMITTED_RECOVERY_BACKUP');
  }
  env.pendingNetworkOutputs = [];
  if (localOutputs.length > 0) {
    deps.enqueueRuntimeInputs(env, localOutputs, undefined, undefined, env.timestamp);
  }
  const deferred = dispatchEntityOutputs(env, remoteOutputs, deps);
  const remainingDeferred = [...deferredOutputs, ...deferred];
  env.pendingNetworkOutputs = rescheduleDeferredOutputs(
    env,
    readyPendingOutputs,
    remainingDeferred,
    waitingPendingOutputs,
    deps,
  );

  return {
    delivery: buildRoutingDeliveryResult({
      remoteCount: remoteOutputs.length,
      localCount: localOutputs.length,
      pendingCount: env.pendingNetworkOutputs.length,
    }),
  };
};
