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
import { hashEncryptedHtlcLayer, htlcSecretOfferContextHash } from '../../../../protocol/htlc/codec/onion-layer';
import { validateMultiRecipientCiphertext } from '../../../../protocol/htlc/multi-recipient';
import { createStructuredLogger, shortHash } from '../../../../infra/logger';
import { releaseHold } from '../../hold-utils';
import { isHtlcTimelockExpired } from '../../../htlc-deadline';
import { deriveTransferOffdeltaChange } from '../../../../protocol/delta-movement';

const htlcResolveLog = createStructuredLogger('account.htlc');

type HtlcResolveTx = Extract<AccountTx, { type: 'htlc_resolve' }>;
type HtlcResolveResult = {
  success: boolean;
  events: string[];
  error?: string;
  outcome?: 'offer' | 'secret' | 'error';
  secret?: string;
  offerHash?: string;
  hashlock?: string;
  reason?: string;
  amount?: bigint;
  tokenId?: number;
  description?: string;
};

function handleHtlcSecretOffer(
  account: AccountState,
  lock: HtlcLock,
  data: Extract<HtlcResolveTx['data'], { outcome: 'offer' }>,
  byLeft: boolean,
  events: string[],
): HtlcResolveResult {
  if (byLeft === lock.senderIsLeft) {
    return {
      success: false,
      error: 'Only beneficiary can publish an HTLC secret offer',
      events,
    };
  }
  let offer;
  try {
    const payer = lock.senderIsLeft ? account.leftEntity : account.rightEntity;
    const beneficiary = lock.senderIsLeft ? account.rightEntity : account.leftEntity;
    offer = validateMultiRecipientCiphertext(
      data.offer,
      payer,
      htlcSecretOfferContextHash(payer, beneficiary, lock),
    );
  } catch (error) {
    return {
      success: false,
      error: `Invalid HTLC secret offer: ${
        error instanceof Error ? error.message : String(error)
      }`,
      events,
    };
  }
  const offerHash = hashEncryptedHtlcLayer(offer);
  if (lock.secretOffer) {
    const committedHash = hashEncryptedHtlcLayer(lock.secretOffer);
    if (committedHash !== offerHash) {
      return {
        success: false,
        error: 'HTLC secret offer conflicts with committed offer',
        events,
      };
    }
    return {
      success: true,
      events,
      outcome: 'offer',
      hashlock: lock.hashlock,
      offerHash: committedHash,
    };
  }
  lock.secretOffer = offer;
  events.push(`🔐 HTLC secret offer committed for ${lock.lockId}`);
  return { success: true, events, outcome: 'offer', hashlock: lock.hashlock, offerHash };
}

function getHtlcSecretResolveError(
  lock: HtlcLock,
  data: Extract<HtlcResolveTx['data'], { outcome: 'secret' }>,
  byLeft: boolean,
  currentJHeight: number,
  currentTimestamp: number,
): string | undefined {
  if (currentJHeight > 0 && currentJHeight > lock.revealBeforeHeight) {
    return `Lock expired by J height: ${currentJHeight} > ${lock.revealBeforeHeight}`;
  }
  if (isHtlcTimelockExpired(currentTimestamp, lock.timelock)) {
    return `Lock expired by time: ${currentTimestamp} >= ${lock.timelock}`;
  }
  if ('offerHash' in data) {
    if (byLeft !== lock.senderIsLeft) {
      return 'Only payer can accept an HTLC secret offer';
    }
    if (!lock.secretOffer) return 'Committed HTLC secret offer required';
    const committedHash = hashEncryptedHtlcLayer(lock.secretOffer);
    return data.offerHash.toLowerCase() === committedHash
      ? undefined
      : 'HTLC secret offer hash mismatch';
  }
  if (lock.secretOffer) {
    return 'Raw secret cannot bypass a committed HTLC secret offer';
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
  const expired =
    (currentJHeight > 0 && currentJHeight > lock.revealBeforeHeight) ||
    isHtlcTimelockExpired(currentTimestamp, lock.timelock);
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
  data: Exclude<HtlcResolveTx['data'], { outcome: 'offer' }>,
  events: string[],
): HtlcResolveResult {
  const releaseSide = lock.senderIsLeft ? 'left' : 'right';
  const releaseError = releaseHold(
    delta,
    releaseSide,
    lock.amount,
    (hold, amount) =>
      `HTLC_RESOLVE_HOLD_UNDERFLOW:${releaseSide} ` +
      `hold=${hold.toString()} amount=${amount.toString()}`,
  );
  if (releaseError) return { success: false, error: releaseError, events };

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
  return {
    success: true,
    events,
    outcome: data.outcome,
    hashlock: lock.hashlock,
    ...(data.outcome === 'secret' && 'secret' in data ? { secret: data.secret } : {}),
    ...(data.outcome === 'secret' && 'offerHash' in data
      ? { offerHash: data.offerHash }
      : {}),
    ...(data.outcome === 'secret' ? { amount: lock.amount, tokenId: lock.tokenId } : {}),
    ...(data.outcome === 'error' ? { reason: data.reason || 'unknown' } : {}),
  };
}

export async function handleHtlcResolve(
  account: AccountState,
  accountTx: HtlcResolveTx,
  byLeft: boolean,
  currentJHeight: number,
  currentTimestamp: number,
): Promise<HtlcResolveResult> {
  const { lockId, outcome } = accountTx.data;
  const events: string[] = [];
  const lock = account.locks.get(lockId);
  if (!lock) return { success: false, error: `Lock ${lockId} not found`, events };
  if (outcome === 'offer') {
    return handleHtlcSecretOffer(account, lock, accountTx.data, byLeft, events);
  }
  const delta = account.deltas.get(lock.tokenId);
  if (!delta) return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  const validationError = outcome === 'secret'
    ? getHtlcSecretResolveError(
        lock,
        accountTx.data,
        byLeft,
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
  if (validationError) return { success: false, error: validationError, events };
  return applyHtlcResolution(account, lock, delta, accountTx.data, events);
}
