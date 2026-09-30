/**
 * Per-payment deadlines are not crontab hooks. Every HTLC lock already
 * carries its `timelock` in Account state and every secret-ack wait carries
 * `secretAckDeadlineAt` on its paybook entry, so the scheduler derives the
 * due set from EntityState at the wake timestamp instead of mutating the
 * committed hook map four times per payment. The derived items keep the
 * historical hook ids and ordering keys (`triggerAt`, then id) so a wake
 * drains them in exactly the order the hook map used to.
 */
import type { EntityState } from '../types';
import type { ScheduledHookBase } from './types';
import { isSecretAckPendingPayment, type SecretAckPendingPayment } from '../paybook/views';
import { HTLC_ENFORCEMENT_RESERVE_MS } from '../../account/consensus/dispute/deadline-policy';
import { compareStableText } from '../../protocol/serialization';
import { canProcessAccountTxForDisputeStatus } from '../../account/consensus/dispute/policy';

type DerivedHtlcTimeout = ScheduledHookBase<'htlc_timeout', {
  accountId: string;
  lockId: string;
}>;

export type DerivedSecretAckTimeout = ScheduledHookBase<'htlc_secret_ack_timeout', {
  hashlock: string;
  counterpartyEntityId: string;
}>;

/**
 * A loan whose term passed without full repayment. `dueAt` is committed Entity
 * state, so the settlement wake is derived exactly like an HTLC timelock.
 */
type DerivedLendingOverdue = ScheduledHookBase<'lending_overdue', {
  loanId: string;
}>;

export type DerivedDeadline = DerivedHtlcTimeout | DerivedSecretAckTimeout | DerivedLendingOverdue;

export const compareDeadlines = (
  left: Readonly<{ triggerAt: number; id: string }>,
  right: Readonly<{ triggerAt: number; id: string }>,
): number => left.triggerAt - right.triggerAt || compareStableText(left.id, right.id);

/** A peer withholding ACK cannot consume the signed lock's enforcement reserve. */
const secretAckTriggerAt = (state: EntityState, entry: SecretAckPendingPayment): number => {
  const account = state.accounts.get(entry.inboundEntity);
  // The dispute lifecycle owns frozen locks; do not re-arm their past reserve every frame.
  if (!account || !canProcessAccountTxForDisputeStatus(account.status)) return entry.secretAckDeadlineAt;
  const lock = account.state.locks.get(entry.hashlock);
  if (!lock) return entry.secretAckDeadlineAt;
  const enforcementAt = lock.timelock - BigInt(HTLC_ENFORCEMENT_RESERVE_MS);
  const ackAt = BigInt(entry.secretAckDeadlineAt);
  const startedAt = BigInt(entry.secretAckStartedAt);
  return Number(enforcementAt < startedAt ? startedAt : enforcementAt < ackAt ? enforcementAt : ackAt);
};

const htlcTimeoutAt = (timelock: bigint | number | undefined): number | null => {
  if (timelock === undefined || timelock === null) return null;
  const value = Number(timelock);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/**
 * Every derived deadline of the Entity, optionally only those due by `now`.
 * Sorted by (`triggerAt`, id) — the same key the hook map drained by.
 *
 * A non-active Account (dispute preparing/disputed) has no Account tx
 * consumer: its `htlc_resolve` would be suppressed after the wake, so the
 * same past timelock would re-arm every Runtime frame for the whole dispute
 * window. Its locks contribute no deadline until on-chain finality owns them.
 */
export const collectDerivedDeadlines = (state: EntityState, now?: number): DerivedDeadline[] => {
  const due: DerivedDeadline[] = [];
  for (const [accountId, account] of state.accounts.entries()) {
    if (!canProcessAccountTxForDisputeStatus(account.status)) continue;
    for (const lock of account.state.locks.values()) {
      const triggerAt = htlcTimeoutAt(lock.timelock);
      if (triggerAt === null || (now !== undefined && triggerAt > now)) continue;
      due.push({
        id: `htlc-timeout:${lock.lockId}`,
        triggerAt,
        type: 'htlc_timeout',
        data: { accountId, lockId: lock.lockId },
      });
    }
  }
  for (const entry of state.paybook.entries.values()) {
    if (!isSecretAckPendingPayment(entry)) continue;
    const triggerAt = secretAckTriggerAt(state, entry);
    if (now !== undefined && triggerAt > now) continue;
    due.push({
      id: `htlc-secret-ack:${entry.hashlock}`,
      triggerAt,
      type: 'htlc_secret_ack_timeout',
      data: { hashlock: entry.hashlock, counterpartyEntityId: entry.inboundEntity },
    });
  }
  for (const loan of state.lending?.loans.values() ?? []) {
    if (loan.status !== 'active') continue;
    if (now !== undefined && loan.dueAt > now) continue;
    due.push({
      id: `lending-overdue:${loan.loanId}`,
      triggerAt: loan.dueAt,
      type: 'lending_overdue',
      data: { loanId: loan.loanId },
    });
  }
  return due.sort(compareDeadlines);
};

/** Earliest derived deadline, or null when no payment is waiting on time. */
export const earliestDerivedDeadline = (state: EntityState): number | null => {
  let earliest = Infinity;
  for (const account of state.accounts.values()) {
    if (!canProcessAccountTxForDisputeStatus(account.status)) continue;
    for (const lock of account.state.locks.values()) {
      const triggerAt = htlcTimeoutAt(lock.timelock);
      if (triggerAt !== null && triggerAt < earliest) earliest = triggerAt;
    }
  }
  for (const entry of state.paybook.entries.values()) {
    if (isSecretAckPendingPayment(entry)) {
      earliest = Math.min(earliest, secretAckTriggerAt(state, entry));
    }
  }
  for (const loan of state.lending?.loans.values() ?? []) {
    if (loan.status === 'active' && loan.dueAt < earliest) earliest = loan.dueAt;
  }
  return Number.isFinite(earliest) ? earliest : null;
};
