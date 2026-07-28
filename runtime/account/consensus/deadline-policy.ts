import { HASHLADDER_MAX_FILL_RATIO, verifyHashLadderBinary } from '../../protocol/htlc/hash-ladder';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import { hashEncryptedHtlcLayer } from '../../protocol/htlc/onion-advance';
import type { AccountFrame, AccountMachine, HtlcLock, PullCommitment } from '../../types';
import { isHtlcTimelockExpired } from '../htlc-deadline';
import { isPullRevealExpired } from '../pull-deadline';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from './constants';

export const HTLC_ENFORCEMENT_RESERVE_MS = ACCOUNT_NETWORK_ALLOWANCE_MS;

export type AccountInputSecurityContext = {
  entityTimestamp: number;
  finalizedJHeight: number;
  owningEntityIsHub: boolean;
  /** Counterparty board from the consuming Entity's own finalized registry. */
  counterpartyCertifiedBoardHash?: string;
};

export type IncomingDeadlineViolation = {
  reason: string;
  evidenceSecrets: Array<{ hashlock: string; secret: string }>;
};

export function isHtlcSecretEnforcementWindowClosed(
  lock: Pick<HtlcLock, 'timelock' | 'revealBeforeHeight'>,
  securityContext: AccountInputSecurityContext,
): boolean {
  const timestampTooLate = isHtlcTimelockExpired(
    securityContext.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS,
    lock.timelock,
  );
  const finalizedHeightTooLate = securityContext.finalizedJHeight > lock.revealBeforeHeight;
  return timestampTooLate || finalizedHeightTooLate;
}

const normalizedFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(value) || 0)));

const deadlineViolation = (reason: string): IncomingDeadlineViolation => ({ reason, evidenceSecrets: [] });

// Deadline admission is speculative: a rejected frame must leave the live
// Account byte-identical. A Map clone alone still aliases HtlcLock values, so
// simulating an `offer` would otherwise publish secretOffer before consensus.
const cloneLocks = (account: AccountMachine): Map<string, HtlcLock> => new Map(
  Array.from(account.locks, ([lockId, lock]) => [lockId, { ...lock }]),
);

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

type AccountFrameTx = AccountFrame['accountTxs'][number];
type DeadlineScan = {
  locks: Map<string, HtlcLock>;
  pulls: Map<string, PullCommitment>;
  proposerIsLeft: boolean;
  frame: AccountFrame;
  context: AccountInputSecurityContext;
};

const inspectHtlcDeadline = (
  scan: DeadlineScan,
  tx: AccountFrameTx,
): IncomingDeadlineViolation | undefined => {
  if (tx.type === 'htlc_lock') {
    if (scan.locks.has(tx.data.lockId)) return undefined;
    const timestampUnsafe =
      tx.data.timelock <= BigInt(scan.context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS);
    const heightUnsafe = tx.data.revealBeforeHeight <= scan.context.finalizedJHeight;
    if (timestampUnsafe || heightUnsafe) {
      return deadlineViolation(
        `HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} localTimestamp=${scan.context.entityTimestamp} localJHeight=${scan.context.finalizedJHeight}`,
      );
    }
    scan.locks.set(tx.data.lockId, {
      lockId: tx.data.lockId,
      hashlock: tx.data.hashlock,
      timelock: tx.data.timelock,
      revealBeforeHeight: tx.data.revealBeforeHeight,
      amount: tx.data.amount,
      tokenId: tx.data.tokenId,
      senderIsLeft: scan.proposerIsLeft,
      createdHeight: scan.frame.height,
      createdTimestamp: scan.frame.timestamp,
      ...(tx.data.envelope !== undefined ? { envelope: tx.data.envelope } : {}),
    });
    return undefined;
  }
  if (tx.type !== 'htlc_resolve') return undefined;

  const lock = scan.locks.get(tx.data.lockId);
  if (!lock) return undefined;
  if (tx.data.outcome === 'offer') {
    if (scan.proposerIsLeft === lock.senderIsLeft) {
      return deadlineViolation(`HTLC_SECRET_OFFER_NOT_BENEFICIARY: lock=${tx.data.lockId}`);
    }
    if (lock.secretOffer) {
      if (hashEncryptedHtlcLayer(lock.secretOffer) !== hashEncryptedHtlcLayer(tx.data.offer)) {
        return deadlineViolation(`HTLC_SECRET_OFFER_CONFLICT: lock=${tx.data.lockId}`);
      }
    } else {
      lock.secretOffer = tx.data.offer;
    }
    return undefined;
  }
  if (tx.data.outcome === 'secret') {
    const rawSecret = 'secret' in tx.data ? tx.data.secret : undefined;
    const acceptedOffer = 'offerHash' in tx.data
      && Boolean(lock.secretOffer)
      && tx.data.offerHash.toLowerCase() === hashEncryptedHtlcLayer(lock.secretOffer!);
    const verifiedSecret = validHtlcSecret(lock, rawSecret);
    if ((verifiedSecret || acceptedOffer) && isHtlcSecretEnforcementWindowClosed(lock, scan.context)) {
      return {
        reason: `HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} reserve=${HTLC_ENFORCEMENT_RESERVE_MS}ms localTimestamp=${scan.context.entityTimestamp}`,
        evidenceSecrets: rawSecret ? [{ hashlock: lock.hashlock, secret: rawSecret }] : [],
      };
    }
    if (verifiedSecret || acceptedOffer) scan.locks.delete(tx.data.lockId);
    return undefined;
  }

  const proposerIsPayer = scan.proposerIsLeft === lock.senderIsLeft;
  const locallyExpired =
    scan.context.finalizedJHeight > lock.revealBeforeHeight ||
    isHtlcTimelockExpired(scan.context.entityTimestamp, lock.timelock);
  if (proposerIsPayer && !locallyExpired) {
    return deadlineViolation(
      `HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: lock=${tx.data.lockId} localTimestamp=${scan.context.entityTimestamp} localJHeight=${scan.context.finalizedJHeight}`,
    );
  }
  const beneficiaryRelease = !proposerIsPayer && tx.data.reason !== 'timeout';
  if (locallyExpired || beneficiaryRelease) scan.locks.delete(tx.data.lockId);
  return undefined;
};

const inspectPullDeadline = (
  scan: DeadlineScan,
  tx: AccountFrameTx,
): IncomingDeadlineViolation | undefined => {
  if (tx.type === 'pull_lock') {
    if (scan.pulls.has(tx.data.pullId)) return undefined;
    if (tx.data.revealedUntilTimestamp <= scan.context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS) {
      return deadlineViolation(
        `PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: pull=${tx.data.pullId} localTimestamp=${scan.context.entityTimestamp}`,
      );
    }
    scan.pulls.set(tx.data.pullId, {
      ...tx.data,
      claimedRatio: 0,
      claimedAmount: 0n,
      createdHeight: scan.frame.height,
      createdTimestamp: scan.frame.timestamp,
    });
    return undefined;
  }
  if (tx.type === 'pull_resolve' || tx.type === 'cross_pull_close') {
    const pull = scan.pulls.get(tx.data.pullId);
    if (!pull) return undefined;
    let ratio: number | undefined;
    try {
      ratio = tx.type === 'cross_pull_close'
        ? normalizedFillRatio(tx.data.proof.fillRatio)
        : normalizedFillRatio(verifyHashLadderBinary(
          { fullHash: pull.fullHash, partialRoot: pull.partialRoot },
          tx.data.binary,
        ).fillRatio);
    } catch {
      // Canonical Account transaction validation owns malformed proof errors.
    }
    if (ratio === undefined || ratio <= normalizedFillRatio(pull.claimedRatio)) return undefined;
    if (isPullRevealExpired(pull.revealedUntilTimestamp, scan.context.entityTimestamp)) {
      return deadlineViolation(
        `${tx.type === 'cross_pull_close' ? 'CROSS_PULL' : 'PULL'}_CLAIM_AFTER_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${scan.context.entityTimestamp}`,
      );
    }
    if (tx.type === 'cross_pull_close' || ratio >= HASHLADDER_MAX_FILL_RATIO) {
      scan.pulls.delete(tx.data.pullId);
    } else {
      pull.claimedRatio = ratio;
    }
    return undefined;
  }
  if (tx.type !== 'pull_cancel') return undefined;

  const pull = scan.pulls.get(tx.data.pullId);
  if (!pull) return undefined;
  const proposerIsPayer = scan.proposerIsLeft === !(pull.amount > 0n);
  const locallyExpired = isPullRevealExpired(
    pull.revealedUntilTimestamp,
    scan.context.entityTimestamp,
  );
  if (proposerIsPayer && !locallyExpired) {
    return deadlineViolation(
      `PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: pull=${tx.data.pullId} localTimestamp=${scan.context.entityTimestamp}`,
    );
  }
  if (!proposerIsPayer || locallyExpired) scan.pulls.delete(tx.data.pullId);
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
  if (typeof frame.byLeft !== 'boolean') {
    return deadlineViolation('ACCOUNT_FRAME_PROPOSER_SIDE_MISSING');
  }
  const scan: DeadlineScan = {
    locks: cloneLocks(account),
    pulls: clonePulls(account),
    proposerIsLeft: frame.byLeft,
    frame,
    context,
  };
  for (const tx of frame.accountTxs) {
    const htlcViolation = inspectHtlcDeadline(scan, tx);
    if (htlcViolation) return htlcViolation;
    const pullViolation = inspectPullDeadline(scan, tx);
    if (pullViolation) return pullViolation;
  }
  return undefined;
}
