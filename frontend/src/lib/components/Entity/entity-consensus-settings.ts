import type { EntityReplica, Proposal } from '@xln/runtime/types';
import {
  projectConsensusPayments,
  type ConsensusPaymentProposalView,
  type EntityConsensusSettingsOptions,
} from './entity-consensus-payment-view';

export type {
  ConsensusPaymentProposalView,
  ConsensusTokenMetadata,
  EntityConsensusSettingsOptions,
} from './entity-consensus-payment-view';

export type ConsensusBoardMemberView = {
  signerId: string;
  shares: bigint;
  isLeader: boolean;
  isLocalSigner: boolean;
};

export type ConsensusProposalView = {
  id: string;
  proposer: string;
  actionType: string;
  status: Proposal['status'];
  created: number;
  yesShares: bigint;
  noShares: bigint;
  abstainShares: bigint;
  voteCount: number;
  payments: ConsensusPaymentProposalView[];
};

export type ConsensusAccountFrameView = {
  counterpartyId: string;
  currentHeight: number;
  currentTimestamp: number;
  currentHash: string;
  pendingHeight: number | null;
  pendingHash: string | null;
};

export type ConsensusHookView = {
  id: string;
  type: string;
  triggerAt: number;
};

export type EntityConsensusSettingsView = {
  runtimeHeight: number;
  entityHeight: number;
  entityTimestamp: number;
  entityFrameHash: string;
  lastFinalizedJHeight: number;
  scannedJHeight: number | null;
  jHistoryRoot: string;
  boardMode: string;
  threshold: bigint;
  totalShares: bigint;
  board: ConsensusBoardMemberView[];
  leaderId: string;
  leaderView: number;
  leaderChangedAtHeight: number;
  proposals: ConsensusProposalView[];
  accounts: ConsensusAccountFrameView[];
  hooks: ConsensusHookView[];
  localDiagnosticsAvailable: boolean;
  pendingFrameHeight: number | null;
  pendingFrameHash: string | null;
  lockedFrameHeight: number | null;
  lockedFrameHash: string | null;
  leaderVoteCount: number;
  leaderCertificateVoteCount: number;
  certifiedLineageLength: number;
  certifiedAnchorHeight: number | null;
  certifiedAnchorHash: string | null;
  hankoWitnessCount: number;
  jPrefixCertified: boolean;
  lastConsensusProgressAt: number | null;
};

const proposalChoice = (vote: Proposal['votes'] extends Map<string, infer V> ? V : never): 'yes' | 'no' | 'abstain' =>
  typeof vote === 'string' ? vote : vote.choice;

const proposalView = (
  proposal: Proposal,
  shares: Record<string, bigint>,
  options: EntityConsensusSettingsOptions,
): ConsensusProposalView => {
  let yesShares = 0n;
  let noShares = 0n;
  let abstainShares = 0n;
  for (const [signerId, vote] of proposal.votes.entries()) {
    const signerShares = shares[signerId];
    if (typeof signerShares !== 'bigint') {
      throw new Error(`CONSENSUS_SETTINGS_UNKNOWN_VOTER: proposal=${proposal.id} signer=${signerId}`);
    }
    const choice = proposalChoice(vote);
    if (choice === 'yes') yesShares += signerShares;
    else if (choice === 'no') noShares += signerShares;
    else abstainShares += signerShares;
  }
  return {
    id: proposal.id,
    proposer: proposal.proposer,
    actionType: proposal.action.type,
    status: proposal.status,
    created: proposal.created,
    yesShares,
    noShares,
    abstainShares,
    voteCount: proposal.votes.size,
    payments: projectConsensusPayments(proposal, options),
  };
};

const certificateVoteCount = (replica: EntityReplica): number => {
  const certificate = replica.pendingLeaderCertificate;
  if (!certificate) return 0;
  return certificate.preparedVotes?.size ?? certificate.votes.size;
};

const boardShares = (replica: EntityReplica, signerId: string): bigint => {
  const shares = replica.state.config.shares[signerId];
  if (typeof shares !== 'bigint') {
    throw new Error(`CONSENSUS_SETTINGS_BOARD_SHARE_MISSING: signer=${signerId}`);
  }
  return shares;
};

export const buildEntityConsensusSettingsView = (
  replica: EntityReplica,
  runtimeHeight: number,
  localDiagnosticsAvailable: boolean,
  options: EntityConsensusSettingsOptions = {},
): EntityConsensusSettingsView => {
  const state = replica.state;
  const leaderId = state.leaderState?.activeValidatorId ?? state.config.validators[0] ?? '';
  const board = state.config.validators.map((signerId) => ({
    signerId,
    shares: boardShares(replica, signerId),
    isLeader: signerId === leaderId,
    isLocalSigner: signerId === replica.signerId,
  }));
  const accounts = Array.from(state.accounts.entries())
    .map(([counterpartyId, account]) => ({
      counterpartyId,
      currentHeight: account.currentHeight,
      currentTimestamp: account.currentFrame.timestamp,
      currentHash: account.currentFrame.stateHash,
      pendingHeight: account.pendingFrame?.height ?? null,
      pendingHash: account.pendingFrame?.stateHash ?? null,
    }))
    .sort((a, b) => a.counterpartyId.localeCompare(b.counterpartyId));
  const hooks = Array.from(state.crontabState?.hooks.values() ?? [])
    .map((hook) => ({ id: hook.id, type: hook.type, triggerAt: hook.triggerAt }))
    .sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id));
  return {
    runtimeHeight,
    entityHeight: state.height,
    entityTimestamp: state.timestamp,
    entityFrameHash: state.prevFrameHash ?? '',
    lastFinalizedJHeight: state.lastFinalizedJHeight,
    scannedJHeight: localDiagnosticsAvailable ? (replica.jHistory?.scannedThroughHeight ?? 0) : null,
    jHistoryRoot: state.jHistoryFinality?.eventHistoryRoot ?? '',
    boardMode: state.config.mode,
    threshold: state.config.threshold,
    totalShares: board.reduce((sum, member) => sum + member.shares, 0n),
    board,
    leaderId,
    leaderView: state.leaderState?.view ?? 0,
    leaderChangedAtHeight: state.leaderState?.changedAtHeight ?? 0,
    proposals: Array.from(state.proposals.values())
      .map((proposal) => proposalView(proposal, state.config.shares, options))
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)),
    accounts,
    hooks,
    localDiagnosticsAvailable,
    pendingFrameHeight: replica.proposal?.height ?? null,
    pendingFrameHash: replica.proposal?.hash ?? null,
    lockedFrameHeight: replica.lockedFrame?.height ?? null,
    lockedFrameHash: replica.lockedFrame?.hash ?? null,
    leaderVoteCount: replica.leaderVotes?.size ?? 0,
    leaderCertificateVoteCount: certificateVoteCount(replica),
    certifiedLineageLength: replica.certifiedFrameLineage?.length ?? 0,
    certifiedAnchorHeight: replica.certifiedFrameAnchor?.height ?? null,
    certifiedAnchorHash: replica.certifiedFrameAnchor?.frameHash ?? null,
    hankoWitnessCount: replica.hankoWitness?.size ?? 0,
    jPrefixCertified: Boolean(replica.jPrefixRound?.certificate),
    lastConsensusProgressAt: replica.lastConsensusProgressAt ?? null,
  };
};
