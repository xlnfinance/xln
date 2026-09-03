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
import { isSecretAckPendingPayment } from '../paybook/views';
import { compareStableText } from '../../protocol/serialization';

type DerivedHtlcTimeout = ScheduledHookBase<'htlc_timeout', {
  accountId: string;
  lockId: string;
}>;

export type DerivedSecretAckTimeout = ScheduledHookBase<'htlc_secret_ack_timeout', {
  hashlock: string;
  counterpartyEntityId: string;
}>;

export type DerivedDeadline = DerivedHtlcTimeout | DerivedSecretAckTimeout;

export const compareDeadlines = (
  left: Readonly<{ triggerAt: number; id: string }>,
  right: Readonly<{ triggerAt: number; id: string }>,
): number => left.triggerAt - right.triggerAt || compareStableText(left.id, right.id);

const htlcTimeoutAt = (timelock: bigint | number | undefined): number | null => {
  if (timelock === undefined || timelock === null) return null;
  const value = Number(timelock);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/**
 * Every derived deadline of the Entity, optionally only those due by `now`.
 * Sorted by (`triggerAt`, id) — the same key the hook map drained by.
 */
export const collectDerivedDeadlines = (
  state: EntityState,
  now?: number,
): DerivedDeadline[] => {
  const due: DerivedDeadline[] = [];
  for (const [accountId, account] of state.accounts.entries()) {
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
    const triggerAt = entry.secretAckDeadlineAt;
    if (now !== undefined && triggerAt > now) continue;
    due.push({
      id: `htlc-secret-ack:${entry.hashlock}`,
      triggerAt,
      type: 'htlc_secret_ack_timeout',
      data: { hashlock: entry.hashlock, counterpartyEntityId: entry.inboundEntity },
    });
  }
  return due.sort(compareDeadlines);
};

/** Earliest derived deadline, or null when no payment is waiting on time. */
export const earliestDerivedDeadline = (state: EntityState): number | null => {
  let earliest = Infinity;
  for (const account of state.accounts.values()) {
    for (const lock of account.state.locks.values()) {
      const triggerAt = htlcTimeoutAt(lock.timelock);
      if (triggerAt !== null && triggerAt < earliest) earliest = triggerAt;
    }
  }
  for (const entry of state.paybook.entries.values()) {
    if (isSecretAckPendingPayment(entry) && entry.secretAckDeadlineAt < earliest) {
      earliest = entry.secretAckDeadlineAt;
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
};
