import { ethers } from 'ethers';

import type {
  ConsensusConfig,
  EntityLeaderState,
  EntityLeaderCertificate,
  EntityLeaderTimeoutVote,
  EntityLeaderTimeoutVoteBody,
  EntityReplica,
  EntityState,
} from '../../types';
import { compareStableText, serializeTaggedJson } from '../../protocol/serialization';

export const ENTITY_LEADER_TIMEOUT_BASE_MS = 10_000;
export const ENTITY_LEADER_TIMEOUT_MAX_MS = 60_000;
export const ENTITY_J_SUBMIT_FALLBACK_MS = 60_000;

const normalizeSignerId = (value: string): string => value.trim().toLowerCase();

const validatorShares = (config: ConsensusConfig, normalizedId: string): bigint => {
  const direct = config.shares[normalizedId];
  if (direct !== undefined) return direct;
  const original = config.validators.find(value => normalizeSignerId(value) === normalizedId);
  return original ? (config.shares[original] ?? 0n) : 0n;
};

export const getEntityLeaderOrder = (config: ConsensusConfig): string[] => {
  const validators = config.validators.map(normalizeSignerId);
  const ceo = validators[0];
  if (!ceo) return [];
  const fallback = validators.slice(1).sort((left, right) => {
    const leftShares = validatorShares(config, left);
    const rightShares = validatorShares(config, right);
    if (leftShares !== rightShares) return leftShares > rightShares ? -1 : 1;
    return validators.indexOf(left) - validators.indexOf(right) || compareStableText(left, right);
  });
  return [ceo, ...fallback];
};

export const getEntityLeaderState = (state: EntityState): EntityLeaderState => {
  const order = getEntityLeaderOrder(state.config);
  const ceo = order[0];
  if (!ceo) throw new Error(`ENTITY_LEADER_MISSING: entity=${state.entityId}`);
  const active = normalizeSignerId(state.leaderState?.activeValidatorId ?? ceo);
  if (!order.includes(active)) {
    throw new Error(`ENTITY_LEADER_NOT_VALIDATOR: entity=${state.entityId} leader=${active}`);
  }
  return {
    activeValidatorId: active,
    view: state.leaderState?.view ?? 0,
    changedAtHeight: state.leaderState?.changedAtHeight ?? 0,
  };
};

export const getNextEntityFallbackLeader = (state: EntityState): string => {
  const order = getEntityLeaderOrder(state.config);
  if (order.length < 2) return order[0] ?? '';
  const activeIndex = order.indexOf(getEntityLeaderState(state).activeValidatorId);
  if (activeIndex <= 0) return order[1]!;
  return order[1 + (activeIndex % (order.length - 1))]!;
};

export const isEntityActiveLeader = (replica: EntityReplica): boolean =>
  getEntityLeaderState(replica.state).activeValidatorId === normalizeSignerId(replica.signerId);

export const getReplicaProposalLeader = (replica: EntityReplica): EntityLeaderState => {
  const certificate = replica.pendingLeaderCertificate;
  if (!certificate) return getEntityLeaderState(replica.state);
  return {
    activeValidatorId: certificate.nextLeaderId,
    view: certificate.toView,
    changedAtHeight: certificate.targetHeight,
  };
};

export const isReplicaProposalLeader = (replica: EntityReplica): boolean =>
  getReplicaProposalLeader(replica).activeValidatorId === normalizeSignerId(replica.signerId);

export const getEntityLeaderTimeoutMs = (nextView: number): number =>
  Math.min(ENTITY_LEADER_TIMEOUT_MAX_MS, ENTITY_LEADER_TIMEOUT_BASE_MS * Math.max(1, Math.floor(nextView)));

export const buildEntityLeaderVoteBody = (state: EntityState): EntityLeaderTimeoutVoteBody => {
  const leader = getEntityLeaderState(state);
  return {
    entityId: normalizeSignerId(state.entityId),
    targetHeight: state.height + 1,
    previousFrameHash: state.height === 0 ? 'genesis' : String(state.prevFrameHash || ''),
    fromView: leader.view,
    toView: leader.view + 1,
    previousLeaderId: leader.activeValidatorId,
    nextLeaderId: getNextEntityFallbackLeader(state),
  };
};

const leaderVoteFields = (vote: EntityLeaderTimeoutVoteBody): EntityLeaderTimeoutVoteBody => ({
  entityId: normalizeSignerId(vote.entityId),
  targetHeight: vote.targetHeight,
  previousFrameHash: vote.previousFrameHash,
  fromView: vote.fromView,
  toView: vote.toView,
  previousLeaderId: normalizeSignerId(vote.previousLeaderId),
  nextLeaderId: normalizeSignerId(vote.nextLeaderId),
});

export const hashEntityLeaderVoteBody = (body: EntityLeaderTimeoutVoteBody): string =>
  ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson({
    domain: 'xln.entity.leader-timeout.v1',
    ...leaderVoteFields(body),
  })));

export const assertEntityLeaderVoteMatchesState = (
  state: EntityState,
  vote: EntityLeaderTimeoutVoteBody,
): void => {
  const expected = buildEntityLeaderVoteBody(state);
  if (serializeTaggedJson(leaderVoteFields(vote)) !== serializeTaggedJson(expected)) {
    throw new Error(`ENTITY_LEADER_VOTE_STALE_OR_INVALID: expected=${serializeTaggedJson(expected)}`);
  }
};

export const leaderVoteCollectionKey = (vote: EntityLeaderTimeoutVoteBody): string =>
  hashEntityLeaderVoteBody(leaderVoteFields(vote));

const LOCAL_LEADER_TIMEOUT_VOTE = Symbol.for('xln.entity.leader-timeout.local');

export const markLocalEntityLeaderTimeoutVote = (vote: EntityLeaderTimeoutVote): void => {
  Object.defineProperty(vote, LOCAL_LEADER_TIMEOUT_VOTE, { value: true, enumerable: false });
};

export const isLocalEntityLeaderTimeoutVote = (vote: EntityLeaderTimeoutVote): boolean =>
  (vote as EntityLeaderTimeoutVote & { [LOCAL_LEADER_TIMEOUT_VOTE]?: boolean })[LOCAL_LEADER_TIMEOUT_VOTE] === true;

export const buildEntityLeaderCertificate = (
  body: EntityLeaderTimeoutVoteBody,
  votes: Map<string, EntityLeaderTimeoutVote>,
): EntityLeaderCertificate => ({
  ...leaderVoteFields(body),
  votes: new Map(Array.from(votes.entries()).map(([signerId, vote]) => [normalizeSignerId(signerId), vote.signature])),
});

export const getEntityQuorumSafetyWarning = (config: ConsensusConfig): string | null => {
  const totalShares = Object.values(config.shares).reduce((total, shares) => total + shares, 0n);
  if (totalShares <= 0n) return 'ENTITY_BOARD_TOTAL_SHARES_ZERO';
  if (config.threshold * 3n <= totalShares * 2n) {
    return `ENTITY_BOARD_LOW_QUORUM_SAFETY: threshold=${config.threshold} totalShares=${totalShares}`;
  }
  return null;
};

export const hasEntityLeaderWork = (replica: EntityReplica): boolean => {
  if (replica.mempool.length > 0 || replica.proposal || replica.lockedFrame) return true;
  for (const account of replica.state.accounts.values()) {
    if (account.mempool.length > 0 || account.pendingFrame || account.pendingAccountInput) return true;
  }
  return false;
};
