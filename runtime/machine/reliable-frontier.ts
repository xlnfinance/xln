import { keccak256, toUtf8Bytes } from 'ethers';

import { encodeCanonicalEntityConsensusValue } from '../entity/consensus/state-root';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { compareStableText, safeStringify } from '../protocol/serialization';
import type {
  ReliableDeliveryEvidenceBinding,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
} from '../types';

const CANONICAL_DIGEST_PATTERN = /^0x[0-9a-f]{64}$/;

/**
 * Receiver tombstones are never evicted: eviction would make a lost receipt
 * indistinguishable from a first delivery and reopen replay/equivocation risk.
 * A hard runtime-level relationship cap keeps that safety state finite.
 */
export const MAX_RELIABLE_INGRESS_SOURCE_LANES = 10_000;

const RELIABLE_KINDS = new Set<ReliableDeliveryIdentity['kind']>([
  'entity-frame',
  'hash-precommit',
  'leader-timeout-vote',
  'account-ack',
  'account-board-reseal',
  'j-prefix-attestation',
  'j-finality',
]);

const RELIABLE_EVIDENCE_KINDS = new Set<ReliableDeliveryIdentity['evidenceKind']>([
  'entity-proposal',
  'entity-certificate',
  'hash-precommit',
  'leader-timeout-vote',
  'account-ack',
  'account-frame-ack',
  'account-board-reseal',
  'j-prefix-attestation',
  'j-finality',
]);

const EVIDENCE_BY_KIND: Record<
  ReliableDeliveryIdentity['kind'],
  ReadonlySet<ReliableDeliveryIdentity['evidenceKind']>
> = {
  'entity-frame': new Set(['entity-proposal', 'entity-certificate']),
  'hash-precommit': new Set(['hash-precommit']),
  'leader-timeout-vote': new Set(['leader-timeout-vote']),
  'account-ack': new Set(['account-ack', 'account-frame-ack']),
  'account-board-reseal': new Set(['account-board-reseal']),
  'j-prefix-attestation': new Set(['j-prefix-attestation']),
  'j-finality': new Set(['j-finality']),
};

export const reliableIdentityExactKey = (identity: ReliableDeliveryIdentity): string =>
  safeStringify({
    kind: identity.kind,
    entityId: identity.entityId,
    signerId: identity.signerId,
    laneKey: identity.laneKey,
    height: identity.height,
    logIndex: identity.logIndex ?? null,
    frameHash: identity.frameHash,
    logicalKey: identity.logicalKey,
    evidenceVersion: identity.evidenceVersion,
    evidenceKind: identity.evidenceKind,
    evidenceDigest: identity.evidenceDigest,
    bodyDigest: identity.bodyDigest ?? null,
    evidenceBindings: identity.evidenceBindings ?? null,
  });

export const receiverFrontierKey = (
  sourceRuntimeIdRaw: string,
  identity: ReliableDeliveryIdentity,
): string => {
  const sourceRuntimeId = normalizeRuntimeId(sourceRuntimeIdRaw);
  if (!sourceRuntimeId) throw new Error('RELIABLE_INGRESS_SENDER_RUNTIME_INVALID');
  return safeStringify({ sourceRuntimeId, laneKey: identity.laneKey });
};

export const assertReliableIngressSourceLaneCapacity = (
  existingKeys: Iterable<string>,
  candidateKey: string,
): void => {
  const keys = new Set(existingKeys);
  if (keys.size > MAX_RELIABLE_INGRESS_SOURCE_LANES) {
    throw new Error(
      `RELIABLE_INGRESS_SOURCE_LANE_BOUND_CORRUPTION:` +
      `${keys.size}:${MAX_RELIABLE_INGRESS_SOURCE_LANES}`,
    );
  }
  if (keys.has(candidateKey)) return;
  if (keys.size >= MAX_RELIABLE_INGRESS_SOURCE_LANES) {
    throw new Error(
      `RELIABLE_INGRESS_SOURCE_LANE_CAPACITY_EXCEEDED:` +
      `${keys.size}:${MAX_RELIABLE_INGRESS_SOURCE_LANES}:${candidateKey}`,
    );
  }
};

export const assertReliableIngressSourceLaneBound = (
  existingKeys: Iterable<string>,
): void => {
  const count = new Set(existingKeys).size;
  if (count > MAX_RELIABLE_INGRESS_SOURCE_LANES) {
    throw new Error(
      `RELIABLE_INGRESS_SOURCE_LANE_BOUND_CORRUPTION:` +
      `${count}:${MAX_RELIABLE_INGRESS_SOURCE_LANES}`,
    );
  }
};

export const senderFrontierKeyForIdentity = (
  receiverRuntimeIdRaw: string,
  identity: ReliableDeliveryIdentity,
): string => {
  const receiverRuntimeId = normalizeRuntimeId(receiverRuntimeIdRaw);
  if (!receiverRuntimeId) throw new Error('RELIABLE_RECEIPT_RECEIVER_RUNTIME_INVALID');
  return safeStringify({ receiverRuntimeId, laneKey: identity.laneKey });
};

export const senderFrontierKey = (receipt: ReliableDeliveryReceipt): string =>
  senderFrontierKeyForIdentity(receipt.body.receiverRuntimeId, receipt.body.identity);

export const reliableReceiptExactKey = (receipt: ReliableDeliveryReceipt): string =>
  safeStringify({
    receiverRuntimeId: receipt.body.receiverRuntimeId,
    identity: reliableIdentityExactKey(receipt.body.identity),
    appliedRuntimeHeight: receipt.body.appliedRuntimeHeight,
    signature: receipt.signature,
  });

const validateBindings = (bindings: unknown): boolean => {
  if (!Array.isArray(bindings) || bindings.length === 0) return false;
  let previousSubject = '';
  return bindings.every((binding) => {
    if (!binding || typeof binding !== 'object') return false;
    const candidate = binding as Partial<ReliableDeliveryEvidenceBinding>;
    const valid =
      typeof candidate.subject === 'string' &&
      candidate.subject.length > 0 &&
      candidate.subject === candidate.subject.toLowerCase() &&
      candidate.subject > previousSubject &&
      typeof candidate.digest === 'string' &&
      CANONICAL_DIGEST_PATTERN.test(candidate.digest);
    if (valid) previousSubject = candidate.subject!;
    return valid;
  });
};

export const getReliableIdentityValidationError = (identity: unknown): string | null => {
  if (!identity || typeof identity !== 'object') return 'RELIABLE_RECEIPT_IDENTITY_INVALID';
  const value = identity as Partial<ReliableDeliveryIdentity>;
  if (!RELIABLE_KINDS.has(value.kind as ReliableDeliveryIdentity['kind'])) {
    return 'RELIABLE_RECEIPT_KIND_INVALID';
  }
  if (typeof value.entityId !== 'string' || value.entityId.trim().length === 0) {
    return 'RELIABLE_RECEIPT_ENTITY_INVALID';
  }
  if (typeof value.signerId !== 'string' || value.signerId.trim().length === 0) {
    return 'RELIABLE_RECEIPT_SIGNER_INVALID';
  }
  if (typeof value.laneKey !== 'string' || value.laneKey.length === 0) {
    return 'RELIABLE_RECEIPT_LANE_INVALID';
  }
  if (!Number.isSafeInteger(value.height) || Number(value.height) < 0) {
    return 'RELIABLE_RECEIPT_HEIGHT_INVALID';
  }
  if (value.kind === 'account-board-reseal') {
    if (!Number.isSafeInteger(value.logIndex) || Number(value.logIndex) < 0) {
      return 'RELIABLE_RECEIPT_LOG_INDEX_INVALID';
    }
  } else if (value.logIndex !== undefined) {
    return 'RELIABLE_RECEIPT_LOG_INDEX_UNEXPECTED';
  }
  if (typeof value.frameHash !== 'string' || value.frameHash.trim().length === 0) {
    return 'RELIABLE_RECEIPT_FRAME_HASH_INVALID';
  }
  if (typeof value.logicalKey !== 'string' || value.logicalKey.length === 0) {
    return 'RELIABLE_RECEIPT_LOGICAL_KEY_INVALID';
  }
  if (value.evidenceVersion !== 1) return 'RELIABLE_RECEIPT_EVIDENCE_VERSION_INVALID';
  if (!RELIABLE_EVIDENCE_KINDS.has(value.evidenceKind as ReliableDeliveryIdentity['evidenceKind'])) {
    return 'RELIABLE_RECEIPT_EVIDENCE_KIND_INVALID';
  }
  if (!EVIDENCE_BY_KIND[value.kind!].has(value.evidenceKind!)) {
    return 'RELIABLE_RECEIPT_EVIDENCE_KIND_MISMATCH';
  }
  if (typeof value.evidenceDigest !== 'string' || !CANONICAL_DIGEST_PATTERN.test(value.evidenceDigest)) {
    return 'RELIABLE_RECEIPT_EVIDENCE_DIGEST_INVALID';
  }
  if (
    value.kind === 'entity-frame' ||
    value.kind === 'account-ack' ||
    value.kind === 'account-board-reseal' ||
    value.kind === 'leader-timeout-vote'
  ) {
    if (typeof value.bodyDigest !== 'string' || !CANONICAL_DIGEST_PATTERN.test(value.bodyDigest)) {
      return 'RELIABLE_RECEIPT_BODY_DIGEST_INVALID';
    }
  } else if (value.bodyDigest !== undefined) {
    return 'RELIABLE_RECEIPT_BODY_DIGEST_UNEXPECTED';
  }
  if (value.kind === 'hash-precommit' || value.kind === 'leader-timeout-vote') {
    if (!validateBindings(value.evidenceBindings)) return 'RELIABLE_RECEIPT_EVIDENCE_BINDINGS_INVALID';
  } else if (value.evidenceBindings !== undefined) {
    return 'RELIABLE_RECEIPT_EVIDENCE_BINDINGS_UNEXPECTED';
  }
  return null;
};

const evidenceRank = (identity: ReliableDeliveryIdentity): number => {
  if (identity.evidenceKind === 'entity-certificate') return 1;
  if (identity.evidenceKind === 'account-frame-ack') return 1;
  return 0;
};

const bindingMap = (identity: ReliableDeliveryIdentity): Map<string, string> =>
  new Map((identity.evidenceBindings ?? []).map(binding => [binding.subject, binding.digest]));

const reliableLogIndex = (identity: ReliableDeliveryIdentity): number => {
  if (identity.kind !== 'account-board-reseal') return 0;
  if (!Number.isSafeInteger(identity.logIndex) || Number(identity.logIndex) < 0) {
    throw new Error(`RELIABLE_IDENTITY_LOG_INDEX_INVALID:${String(identity.logIndex)}`);
  }
  return Number(identity.logIndex);
};

/** Compare the exact protocol order without packing blockNumber/logIndex into a JS number. */
export const compareReliableIdentityPosition = (
  left: ReliableDeliveryIdentity,
  right: ReliableDeliveryIdentity,
): number => left.height - right.height || reliableLogIndex(left) - reliableLogIndex(right);

export const sameReliableIdentityPosition = (
  left: ReliableDeliveryIdentity,
  right: ReliableDeliveryIdentity,
): boolean => compareReliableIdentityPosition(left, right) === 0;

export const assertReliableLaneCompatible = (
  existing: ReliableDeliveryIdentity,
  incoming: ReliableDeliveryIdentity,
  code: string,
): void => {
  if (existing.laneKey !== incoming.laneKey || !sameReliableIdentityPosition(existing, incoming)) return;
  if (existing.logicalKey !== incoming.logicalKey || existing.frameHash !== incoming.frameHash) {
    throw new Error(`${code}:${incoming.kind}:${incoming.height}`);
  }
  if (existing.kind === 'entity-frame' && existing.bodyDigest !== incoming.bodyDigest) {
    throw new Error(`${code.replace('LANE_ORDER', 'ENTITY_FRAME_BODY')}:${incoming.height}`);
  }
  if (existing.kind === 'account-ack') {
    if (existing.bodyDigest !== incoming.bodyDigest) {
      throw new Error(`${code.replace('LANE_ORDER', 'ACCOUNT_ACK_BODY')}:${incoming.height}`);
    }
    if (
      existing.evidenceKind === incoming.evidenceKind &&
      existing.evidenceDigest !== incoming.evidenceDigest
    ) {
      throw new Error(`${code.replace('LANE_ORDER', 'EVIDENCE')}:${incoming.height}`);
    }
  }
  if (existing.kind === 'account-board-reseal') {
    if (existing.bodyDigest !== incoming.bodyDigest) {
      throw new Error(`${code.replace('LANE_ORDER', 'ACCOUNT_BOARD_RESEAL_BODY')}:${incoming.height}`);
    }
    if (existing.evidenceDigest !== incoming.evidenceDigest) {
      throw new Error(`${code.replace('LANE_ORDER', 'EVIDENCE')}:${incoming.height}`);
    }
  }
  if (
    existing.kind === 'j-prefix-attestation' &&
    existing.evidenceDigest !== incoming.evidenceDigest
  ) {
    throw new Error(`${code.replace('LANE_ORDER', 'EVIDENCE')}:${incoming.height}`);
  }
  if (existing.kind === 'leader-timeout-vote') {
    if (existing.bodyDigest !== incoming.bodyDigest) {
      throw new Error(`${code.replace('LANE_ORDER', 'LEADER_VOTE_BODY')}:${incoming.height}`);
    }
    const existingBindings = bindingMap(existing);
    for (const binding of incoming.evidenceBindings ?? []) {
      const prior = existingBindings.get(binding.subject);
      if (prior && prior !== binding.digest) {
        throw new Error(`${code.replace('LANE_ORDER', 'EVIDENCE')}:${incoming.height}:${binding.subject}`);
      }
    }
    return;
  }
  if (existing.kind !== 'hash-precommit') return;
  const existingBindings = bindingMap(existing);
  for (const binding of incoming.evidenceBindings ?? []) {
    const prior = existingBindings.get(binding.subject);
    if (prior && prior !== binding.digest) {
      throw new Error(`${code.replace('LANE_ORDER', 'EVIDENCE')}:${incoming.height}:${binding.subject}`);
    }
  }
};

export const reliableFrontierCovers = (
  frontier: ReliableDeliveryIdentity,
  candidate: ReliableDeliveryIdentity,
): boolean => {
  if (frontier.laneKey !== candidate.laneKey || frontier.kind !== candidate.kind) return false;
  if (!sameReliableIdentityPosition(candidate, frontier)) return false;
  assertReliableLaneCompatible(frontier, candidate, 'RELIABLE_FRONTIER_LANE_ORDER_CONFLICT');
  if (frontier.kind === 'hash-precommit') {
    const frontierBindings = bindingMap(frontier);
    return (candidate.evidenceBindings ?? []).every(
      binding => frontierBindings.get(binding.subject) === binding.digest,
    );
  }
  if (
    frontier.kind === 'j-finality' ||
    frontier.kind === 'j-prefix-attestation' ||
    frontier.kind === 'leader-timeout-vote'
  ) {
    return reliableIdentityExactKey(frontier) === reliableIdentityExactKey(candidate);
  }
  return evidenceRank(frontier) >= evidenceRank(candidate);
};

export const reliableReceiptCoversIdentity = (
  receipt: ReliableDeliveryReceipt,
  candidate: ReliableDeliveryIdentity,
): boolean => {
  const frontier = receipt.body.identity;
  if (frontier.laneKey !== candidate.laneKey || frontier.kind !== candidate.kind) return false;
  if (compareReliableIdentityPosition(candidate, frontier) < 0) {
    // A signed H2 identity contains no authenticated H1 frameHash or ancestry
    // proof. Treating a terminal height as cumulative would let an H2 receipt
    // collect a conflicting H1 outbox entry. Every lower identity therefore
    // needs its own exact receiver-signed receipt, including Entity and Account.
    return false;
  }
  return reliableFrontierCovers(frontier, candidate);
};

const digestBindings = (bindings: readonly ReliableDeliveryEvidenceBinding[]): string =>
  keccak256(toUtf8Bytes(encodeCanonicalEntityConsensusValue(bindings))).toLowerCase();

const mergePrecommitFrontier = (
  existing: ReliableDeliveryIdentity,
  incoming: ReliableDeliveryIdentity,
): ReliableDeliveryIdentity => {
  const merged = bindingMap(existing);
  for (const binding of incoming.evidenceBindings ?? []) merged.set(binding.subject, binding.digest);
  const evidenceBindings = [...merged.entries()]
    .map(([subject, digest]) => ({ subject, digest }))
    .sort((left, right) => compareStableText(left.subject, right.subject));
  return {
    ...incoming,
    evidenceBindings,
    evidenceDigest: digestBindings(evidenceBindings),
  };
};

export type ReliableFrontierAdvance = {
  identity: ReliableDeliveryIdentity;
  changed: boolean;
  covered: boolean;
};

export const advanceReliableFrontier = (
  existing: ReliableDeliveryIdentity | undefined,
  incoming: ReliableDeliveryIdentity,
): ReliableFrontierAdvance => {
  if (!existing) return { identity: incoming, changed: true, covered: false };
  if (existing.laneKey !== incoming.laneKey || existing.kind !== incoming.kind) {
    throw new Error('RELIABLE_FRONTIER_LANE_MISMATCH');
  }
  const position = compareReliableIdentityPosition(incoming, existing);
  if (position < 0) {
    return { identity: existing, changed: false, covered: false };
  }
  if (position > 0) {
    return { identity: incoming, changed: true, covered: false };
  }
  assertReliableLaneCompatible(existing, incoming, 'RELIABLE_FRONTIER_LANE_ORDER_CONFLICT');
  if (existing.kind === 'hash-precommit') {
    const merged = mergePrecommitFrontier(existing, incoming);
    const changed = reliableIdentityExactKey(merged) !== reliableIdentityExactKey(existing);
    return { identity: changed ? merged : existing, changed, covered: !changed };
  }
  if (reliableFrontierCovers(existing, incoming)) {
    return { identity: existing, changed: false, covered: true };
  }
  if (reliableFrontierCovers(incoming, existing)) {
    return { identity: incoming, changed: true, covered: false };
  }
  throw new Error(`RELIABLE_FRONTIER_INCOMPARABLE:${incoming.kind}:${incoming.height}`);
};
