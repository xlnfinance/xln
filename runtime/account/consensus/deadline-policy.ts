import { HASHLADDER_MAX_FILL_RATIO, verifyHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import type { AccountFrame, AccountMachine, HtlcLock } from '../../types';
import { isPullRevealExpired } from '../pull-deadline';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from './constants';

export const HTLC_ENFORCEMENT_RESERVE_MS = ACCOUNT_NETWORK_ALLOWANCE_MS;

export type AccountInputSecurityContext = {
  entityTimestamp: number;
  finalizedJHeight: number;
};

export type IncomingDeadlineViolation = {
  reason: string;
  evidenceSecrets: Array<{ hashlock: string; secret: string }>;
};

export function isHtlcSecretEnforcementWindowClosed(
  lock: Pick<HtlcLock, 'timelock' | 'revealBeforeHeight'>,
  securityContext: AccountInputSecurityContext,
): boolean {
  const timestampTooLate =
    BigInt(securityContext.entityTimestamp) + BigInt(HTLC_ENFORCEMENT_RESERVE_MS) > lock.timelock;
  const finalizedHeightTooLate = securityContext.finalizedJHeight > lock.revealBeforeHeight;
  return timestampTooLate || finalizedHeightTooLate;
}

const normalizedFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(value) || 0)));

const deadlineViolation = (reason: string): IncomingDeadlineViolation => ({ reason, evidenceSecrets: [] });

const htlcViolation = (
  account: AccountMachine,
  frame: AccountFrame,
  context: AccountInputSecurityContext,
): IncomingDeadlineViolation | undefined => {
  for (const tx of frame.accountTxs) {
    if (tx.type === 'htlc_lock' && !account.locks.has(tx.data.lockId)) {
      const timestampUnsafe =
        tx.data.timelock <= BigInt(context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS);
      const heightUnsafe = tx.data.revealBeforeHeight <= context.finalizedJHeight;
      if (timestampUnsafe || heightUnsafe) {
        return deadlineViolation(
          `HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} localTimestamp=${context.entityTimestamp} localJHeight=${context.finalizedJHeight}`,
        );
      }
    }
    if (tx.type !== 'htlc_resolve') continue;
    const lock = account.locks.get(tx.data.lockId);
    if (!lock) continue;
    if (tx.data.outcome === 'secret' && tx.data.secret) {
      if (isHtlcSecretEnforcementWindowClosed(lock, context)) {
        return {
          reason: `HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} reserve=${HTLC_ENFORCEMENT_RESERVE_MS}ms localTimestamp=${context.entityTimestamp}`,
          evidenceSecrets: [{ hashlock: lock.hashlock, secret: tx.data.secret }],
        };
      }
      continue;
    }
    const proposerIsPayer = frame.byLeft === lock.senderIsLeft;
    const locallyExpired =
      context.finalizedJHeight > lock.revealBeforeHeight || BigInt(context.entityTimestamp) > lock.timelock;
    if (tx.data.outcome === 'error' && proposerIsPayer && !locallyExpired) {
      return deadlineViolation(
        `HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: lock=${tx.data.lockId} localTimestamp=${context.entityTimestamp} localJHeight=${context.finalizedJHeight}`,
      );
    }
  }
  return undefined;
};

const pullCreationViolation = (
  account: AccountMachine,
  frame: AccountFrame,
  context: AccountInputSecurityContext,
): IncomingDeadlineViolation | undefined => {
  for (const tx of frame.accountTxs) {
    if (tx.type !== 'pull_lock' || account.pulls?.has(tx.data.pullId)) continue;
    if (tx.data.revealedUntilTimestamp <= context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS) {
      return deadlineViolation(
        `PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
      );
    }
  }
  return undefined;
};

const pullClaimViolation = (
  account: AccountMachine,
  frame: AccountFrame,
  context: AccountInputSecurityContext,
): IncomingDeadlineViolation | undefined => {
  for (const tx of frame.accountTxs) {
    if (tx.type !== 'pull_resolve' && tx.type !== 'cross_pull_close') continue;
    const pull = account.pulls?.get(tx.data.pullId);
    if (!pull || !isPullRevealExpired(pull.revealedUntilTimestamp, context.entityTimestamp)) continue;
    if (tx.type === 'cross_pull_close') {
      if (normalizedFillRatio(tx.data.proof.fillRatio) > normalizedFillRatio(pull.claimedRatio)) {
        return deadlineViolation(
          `CROSS_PULL_CLAIM_AFTER_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
        );
      }
      continue;
    }
    try {
      const decoded = verifyHashLadderBinary(
        { fullHash: pull.fullHash, partialRoot: pull.partialRoot },
        tx.data.binary,
      );
      if (normalizedFillRatio(decoded.fillRatio) > normalizedFillRatio(pull.claimedRatio)) {
        return deadlineViolation(
          `PULL_CLAIM_AFTER_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
        );
      }
    } catch {
      // Canonical account-tx validation reports malformed ladder evidence.
    }
  }
  return undefined;
};

const pullCancelViolation = (
  account: AccountMachine,
  frame: AccountFrame,
  context: AccountInputSecurityContext,
): IncomingDeadlineViolation | undefined => {
  for (const tx of frame.accountTxs) {
    if (tx.type !== 'pull_cancel') continue;
    const pull = account.pulls?.get(tx.data.pullId);
    if (!pull) continue;
    const payerIsLeft = !(pull.amount > 0n);
    if (frame.byLeft === payerIsLeft && !isPullRevealExpired(pull.revealedUntilTimestamp, context.entityTimestamp)) {
      return deadlineViolation(
        `PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
      );
    }
  }
  return undefined;
};

/**
 * Peer frame time/J-height is consensus data, not a trusted local clock.
 * This pure admission guard prevents stale/future frames from creating an
 * unenforceable obligation or exercising a payer timeout prematurely.
 */
export function getIncomingAccountDeadlineViolation(
  account: AccountMachine,
  frame: AccountFrame,
  context: AccountInputSecurityContext,
): IncomingDeadlineViolation | undefined {
  return htlcViolation(account, frame, context)
    ?? pullCreationViolation(account, frame, context)
    ?? pullClaimViolation(account, frame, context)
    ?? pullCancelViolation(account, frame, context);
}
