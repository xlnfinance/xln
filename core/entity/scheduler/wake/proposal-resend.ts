/**
 * Time-based resend of a pending Account proposal. Pure functions of
 * committed EntityState and the Entity clock so that the proposer's scheduled
 * wake, the forced flush and every validator agree on the same due set.
 */
import type { EntityState } from '../../types';
import { ACCOUNT_PROPOSAL_RESEND_MS } from '../../../account/consensus/constants';
import { compareStableText } from '../../../protocol/serialization';

export const proposalResendDueAt = (sentAt: number): number => sentAt + ACCOUNT_PROPOSAL_RESEND_MS;

export const isProposalResendDue = (sentAt: number, now: number): boolean =>
  now >= proposalResendDueAt(sentAt);

export type ProposalResendDue = Readonly<{ accountKey: string; dueAt: number }>;

/** Accounts whose unacknowledged proposal has waited a full resend window at `now`; stable order. */
export const collectDueProposalResends = (state: EntityState, now: number): ProposalResendDue[] => {
  const due: ProposalResendDue[] = [];
  for (const [accountKey, account] of state.accounts) {
    if (!account.pendingFrame || account.pendingProposalSentAt === undefined) continue;
    const dueAt = proposalResendDueAt(account.pendingProposalSentAt);
    if (dueAt <= now) due.push({ accountKey, dueAt });
  }
  return due.sort((left, right) => left.dueAt - right.dueAt || compareStableText(left.accountKey, right.accountKey));
};

/** Earliest resend deadline over all pending proposals, or null when nothing waits for an ACK. */
export const nextProposalResendDeadline = (state: EntityState): number | null => {
  let next = Infinity;
  for (const account of state.accounts.values()) {
    if (!account.pendingFrame || account.pendingProposalSentAt === undefined) continue;
    next = Math.min(next, proposalResendDueAt(account.pendingProposalSentAt));
  }
  return Number.isFinite(next) ? next : null;
};
