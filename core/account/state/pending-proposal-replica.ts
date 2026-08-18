/**
 * In-memory proposer candidate for one pending Account frame.
 *
 * Receiver already installs the validated clone instead of replaying txs.
 * Proposer used to throw that candidate away and re-apply every tx on ACK.
 * This cache is replica-local: not AccountState, not Entity-committed, not WAL.
 *
 * The stashed candidate is the pre-sign financial replica. Entity consensus
 * later attaches the dispute Hanko to the live replica. ACK install must keep
 * that live envelope; Object.assign of the unsigned candidate would drop the
 * signed ProofBody and fail reachable-evidence retention.
 */
import type { AccountReplica } from '../../types/account';

const pendingProposalByReplica = new WeakMap<AccountReplica, AccountReplica>();

type ProposerAckEnvelope = {
  pendingFrame: AccountReplica['pendingFrame'];
  pendingAccountInput: AccountReplica['pendingAccountInput'];
  mempool: AccountReplica['mempool'];
  proofHeader: AccountReplica['proofHeader'];
  currentDisputeProofHanko: AccountReplica['currentDisputeProofHanko'];
  currentDisputeHash: AccountReplica['currentDisputeHash'];
  currentDisputeProofBodyHash: AccountReplica['currentDisputeProofBodyHash'];
  currentDisputeProofNonce: AccountReplica['currentDisputeProofNonce'];
  currentDisputeProofProposerIsLeft: AccountReplica['currentDisputeProofProposerIsLeft'];
  counterpartyDisputeProofHanko: AccountReplica['counterpartyDisputeProofHanko'];
  counterpartyDisputeHash: AccountReplica['counterpartyDisputeHash'];
  counterpartyDisputeProofBodyHash: AccountReplica['counterpartyDisputeProofBodyHash'];
  counterpartyDisputeProofNonce: AccountReplica['counterpartyDisputeProofNonce'];
  counterpartyDisputeProofProposerIsLeft: AccountReplica['counterpartyDisputeProofProposerIsLeft'];
  disputeProofBodiesByHash: AccountReplica['disputeProofBodiesByHash'];
  disputeProofNoncesByHash: AccountReplica['disputeProofNoncesByHash'];
  disputeArgumentSnapshotsByHash: AccountReplica['disputeArgumentSnapshotsByHash'];
};

const captureProposerAckEnvelope = (live: AccountReplica): ProposerAckEnvelope => ({
  pendingFrame: live.pendingFrame,
  pendingAccountInput: live.pendingAccountInput,
  mempool: live.mempool,
  proofHeader: live.proofHeader,
  currentDisputeProofHanko: live.currentDisputeProofHanko,
  currentDisputeHash: live.currentDisputeHash,
  currentDisputeProofBodyHash: live.currentDisputeProofBodyHash,
  currentDisputeProofNonce: live.currentDisputeProofNonce,
  currentDisputeProofProposerIsLeft: live.currentDisputeProofProposerIsLeft,
  counterpartyDisputeProofHanko: live.counterpartyDisputeProofHanko,
  counterpartyDisputeHash: live.counterpartyDisputeHash,
  counterpartyDisputeProofBodyHash: live.counterpartyDisputeProofBodyHash,
  counterpartyDisputeProofNonce: live.counterpartyDisputeProofNonce,
  counterpartyDisputeProofProposerIsLeft: live.counterpartyDisputeProofProposerIsLeft,
  disputeProofBodiesByHash: live.disputeProofBodiesByHash,
  disputeProofNoncesByHash: live.disputeProofNoncesByHash,
  disputeArgumentSnapshotsByHash: live.disputeArgumentSnapshotsByHash,
});

const restoreOptional = <Key extends keyof AccountReplica>(
  live: AccountReplica,
  key: Key,
  value: AccountReplica[Key] | undefined,
): void => {
  if (value !== undefined) {
    live[key] = value;
    return;
  }
  delete live[key];
};

const restoreProposerAckEnvelope = (
  live: AccountReplica,
  envelope: ProposerAckEnvelope,
): void => {
  restoreOptional(live, 'pendingFrame', envelope.pendingFrame);
  restoreOptional(live, 'pendingAccountInput', envelope.pendingAccountInput);
  live.mempool = envelope.mempool;
  live.proofHeader = envelope.proofHeader;
  restoreOptional(live, 'currentDisputeProofHanko', envelope.currentDisputeProofHanko);
  restoreOptional(live, 'currentDisputeHash', envelope.currentDisputeHash);
  restoreOptional(live, 'currentDisputeProofBodyHash', envelope.currentDisputeProofBodyHash);
  restoreOptional(live, 'currentDisputeProofNonce', envelope.currentDisputeProofNonce);
  restoreOptional(live, 'currentDisputeProofProposerIsLeft', envelope.currentDisputeProofProposerIsLeft);
  restoreOptional(live, 'counterpartyDisputeProofHanko', envelope.counterpartyDisputeProofHanko);
  restoreOptional(live, 'counterpartyDisputeHash', envelope.counterpartyDisputeHash);
  restoreOptional(live, 'counterpartyDisputeProofBodyHash', envelope.counterpartyDisputeProofBodyHash);
  restoreOptional(live, 'counterpartyDisputeProofNonce', envelope.counterpartyDisputeProofNonce);
  restoreOptional(live, 'counterpartyDisputeProofProposerIsLeft', envelope.counterpartyDisputeProofProposerIsLeft);
  restoreOptional(live, 'disputeProofBodiesByHash', envelope.disputeProofBodiesByHash);
  restoreOptional(live, 'disputeProofNoncesByHash', envelope.disputeProofNoncesByHash);
  restoreOptional(live, 'disputeArgumentSnapshotsByHash', envelope.disputeArgumentSnapshotsByHash);
};

export const stashPendingProposalReplica = (
  account: AccountReplica,
  candidate: AccountReplica,
): void => {
  pendingProposalByReplica.set(account, candidate);
};

export const takePendingProposalReplica = (
  account: AccountReplica,
): AccountReplica | undefined => {
  const candidate = pendingProposalByReplica.get(account);
  pendingProposalByReplica.delete(account);
  return candidate;
};

export const discardPendingProposalReplica = (account: AccountReplica): void => {
  pendingProposalByReplica.delete(account);
};

export const copyPendingProposalReplica = (
  source: AccountReplica,
  target: AccountReplica,
): void => {
  const candidate = pendingProposalByReplica.get(source);
  if (candidate) pendingProposalByReplica.set(target, candidate);
};

/** Install the stashed financial candidate without dropping the live signed dispute envelope. */
export const installPendingProposalReplica = (
  live: AccountReplica,
  prepared: AccountReplica,
): void => {
  const envelope = captureProposerAckEnvelope(live);
  Object.assign(live, prepared);
  restoreProposerAckEnvelope(live, envelope);
};
