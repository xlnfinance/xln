import type {
  EntityLeaderCertificate,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityTx,
  Env,
  JurisdictionEventData,
  ReliableDeliveryIdentity,
  RoutedEntityInput,
} from '../types';
import { getEntityLeaderState } from '../entity/consensus/leader';
import { reconcileJEventRangeWithFinalizedState } from '../jurisdiction/local-history';
import {
  getJPrefixAttestationTemporalDisposition,
  verifyOutOfRoundJPrefixAttestation,
} from '../jurisdiction/j-prefix-consensus';
import {
  assertReliableLaneCompatible,
  reliableIdentityExactKey,
} from './reliable-frontier';
import { getReliableOutputIdentity } from './output-routing';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const findTargetReplica = (
  env: Env,
  identity: ReliableDeliveryIdentity,
): EntityReplica | undefined => [...env.eReplicas.values()].find(replica =>
  normalize(replica.entityId || replica.state.entityId) === identity.entityId &&
  normalize(replica.signerId) === identity.signerId);

const txIdentity = (
  replica: EntityReplica,
  tx: EntityTx,
): ReliableDeliveryIdentity | null => {
  const identity = getReliableOutputIdentity({
    entityId: replica.entityId,
    signerId: replica.signerId,
    entityTxs: [tx],
  });
  if (!identity) return null;
  const { order: _order, variantOrder: _variantOrder, ...durableIdentity } = identity;
  return durableIdentity;
};

const replicaReliableTxs = (replica: EntityReplica): EntityTx[] => [
  ...replica.mempool,
  ...(replica.proposal?.txs ?? []),
  ...(replica.lockedFrame?.txs ?? []),
];

const replicaContainsIdentity = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => replicaReliableTxs(replica).some((tx) => {
  const candidate = txIdentity(replica, tx);
  return candidate && reliableIdentityExactKey(candidate) === reliableIdentityExactKey(identity);
});

const durableLeaderVoteIdentity = (
  replica: EntityReplica,
  vote: EntityLeaderTimeoutVote,
): ReliableDeliveryIdentity => {
  const candidate = getReliableOutputIdentity({
    entityId: replica.entityId,
    signerId: replica.signerId,
    leaderTimeoutVote: vote,
  });
  if (!candidate || candidate.kind !== 'leader-timeout-vote') {
    throw new Error('RELIABLE_AUTHORITY_LEADER_VOTE_IDENTITY_MISSING');
  }
  const { order: _order, variantOrder: _variantOrder, ...identity } = candidate;
  return identity;
};

const certificateVotes = (
  certificate: EntityLeaderCertificate | undefined,
): EntityLeaderTimeoutVote[] => {
  if (!certificate) return [];
  const compactVoters = new Set([...certificate.votes.keys()].map(normalize));
  const preparedByVoter = new Map(
    [...(certificate.preparedVotes ?? new Map()).entries()]
      .map(([voterId, vote]) => [normalize(voterId), vote] as const),
  );
  for (const voterId of preparedByVoter.keys()) {
    if (!compactVoters.has(voterId)) {
      throw new Error(`RELIABLE_AUTHORITY_LEADER_CERTIFICATE_EXTRA_PREPARED_VOTE:${voterId}`);
    }
  }
  return [...certificate.votes.entries()].map(([rawVoterId, signature]) => {
    const voterId = normalize(rawVoterId);
    const prepared = preparedByVoter.get(voterId);
    if (prepared) {
      const bodyMatches =
        normalize(prepared.entityId) === normalize(certificate.entityId) &&
        prepared.targetHeight === certificate.targetHeight &&
        normalize(prepared.previousFrameHash) === normalize(certificate.previousFrameHash) &&
        prepared.fromView === certificate.fromView &&
        prepared.toView === certificate.toView &&
        normalize(prepared.previousLeaderId) === normalize(certificate.previousLeaderId) &&
        normalize(prepared.nextLeaderId) === normalize(certificate.nextLeaderId) &&
        normalize(prepared.voterId) === voterId &&
        normalize(prepared.signature) === normalize(signature);
      if (!bodyMatches) {
        throw new Error(`RELIABLE_AUTHORITY_LEADER_CERTIFICATE_PREPARED_VOTE_MISMATCH:${voterId}`);
      }
      return prepared;
    }
    return {
      entityId: certificate.entityId,
      targetHeight: certificate.targetHeight,
      previousFrameHash: certificate.previousFrameHash,
      fromView: certificate.fromView,
      toView: certificate.toView,
      previousLeaderId: certificate.previousLeaderId,
      nextLeaderId: certificate.nextLeaderId,
      voterId,
      signature,
    };
  });
};

const replicaLeaderVotes = (replica: EntityReplica): EntityLeaderTimeoutVote[] => {
  const certificates = [
    replica.pendingLeaderCertificate,
    replica.proposal?.leader.certificate,
    replica.proposal?.leader.relayCertificate,
    replica.lockedFrame?.leader.certificate,
    replica.lockedFrame?.leader.relayCertificate,
    ...(replica.certifiedFrameLineage ?? []).flatMap(link => [
      link.frame.leader.certificate,
      link.frame.leader.relayCertificate,
    ]),
  ];
  return [
    ...(replica.leaderVotes?.values() ?? []),
    ...certificates.flatMap(certificateVotes),
  ];
};

const assertLeaderVoteAuthority = (
  replica: EntityReplica,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): void => {
  const vote = input.leaderTimeoutVote;
  if (!vote) throw new Error('RELIABLE_AUTHORITY_LEADER_VOTE_INPUT_MISSING');
  const inputIdentity = durableLeaderVoteIdentity(replica, vote);
  if (reliableIdentityExactKey(inputIdentity) !== reliableIdentityExactKey(identity)) {
    throw new Error('RELIABLE_AUTHORITY_LEADER_VOTE_INPUT_IDENTITY_MISMATCH');
  }
  const exactKey = reliableIdentityExactKey(identity);
  if (replicaLeaderVotes(replica).some(candidate =>
    reliableIdentityExactKey(durableLeaderVoteIdentity(replica, candidate)) === exactKey)) return;
  throw new Error(`RELIABLE_AUTHORITY_LEADER_VOTE_MISSING:${identity.height}:${identity.frameHash}`);
};

const assertEntityFrameAuthority = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): void => {
  const committed =
    replica.state.height === identity.height &&
    normalize(replica.state.prevFrameHash) === identity.frameHash;
  const active = [replica.lockedFrame, replica.proposal].some(frame =>
    frame?.height === identity.height && normalize(frame.hash) === identity.frameHash);
  if (!committed && !active) {
    throw new Error(`RELIABLE_AUTHORITY_ENTITY_FRAME_MISSING:${identity.height}:${identity.frameHash}`);
  }
  if (identity.evidenceKind === 'entity-certificate' && !committed) {
    throw new Error(`RELIABLE_AUTHORITY_ENTITY_CERTIFICATE_NOT_COMMITTED:${identity.height}`);
  }
};

const assertPrecommitAuthority = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): void => {
  const active = [replica.proposal, replica.lockedFrame].find(frame =>
    frame?.height === identity.height && normalize(frame.hash) === identity.frameHash);
  const committed =
    replica.state.height === identity.height &&
    normalize(replica.state.prevFrameHash) === identity.frameHash;
  if (!active && !committed) {
    throw new Error(`RELIABLE_AUTHORITY_PRECOMMIT_FRAME_MISSING:${identity.height}:${identity.frameHash}`);
  }
  if (!active) return;
  for (const binding of identity.evidenceBindings ?? []) {
    if (!active.collectedSigs?.has(binding.subject)) {
      throw new Error(`RELIABLE_AUTHORITY_PRECOMMIT_SIGNER_MISSING:${binding.subject}`);
    }
  }
};

const jPrefixStateCovers = (
  replica: EntityReplica,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const bundle = input.jPrefixAttestations;
  if (!(bundle instanceof Map) || bundle.size !== 1) return false;
  const entry = bundle.entries().next().value;
  if (!entry) return false;
  const [sourceValidatorId] = entry;
  const persisted = replica.jPrefixRound?.attestations.get(normalize(sourceValidatorId));
  if (persisted) {
    const candidate = getReliableOutputIdentity({
      entityId: replica.entityId,
      signerId: replica.signerId,
      jPrefixAttestations: new Map([[sourceValidatorId, persisted]]),
    });
    if (candidate) {
      const { order: _order, variantOrder: _variantOrder, ...durableIdentity } = candidate;
      if (reliableIdentityExactKey(durableIdentity) === reliableIdentityExactKey(identity)) return true;
    }
  }
  return jPrefixLineageCoversIdentity(replica, identity);
};

const jPrefixLineageCoversIdentity = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => (replica.certifiedFrameLineage ?? []).some((link) => {
  if (link.frame.height !== identity.height) return false;
  const attestations = link.frame.jPrefixCertificate?.attestations;
  if (!(attestations instanceof Map)) return false;
  return Array.from(attestations.entries()).some(([sourceValidatorId, attestation]) => {
    const candidate = getReliableOutputIdentity({
      entityId: replica.entityId,
      signerId: replica.signerId,
      jPrefixAttestations: new Map([[sourceValidatorId, attestation]]),
    });
    if (!candidate) return false;
    const { order: _order, variantOrder: _variantOrder, ...durableIdentity } = candidate;
    return reliableIdentityExactKey(durableIdentity) === reliableIdentityExactKey(identity);
  });
});

/**
 * Only an input that passed full stale-vote authentication in this applied
 * Runtime frame may bypass retained lineage. Pending transport identities do
 * not carry their signed body and must never become terminal by height alone.
 */
export const isAuthenticatedAppliedStaleJPrefixInput = (
  env: Env,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): boolean => {
  if (identity.kind !== 'j-prefix-attestation') return false;
  const replica = findTargetReplica(env, identity);
  if (!replica) throw new Error(`RELIABLE_AUTHORITY_REPLICA_MISSING:${identity.entityId}:${identity.signerId}`);
  const bundle = input.jPrefixAttestations;
  if (!(bundle instanceof Map) || bundle.size !== 1) {
    throw new Error('RELIABLE_AUTHORITY_J_PREFIX_INPUT_INVALID');
  }
  const entry = bundle.entries().next().value;
  if (!entry) throw new Error('RELIABLE_AUTHORITY_J_PREFIX_INPUT_MISSING');
  const [rawSignerId, rawAttestation] = entry;
  if (getJPrefixAttestationTemporalDisposition(replica.state, rawAttestation) !== 'stale') return false;
  const authorityConfigs = [
    replica.state.config,
    ...(replica.certifiedFrameAnchor ? [replica.certifiedFrameAnchor.authority.config] : []),
    ...(replica.certifiedFrameLineage ?? []).map(link => link.postAuthority.config),
  ];
  const attestation = verifyOutOfRoundJPrefixAttestation(
    env,
    replica.state,
    rawAttestation,
    authorityConfigs,
  );
  if (normalize(rawSignerId) !== attestation.validatorId) {
    throw new Error(`RELIABLE_AUTHORITY_J_PREFIX_SIGNER_MISMATCH:${rawSignerId}`);
  }
  const candidate = getReliableOutputIdentity({
    entityId: replica.entityId,
    signerId: replica.signerId,
    jPrefixAttestations: new Map([[rawSignerId, attestation]]),
  });
  if (!candidate) throw new Error('RELIABLE_AUTHORITY_J_PREFIX_IDENTITY_MISSING');
  const { order: _order, variantOrder: _variantOrder, ...durableIdentity } = candidate;
  if (reliableIdentityExactKey(durableIdentity) !== reliableIdentityExactKey(identity)) {
    throw new Error('RELIABLE_AUTHORITY_J_PREFIX_IDENTITY_MISMATCH');
  }
  return true;
};

const accountStateCovers = (
  replica: EntityReplica,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const tx = getEffectiveEntityInputTxs(input).find(candidate => candidate.type === 'accountInput');
  if (!tx || tx.type !== 'accountInput') return false;
  const account = [...replica.state.accounts.values()].find(candidate =>
    [candidate.leftEntity, candidate.rightEntity].map(normalize).includes(normalize(tx.data.fromEntityId)) &&
    [candidate.leftEntity, candidate.rightEntity].map(normalize).includes(normalize(tx.data.toEntityId)) &&
    normalize(candidate.watchSeed) === normalize(tx.data.watchSeed));
  if (!account || account.currentHeight < identity.height) return false;
  if (account.currentHeight > identity.height) return true;
  return normalize(account.currentFrame?.stateHash) === identity.frameHash;
};

/**
 * A peer ACK can be durably queued while an unrelated Entity transition wins
 * the current round. The local Account proposal is still only pending in that
 * state: issuing even an exact reliable receipt would let the peer discard the
 * ACK before bilateral H -> H+1 commit. Keep the transport identity pending;
 * commitTerminalPendingIngress will receipt it once currentFrame is exact H.
 *
 * Matching both height and hash is intentional. A different ACK at the same
 * height remains a loud authority conflict instead of being misclassified as
 * normal scheduler deferral.
 */
export const isReliableAccountAckAwaitingCommit = (
  env: Env,
  identity: ReliableDeliveryIdentity,
): boolean => {
  if (identity.kind !== 'account-ack') return false;
  const replica = findTargetReplica(env, identity);
  if (!replica) throw new Error(`RELIABLE_AUTHORITY_REPLICA_MISSING:${identity.entityId}:${identity.signerId}`);
  const account = accountForLane(replica, identity);
  if (!account || account.currentHeight >= identity.height) return false;
  return account.pendingFrame?.height === identity.height &&
    normalize(account.pendingFrame.stateHash) === identity.frameHash;
};

const compareAccountBoardResealPosition = (
  marker: { activationJHeight: number; activationLogIndex: number },
  identity: ReliableDeliveryIdentity,
): number => {
  if (
    identity.kind !== 'account-board-reseal' ||
    !Number.isSafeInteger(identity.logIndex) ||
    Number(identity.logIndex) < 0
  ) {
    throw new Error(`RELIABLE_AUTHORITY_ACCOUNT_BOARD_RESEAL_POSITION_INVALID:${String(identity.logIndex)}`);
  }
  if (
    !Number.isSafeInteger(marker.activationJHeight) ||
    marker.activationJHeight < 1 ||
    !Number.isSafeInteger(marker.activationLogIndex) ||
    marker.activationLogIndex < 0
  ) {
    throw new Error('RELIABLE_AUTHORITY_ACCOUNT_BOARD_RESEAL_MARKER_CORRUPT');
  }
  return marker.activationJHeight - identity.height ||
    marker.activationLogIndex - Number(identity.logIndex);
};

const accountBoardResealStateCovers = (
  replica: EntityReplica,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const tx = getEffectiveEntityInputTxs(input).find(candidate =>
    candidate.type === 'accountInput' && candidate.data.kind === 'board_reseal');
  if (!tx || tx.type !== 'accountInput' || tx.data.kind !== 'board_reseal') return false;
  const account = accountForLane(replica, identity);
  const marker = account?.counterpartyBoardReseal;
  if (!marker) return false;
  const position = compareAccountBoardResealPosition(marker, identity);
  if (position > 0) return true;
  return position === 0 &&
    marker.activationLogIndex === tx.data.reseal.boardActivationLogIndex &&
    marker.frameHeight === tx.data.reseal.height &&
    marker.frameHash === identity.frameHash &&
    normalize(tx.data.reseal.frameHash) === identity.frameHash;
};

const jStateCovers = (
  replica: EntityReplica,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const tx = getEffectiveEntityInputTxs(input).find(candidate => candidate.type === 'j_event');
  if (!tx || tx.type !== 'j_event') return false;
  const finality = replica.state.jHistoryFinality;
  if (replica.state.lastFinalizedJHeight > identity.height) return true;
  return Boolean(
    finality &&
    finality.finalizedThroughHeight === identity.height &&
    normalize(finality.jurisdictionRef) === normalize(tx.data.jurisdictionRef) &&
    normalize(finality.tipBlockHash) === normalize(tx.data.tipBlockHash) &&
    normalize(finality.eventHistoryRoot) === normalize(tx.data.eventHistoryRoot),
  );
};

const parseIdentityJson = (value: string, code: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
};

const terminalEntityFrame = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => replica.state.height > identity.height || (
  replica.state.height === identity.height &&
  normalize(replica.state.prevFrameHash) === identity.frameHash
);

const terminalLeaderVote = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const logical = parseIdentityJson(
    identity.logicalKey,
    'RELIABLE_AUTHORITY_LEADER_VOTE_LOGICAL_KEY_INVALID',
  );
  if (
    logical['kind'] !== 'leader-timeout-vote' ||
    normalize(logical['entityId']) !== identity.entityId ||
    Number(logical['targetHeight']) !== identity.height ||
    normalize(logical['voteHash']) !== identity.frameHash
  ) {
    throw new Error('RELIABLE_AUTHORITY_LEADER_VOTE_IDENTITY_MISMATCH');
  }
  const fromView = Number(logical['fromView']);
  const toView = Number(logical['toView']);
  if (!Number.isSafeInteger(fromView) || !Number.isSafeInteger(toView) || toView - fromView !== 1) {
    throw new Error('RELIABLE_AUTHORITY_LEADER_VOTE_VIEW_INVALID');
  }
  // Once the target Entity height itself is committed, no timeout vote for
  // that height can change consensus state, regardless of which view won.
  if (replica.state.height >= identity.height) return true;
  if (getEntityLeaderState(replica.state).view >= toView) return true;
  const certifiedViews = [
    replica.pendingLeaderCertificate,
    replica.proposal?.leader.certificate,
    replica.proposal?.leader.relayCertificate,
    replica.lockedFrame?.leader.certificate,
    replica.lockedFrame?.leader.relayCertificate,
  ];
  return certifiedViews.some(certificate =>
    certificate?.targetHeight === identity.height && certificate.toView >= toView);
};

const accountForLane = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
) => {
  const lane = parseIdentityJson(identity.laneKey, 'RELIABLE_AUTHORITY_ACCOUNT_LANE_INVALID');
  const scope = lane['scope'];
  if (!Array.isArray(scope) || scope.length !== 2 || scope.some(value => typeof value !== 'string')) {
    throw new Error('RELIABLE_AUTHORITY_ACCOUNT_SCOPE_INVALID');
  }
  const ids = scope.map(normalize).sort();
  return [...replica.state.accounts.values()].find(account =>
    [normalize(account.leftEntity), normalize(account.rightEntity)].sort().join(':') === ids.join(':'));
};

/**
 * A plain ACK tombstone does not normally cover richer frame_ack evidence.
 * The only bounded exception is an exact successor frame already committed in
 * local durable Account state. In that case reapplying the embedded proposal
 * cannot add information, while a receiver-signed receipt over the incoming
 * richer identity lets the sender collect the exact outbox item.
 *
 * Never infer ancestry from a greater height: without retained Account
 * lineage, H+2 says nothing about the exact proposal hash at H+1.
 */
export const canReissueTerminalAccountFrameAck = (
  env: Env,
  terminal: ReliableDeliveryIdentity,
  candidate: ReliableDeliveryIdentity,
  input: RoutedEntityInput,
): boolean => {
  if (
    terminal.kind !== 'account-ack' ||
    terminal.evidenceKind !== 'account-ack' ||
    candidate.kind !== 'account-ack' ||
    candidate.evidenceKind !== 'account-frame-ack' ||
    candidate.height !== terminal.height ||
    candidate.laneKey !== terminal.laneKey
  ) return false;
  assertReliableLaneCompatible(
    terminal,
    candidate,
    'RELIABLE_INGRESS_TERMINAL_ACCOUNT_ACK_CONFLICT',
  );
  const replica = findTargetReplica(env, candidate);
  if (!replica) {
    throw new Error(`RELIABLE_AUTHORITY_REPLICA_MISSING:${candidate.entityId}:${candidate.signerId}`);
  }
  const account = accountForLane(replica, candidate);
  if (!account) throw new Error('RELIABLE_INGRESS_TERMINAL_ACCOUNT_MISSING');
  if (account.currentHeight !== candidate.height + 1) return false;
  const tx = getEffectiveEntityInputTxs(input).find(entry => entry.type === 'accountInput');
  if (!tx || tx.type !== 'accountInput' || tx.data.kind !== 'frame_ack') {
    throw new Error('RELIABLE_INGRESS_TERMINAL_ACCOUNT_FRAME_INPUT_MISSING');
  }
  const proposal = tx.data.proposal.frame;
  const matchesCommittedSuccessor =
    proposal.height === candidate.height + 1 &&
    normalize(proposal.prevFrameHash) === normalize(candidate.frameHash) &&
    account.currentFrame.height === proposal.height &&
    normalize(account.currentFrame.prevFrameHash) === normalize(proposal.prevFrameHash) &&
    normalize(account.currentFrame.stateHash) === normalize(proposal.stateHash);
  if (!matchesCommittedSuccessor) {
    throw new Error('RELIABLE_INGRESS_TERMINAL_ACCOUNT_FRAME_CONFLICT');
  }
  return true;
};

const terminalAccountAck = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const account = accountForLane(replica, identity);
  if (!account) return false;
  const terminalHeight = identity.evidenceKind === 'account-frame-ack'
    ? identity.height + 1
    : identity.height;
  if (account.currentHeight > terminalHeight) return true;
  if (account.currentHeight < terminalHeight) return false;
  return identity.evidenceKind === 'account-frame-ack' ||
    normalize(account.currentFrame.stateHash) === identity.frameHash;
};

const terminalAccountBoardReseal = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const marker = accountForLane(replica, identity)?.counterpartyBoardReseal;
  if (!marker) return false;
  const position = compareAccountBoardResealPosition(marker, identity);
  if (position > 0) return true;
  return position === 0 && marker.frameHash === identity.frameHash;
};

const terminalJFinality = (
  replica: EntityReplica,
  identity: ReliableDeliveryIdentity,
): boolean => {
  if (replica.state.lastFinalizedJHeight < identity.height) return false;
  const logical = parseIdentityJson(identity.logicalKey, 'RELIABLE_AUTHORITY_J_LOGICAL_KEY_INVALID');
  const range = logical['unsignedRange'];
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new Error('RELIABLE_AUTHORITY_J_RANGE_INVALID');
  }
  const unsignedRange = range as Record<string, unknown>;
  if (Number(unsignedRange['scannedThroughHeight']) !== identity.height) {
    throw new Error('RELIABLE_AUTHORITY_J_IDENTITY_HEIGHT_MISMATCH');
  }
  // Height alone is never ancestry proof for J ranges. An active H50 range may
  // conflict with an independently certified H100 prefix; promoting it merely
  // because 100 > 50 would turn corrupt evidence into a permanent terminal ACK.
  const data = {
    ...unsignedRange,
    signature: '',
    observedAt: 0,
  } as unknown as JurisdictionEventData;
  return reconcileJEventRangeWithFinalizedState(replica.state, data).kind === 'noop';
};

export const assertReliableIdentityDurableInPostState = (
  env: Env,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): void => {
  const replica = findTargetReplica(env, identity);
  if (!replica) throw new Error(`RELIABLE_AUTHORITY_REPLICA_MISSING:${identity.entityId}:${identity.signerId}`);
  if (identity.kind === 'entity-frame') return assertEntityFrameAuthority(replica, identity);
  if (identity.kind === 'hash-precommit') return assertPrecommitAuthority(replica, identity);
  if (identity.kind === 'leader-timeout-vote') return assertLeaderVoteAuthority(replica, input, identity);
  if (identity.kind === 'j-prefix-attestation' && jPrefixStateCovers(replica, input, identity)) return;
  if (replicaContainsIdentity(replica, identity)) return;
  if (identity.kind === 'account-ack' && accountStateCovers(replica, input, identity)) return;
  if (
    identity.kind === 'account-board-reseal' &&
    accountBoardResealStateCovers(replica, input, identity)
  ) return;
  if (identity.kind === 'j-finality' && jStateCovers(replica, input, identity)) return;
  throw new Error(`RELIABLE_AUTHORITY_POST_STATE_MISSING:${identity.kind}:${identity.height}`);
};

/** Classify identities whose retained receipt may advance the compact terminal frontier. */
export const isReliableIdentityTerminalInPostState = (
  env: Env,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const replica = findTargetReplica(env, identity);
  if (!replica) throw new Error(`RELIABLE_AUTHORITY_REPLICA_MISSING:${identity.entityId}:${identity.signerId}`);
  if (identity.kind === 'entity-frame' || identity.kind === 'hash-precommit') {
    return terminalEntityFrame(replica, identity);
  }
  if (identity.kind === 'account-ack') return terminalAccountAck(replica, identity);
  if (identity.kind === 'account-board-reseal') return terminalAccountBoardReseal(replica, identity);
  if (identity.kind === 'leader-timeout-vote') return terminalLeaderVote(replica, identity);
  if (identity.kind === 'j-prefix-attestation') return jPrefixLineageCoversIdentity(replica, identity);
  return terminalJFinality(replica, identity);
};

/**
 * A terminal J watermark can issue a new exact receipt only for a locally
 * verified certified prefix. No terminal receipt itself covers a lower hash.
 */
export const assertTerminalReceiptCoversInput = (
  env: Env,
  terminal: ReliableDeliveryIdentity,
  candidate: ReliableDeliveryIdentity,
  input: RoutedEntityInput,
): void => {
  if (candidate.height >= terminal.height || candidate.kind !== 'j-finality') return;
  const replica = findTargetReplica(env, terminal);
  if (!replica) throw new Error('RELIABLE_TERMINAL_J_REPLICA_MISSING');
  const tx = getEffectiveEntityInputTxs(input).find(entry => entry.type === 'j_event');
  if (!tx || tx.type !== 'j_event') throw new Error('RELIABLE_TERMINAL_J_INPUT_MISSING');
  const reconciliation = reconcileJEventRangeWithFinalizedState(replica.state, tx.data);
  if (reconciliation.kind !== 'noop') {
    throw new Error(`RELIABLE_TERMINAL_J_PREFIX_NOT_FINALIZED:${candidate.height}`);
  }
};
