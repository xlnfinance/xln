import { HASHLADDER_MAX_FILL_RATIO, verifyHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import type { AccountFrame, AccountMachine, HtlcLock, PullCommitment } from '../../types';
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

const clonePulls = (account: AccountMachine): Map<string, PullCommitment> => new Map(
  Array.from(account.pulls?.entries() ?? [], ([pullId, pull]) => [pullId, { ...pull }]),
);

const validHtlcSecret = (lock: HtlcLock, secret: string | undefined): boolean => {
  if (!secret) return false;
  try {
    return hashHtlcSecret(secret) === lock.hashlock;
  } catch {
    return false;
  }
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
  const locks = new Map(account.locks);
  const pulls = clonePulls(account);
  if (typeof frame.byLeft !== 'boolean') {
    return deadlineViolation('ACCOUNT_FRAME_PROPOSER_SIDE_MISSING');
  }
  const proposerIsLeft = frame.byLeft;

  for (const tx of frame.accountTxs) {
    if (tx.type === 'htlc_lock') {
      if (locks.has(tx.data.lockId)) continue;
      const timestampUnsafe =
        tx.data.timelock <= BigInt(context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS);
      const heightUnsafe = tx.data.revealBeforeHeight <= context.finalizedJHeight;
      if (timestampUnsafe || heightUnsafe) {
        return deadlineViolation(
          `HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} localTimestamp=${context.entityTimestamp} localJHeight=${context.finalizedJHeight}`,
        );
      }
      locks.set(tx.data.lockId, {
        lockId: tx.data.lockId,
        hashlock: tx.data.hashlock,
        timelock: tx.data.timelock,
        revealBeforeHeight: tx.data.revealBeforeHeight,
        amount: tx.data.amount,
        tokenId: tx.data.tokenId,
        senderIsLeft: proposerIsLeft,
        createdHeight: frame.height,
        createdTimestamp: frame.timestamp,
        ...(tx.data.envelope !== undefined ? { envelope: tx.data.envelope } : {}),
      });
      continue;
    }

    if (tx.type === 'htlc_resolve') {
      const lock = locks.get(tx.data.lockId);
      if (!lock) continue;
      if (tx.data.outcome === 'secret') {
        if (tx.data.secret && isHtlcSecretEnforcementWindowClosed(lock, context)) {
          return {
            reason: `HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} reserve=${HTLC_ENFORCEMENT_RESERVE_MS}ms localTimestamp=${context.entityTimestamp}`,
            evidenceSecrets: [{ hashlock: lock.hashlock, secret: tx.data.secret }],
          };
        }
        if (validHtlcSecret(lock, tx.data.secret)) locks.delete(tx.data.lockId);
        continue;
      }
      const proposerIsPayer = proposerIsLeft === lock.senderIsLeft;
      const locallyExpired =
        context.finalizedJHeight > lock.revealBeforeHeight || BigInt(context.entityTimestamp) > lock.timelock;
      if (proposerIsPayer && !locallyExpired) {
        return deadlineViolation(
          `HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: lock=${tx.data.lockId} localTimestamp=${context.entityTimestamp} localJHeight=${context.finalizedJHeight}`,
        );
      }
      const beneficiaryRelease = !proposerIsPayer && tx.data.reason !== 'timeout';
      if (locallyExpired || beneficiaryRelease) locks.delete(tx.data.lockId);
      continue;
    }

    if (tx.type === 'pull_lock') {
      if (pulls.has(tx.data.pullId)) continue;
      if (tx.data.revealedUntilTimestamp <= context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS) {
        return deadlineViolation(
          `PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
        );
      }
      pulls.set(tx.data.pullId, {
        ...tx.data,
        claimedRatio: 0,
        claimedAmount: 0n,
        createdHeight: frame.height,
        createdTimestamp: frame.timestamp,
      });
      continue;
    }

    if (tx.type === 'pull_resolve' || tx.type === 'cross_pull_close') {
      const pull = pulls.get(tx.data.pullId);
      if (!pull) continue;
      let ratio: number | undefined;
      try {
        ratio = tx.type === 'cross_pull_close'
          ? normalizedFillRatio(tx.data.proof.fillRatio)
          : normalizedFillRatio(verifyHashLadderBinary(
            { fullHash: pull.fullHash, partialRoot: pull.partialRoot },
            tx.data.binary,
          ).fillRatio);
      } catch {
        // Canonical account-tx validation rejects malformed proof data.
      }
      if (ratio === undefined || ratio <= normalizedFillRatio(pull.claimedRatio)) continue;
      if (isPullRevealExpired(pull.revealedUntilTimestamp, context.entityTimestamp)) {
        return deadlineViolation(
          `${tx.type === 'cross_pull_close' ? 'CROSS_PULL' : 'PULL'}_CLAIM_AFTER_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
        );
      }
      if (tx.type === 'cross_pull_close' || ratio >= HASHLADDER_MAX_FILL_RATIO) {
        pulls.delete(tx.data.pullId);
      } else {
        pull.claimedRatio = ratio;
      }
      continue;
    }

    if (tx.type === 'pull_cancel') {
      const pull = pulls.get(tx.data.pullId);
      if (!pull) continue;
      const payerIsLeft = !(pull.amount > 0n);
      const proposerIsPayer = proposerIsLeft === payerIsLeft;
      const locallyExpired = isPullRevealExpired(pull.revealedUntilTimestamp, context.entityTimestamp);
      if (proposerIsPayer && !locallyExpired) {
        return deadlineViolation(
          `PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${context.entityTimestamp}`,
        );
      }
      if (!proposerIsPayer || locallyExpired) pulls.delete(tx.data.pullId);
    }
  }
  return undefined;
}
