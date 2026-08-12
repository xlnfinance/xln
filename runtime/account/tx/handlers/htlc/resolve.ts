/**
 * Unified HTLC Resolve Handler
 * Resolves a lock with either preimage (success) or error reason (failure)
 *
 * outcome='secret': Payment succeeded — verify preimage, apply delta, release hold
 * outcome='error':  Payment failed — release hold, propagate reason backward
 *
 * Replaces: htlc_reveal, htlc_timeout, htlc_cancel
 * Pattern: 2019 DeleteLockNew with outcomeType (secret/NoCapacity/invalid/fail)
 */

import type { AccountState, AccountTx, Delta, HtlcLock } from '../../../../types/account';
import { hashHtlcSecret } from '../../../../protocol/htlc/utils';
import { createStructuredLogger, shortHash } from '../../../../infra/logger';
import { releaseHold } from '../../hold-utils';
import { isHtlcDeadlineExpired } from '../../../htlc-deadline';
import { deriveTransferOffdeltaChange } from '../../../../protocol/transform/delta-movement';
import type { ApplyAccountTxResult } from '../../apply-types';
import {
  accountTxHtlcError,
  accountTxHtlcSecret,
  accountTxValidationRejected,
} from '../../apply-result';

const htlcResolveLog = createStructuredLogger('account.htlc');

type HtlcResolveTx = Extract<AccountTx, { type: 'htlc_resolve' }>;

function getHtlcSecretResolveError(
  lock: HtlcLock,
  data: Extract<HtlcResolveTx['data'], { outcome: 'secret' }>,
  currentJHeight: number,
  currentTimestamp: number,
): string | undefined {
  if (isHtlcDeadlineExpired(lock, { timestamp: currentTimestamp, jHeight: currentJHeight })) {
    return `Lock expired: timestamp=${currentTimestamp}/${lock.timelock} `
      + `jHeight=${currentJHeight}/${lock.revealBeforeHeight}`;
  }
  let computedHash: string;
  try {
    computedHash = hashHtlcSecret(data.secret);
  } catch (error) {
    return `Invalid secret: ${error instanceof Error ? error.message : String(error)}`;
  }
  return computedHash === lock.hashlock
    ? undefined
    : `Hash mismatch: expected ${lock.hashlock.slice(0, 8)}..., ` +
      `got ${computedHash.slice(0, 8)}...`;
}

function getHtlcErrorResolveError(
  lock: HtlcLock,
  data: Extract<HtlcResolveTx['data'], { outcome: 'error' }>,
  byLeft: boolean,
  currentJHeight: number,
  currentTimestamp: number,
): string | undefined {
  const callerIsBeneficiary = byLeft !== lock.senderIsLeft;
  const callerIsPayer = byLeft === lock.senderIsLeft;
  const expired = isHtlcDeadlineExpired(lock, {
    timestamp: currentTimestamp,
    jHeight: currentJHeight,
  });
  // Before expiry only the beneficiary may cancel. Letting the payer submit an
  // arbitrary error would make the conditional payment revocable on demand.
  if (!callerIsBeneficiary && !(callerIsPayer && expired)) {
    return 'Only beneficiary can release an active HTLC; payer can cancel only after expiry';
  }
  if (data.reason === 'timeout' && !expired) return 'Lock not expired yet';
  return undefined;
}

function applyHtlcResolution(
  account: AccountState,
  lock: HtlcLock,
  delta: Delta,
  data: HtlcResolveTx['data'],
  events: string[],
): ApplyAccountTxResult {
  const releaseSide = lock.senderIsLeft ? 'left' : 'right';
  const releaseError = releaseHold(
    delta,
    releaseSide,
    lock.amount,
    (hold, amount) =>
      `HTLC_RESOLVE_HOLD_UNDERFLOW:${releaseSide} ` +
      `hold=${hold.toString()} amount=${amount.toString()}`,
  );
  if (releaseError) return accountTxValidationRejected(releaseError, events);

  if (data.outcome === 'secret') {
    delta.offdelta += deriveTransferOffdeltaChange(lock.senderIsLeft, lock.amount);
    events.push(`🔓 HTLC resolved (secret): ${lock.amount} token ${lock.tokenId}`);
  } else {
    const reason = data.reason || 'unknown';
    htlcResolveLog.debug('resolve.error_outcome', {
      lock: shortHash(lock.lockId),
      reason,
    });
    events.push(
      `❌ HTLC resolved (error): ${lock.amount} token ${lock.tokenId} ` +
      `returned — ${reason}`,
    );
  }
  account.locks.delete(lock.lockId);
  if (data.outcome === 'secret' && 'secret' in data) {
    return accountTxHtlcSecret(events, data.secret, lock.hashlock, lock.amount, lock.tokenId);
  }
  return accountTxHtlcError(events, lock.hashlock);
}

export async function handleHtlcResolve(
  account: AccountState,
  accountTx: HtlcResolveTx,
  byLeft: boolean,
  currentJHeight: number,
  currentTimestamp: number,
): Promise<ApplyAccountTxResult> {
  const { lockId, outcome } = accountTx.data;
  const events: string[] = [];
  const lock = account.locks.get(lockId);
  if (!lock) return accountTxValidationRejected(`Lock ${lockId} not found`, events);
  const delta = account.deltas.get(lock.tokenId);
  if (!delta) return accountTxValidationRejected(`Delta ${lock.tokenId} not found`, events);
  const validationError = outcome === 'secret'
    ? getHtlcSecretResolveError(
        lock,
        accountTx.data,
        currentJHeight,
        currentTimestamp,
      )
    : getHtlcErrorResolveError(
        lock,
        accountTx.data,
        byLeft,
        currentJHeight,
        currentTimestamp,
      );
  if (validationError) return accountTxValidationRejected(validationError, events);
  return applyHtlcResolution(account, lock, delta, accountTx.data, events);
}
