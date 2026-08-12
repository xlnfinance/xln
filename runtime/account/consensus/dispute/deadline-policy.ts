import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import type { AccountFrame, AccountState, HtlcLock } from '../../../types/account';
import type { HankoString } from '../../../types/hanko';
import { isHtlcDeadlineExpired, isHtlcTimelockExpired } from '../../htlc-deadline';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from '../constants';

export const HTLC_ENFORCEMENT_RESERVE_MS = ACCOUNT_NETWORK_ALLOWANCE_MS;

export type AccountInputSecurityContext = {
  entityTimestamp: number;
  finalizedJHeight: number;
  owningEntityIsHub: boolean;
  /** Counterparty board from the consuming Entity's own finalized registry. */
  counterpartyCertifiedBoardHash?: string;
  /** Parent-provided Hanko authority; Account never reads Runtime/Entity state. */
  verifyHanko(
    hanko: HankoString,
    hash: string,
    expectedEntityId: string,
    authority?: { registeredBoardHash?: string; allowPreviousBoard?: boolean },
  ): Promise<{ valid: boolean; entityId: string | null }>;
};

export type IncomingDeadlineViolation = {
  reason: string;
  disposition: 'reject' | 'dispute';
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

const rejectedDeadline = (reason: string): IncomingDeadlineViolation => ({
  reason,
  disposition: 'reject',
  evidenceSecrets: [],
});

const frameClockExpired = (lock: Pick<HtlcLock, 'timelock' | 'revealBeforeHeight'>, frame: AccountFrame): boolean =>
  isHtlcDeadlineExpired(lock, { timestamp: frame.timestamp, jHeight: frame.jHeight });

// Deadline admission is speculative: a rejected frame must leave the live
// Account byte-identical. A Map clone alone still aliases HtlcLock values.
const cloneLocks = (account: AccountState): Map<string, HtlcLock> => new Map(
  Array.from(account.locks, ([lockId, lock]) => [lockId, { ...lock }]),
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
    const localTimestampUnsafe =
      tx.data.timelock <= BigInt(scan.context.entityTimestamp + HTLC_ENFORCEMENT_RESERVE_MS);
    const localHeightUnsafe = tx.data.revealBeforeHeight <= scan.context.finalizedJHeight;
    const frameTimestampUnsafe = isHtlcTimelockExpired(scan.frame.timestamp, tx.data.timelock);
    const frameHeightUnsafe = tx.data.revealBeforeHeight <= scan.frame.jHeight;
    if (localTimestampUnsafe || localHeightUnsafe || frameTimestampUnsafe || frameHeightUnsafe) {
      return rejectedDeadline(
        `HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} `
        + `localTimestamp=${scan.context.entityTimestamp} localJHeight=${scan.context.finalizedJHeight} `
        + `frameTimestamp=${scan.frame.timestamp} frameJHeight=${scan.frame.jHeight}`,
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
  if (tx.data.outcome === 'secret') {
    const rawSecret = tx.data.secret;
    const verifiedSecret = validHtlcSecret(lock, rawSecret);
    if (verifiedSecret && isHtlcSecretEnforcementWindowClosed(lock, scan.context)) {
      return {
        reason: `HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: lock=${tx.data.lockId} reserve=${HTLC_ENFORCEMENT_RESERVE_MS}ms localTimestamp=${scan.context.entityTimestamp}`,
        disposition: 'dispute',
        evidenceSecrets: rawSecret ? [{ hashlock: lock.hashlock, secret: rawSecret }] : [],
      };
    }
    if (verifiedSecret && frameClockExpired(lock, scan.frame)) {
      return rejectedDeadline(
        `HTLC_SECRET_FRAME_CLOCK_EXPIRED: lock=${tx.data.lockId} `
        + `frameTimestamp=${scan.frame.timestamp} frameJHeight=${scan.frame.jHeight}`,
      );
    }
    if (verifiedSecret) scan.locks.delete(tx.data.lockId);
    return undefined;
  }

  const proposerIsPayer = scan.proposerIsLeft === lock.senderIsLeft;
  const locallyExpired = isHtlcDeadlineExpired(lock, {
    timestamp: scan.context.entityTimestamp,
    jHeight: scan.context.finalizedJHeight,
  });
  if (proposerIsPayer && !locallyExpired) {
    return rejectedDeadline(
      `HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: lock=${tx.data.lockId} localTimestamp=${scan.context.entityTimestamp} localJHeight=${scan.context.finalizedJHeight}`,
    );
  }
  const expiredInSignedFrame = frameClockExpired(lock, scan.frame);
  if ((proposerIsPayer || tx.data.reason === 'timeout') && !expiredInSignedFrame) {
    return rejectedDeadline(
      `HTLC_TIMEOUT_FRAME_CLOCK_NOT_EXPIRED: lock=${tx.data.lockId} `
      + `frameTimestamp=${scan.frame.timestamp} frameJHeight=${scan.frame.jHeight}`,
    );
  }
  const beneficiaryRelease = !proposerIsPayer && tx.data.reason !== 'timeout';
  if (locallyExpired || beneficiaryRelease) scan.locks.delete(tx.data.lockId);
  return undefined;
};

/**
 * Peer frame time/J-height is consensus data, not a trusted local clock.
 * This pure admission guard prevents stale/future frames from creating an
 * unenforceable obligation or exercising a payer timeout prematurely.
 *
 * Cross-j pulls have no sealed wall-clock reveal deadline: settlement is
 * dispute-relative seconds on L1. Payment HTLC timelocks still enforce here.
 */
export function getIncomingAccountDeadlineViolation(
  account: AccountState,
  frame: AccountFrame,
  context: AccountInputSecurityContext,
): IncomingDeadlineViolation | undefined {
  if (typeof frame.byLeft !== 'boolean') {
    return rejectedDeadline('ACCOUNT_FRAME_PROPOSER_SIDE_MISSING');
  }
  const scan: DeadlineScan = {
    locks: cloneLocks(account),
    proposerIsLeft: frame.byLeft,
    frame,
    context,
  };
  for (const tx of frame.accountTxs) {
    const htlcViolation = inspectHtlcDeadline(scan, tx);
    if (htlcViolation) return htlcViolation;
  }
  return undefined;
}
