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

import type { AccountMachine, AccountTx } from '../../../types';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { hashEncryptedHtlcLayer, htlcSecretOfferContextHash } from '../../../protocol/htlc/onion-advance';
import { validateMultiRecipientCiphertext } from '../../../protocol/htlc/multi-recipient';
import { createStructuredLogger, shortHash } from '../../../infra/logger';
import { releaseHold } from '../hold-utils';
import { isHtlcTimelockExpired } from '../../htlc-deadline';

const htlcResolveLog = createStructuredLogger('account.htlc');

export async function handleHtlcResolve(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_resolve' }>,
  byLeft: boolean,
  currentHeight: number,
  currentTimestamp: number,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  outcome?: 'offer' | 'secret' | 'error';
  secret?: string;
  offerHash?: string;
  hashlock?: string;
  reason?: string;
  finalRecipient?: boolean;
  amount?: bigint;
  tokenId?: number;
  description?: string;
}> {
  const { lockId, outcome } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. An opaque offer only records the proposer-encrypted preimage. It does
  // not release the hold or mutate balances. The payer must accept this exact
  // ciphertext in a later Account frame after its local proposer decrypts it.
  if (outcome === 'offer') {
    const beneficiaryIsLeft = !lock.senderIsLeft;
    if (byLeft !== beneficiaryIsLeft) {
      return { success: false, error: 'Only beneficiary can publish an HTLC secret offer', events };
    }
    let offer;
    try {
      const payerEntityId = lock.senderIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity;
      const beneficiaryEntityId = lock.senderIsLeft ? accountMachine.rightEntity : accountMachine.leftEntity;
      offer = validateMultiRecipientCiphertext(
        accountTx.data.offer,
        payerEntityId,
        htlcSecretOfferContextHash(payerEntityId, beneficiaryEntityId, lock),
      );
    } catch (error) {
      return {
        success: false,
        error: `Invalid HTLC secret offer: ${error instanceof Error ? error.message : String(error)}`,
        events,
      };
    }
    const nextHash = hashEncryptedHtlcLayer(offer);
    if (lock.secretOffer) {
      const currentHash = hashEncryptedHtlcLayer(lock.secretOffer);
      if (currentHash !== nextHash) {
        return { success: false, error: 'HTLC secret offer conflicts with committed offer', events };
      }
      return { success: true, events, outcome: 'offer', hashlock: lock.hashlock, offerHash: currentHash };
    }
    lock.secretOffer = offer;
    events.push(`🔐 HTLC secret offer committed for ${lock.lockId}`);
    return { success: true, events, outcome: 'offer', hashlock: lock.hashlock, offerHash: nextHash };
  }

  // 3. Get delta for terminal success/error mutation.
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  if (outcome === 'secret') {
    // Verify not expired
    if (currentHeight > 0 && currentHeight > lock.revealBeforeHeight) {
      return { success: false, error: `Lock expired by height: ${currentHeight} > ${lock.revealBeforeHeight}`, events };
    }
    if (isHtlcTimelockExpired(currentTimestamp, lock.timelock)) {
      return { success: false, error: `Lock expired by time: ${currentTimestamp} >= ${lock.timelock}`, events };
    }

    if ('offerHash' in accountTx.data) {
      const callerIsPayer = byLeft === lock.senderIsLeft;
      if (!callerIsPayer) {
        return { success: false, error: 'Only payer can accept an HTLC secret offer', events };
      }
      if (!lock.secretOffer) {
        return { success: false, error: 'Committed HTLC secret offer required', events };
      }
      const committedOfferHash = hashEncryptedHtlcLayer(lock.secretOffer);
      if (accountTx.data.offerHash.toLowerCase() !== committedOfferHash) {
        return { success: false, error: 'HTLC secret offer hash mismatch', events };
      }
    } else {
      const secret = accountTx.data.secret;
      if (lock.secretOffer) {
        return { success: false, error: 'Raw secret cannot bypass a committed HTLC secret offer', events };
      }
      let computedHash: string;
      try {
        computedHash = hashHtlcSecret(secret);
      } catch (e) {
        return { success: false, error: `Invalid secret: ${e instanceof Error ? e.message : String(e)}`, events };
      }
      if (computedHash !== lock.hashlock) {
        return { success: false, error: `Hash mismatch: expected ${lock.hashlock.slice(0,8)}..., got ${computedHash.slice(0,8)}...`, events };
      }
    }

  } else {
    // === ERROR PATH: Release hold without paying the beneficiary ===
    //
    // Safety rule:
    // - Beneficiary may release an active HTLC when downstream failed.
    // - Payer may reclaim only after expiry.
    //
    // Without the side check, the payer could submit outcome=error with an
    // arbitrary reason before expiry and cancel an active conditional payment.
    const beneficiaryIsLeft = !lock.senderIsLeft;
    const callerIsBeneficiary = byLeft === beneficiaryIsLeft;
    const callerIsPayer = byLeft === lock.senderIsLeft;
    const heightExpired = currentHeight > 0 && currentHeight > lock.revealBeforeHeight;
    const timestampExpired = isHtlcTimelockExpired(currentTimestamp, lock.timelock);
    const expired = heightExpired || timestampExpired;
    if (!callerIsBeneficiary && !(callerIsPayer && expired)) {
      return {
        success: false,
        error: `Only beneficiary can release an active HTLC; payer can cancel only after expiry`,
        events,
      };
    }

    // For timeout-type errors, verify expiry regardless of caller side. A
    // beneficiary-initiated active release must use a non-timeout reason.
    const reason = accountTx.data.reason;
    if (reason === 'timeout') {
      if (!expired) {
        return { success: false, error: `Lock not expired yet`, events };
      }
    }

  }

  // 3. Release hold (common to both paths)
  const releaseSide = lock.senderIsLeft ? 'left' : 'right';
  const releaseError = releaseHold(
    delta,
    releaseSide,
    lock.amount,
    (currentHold, releaseAmount) =>
      `HTLC_RESOLVE_HOLD_UNDERFLOW:${releaseSide} hold=${currentHold.toString()} amount=${releaseAmount.toString()}`,
  );
  if (releaseError) return { success: false, error: releaseError, events };

  // 4. Apply outcome mutation after the hold guard. Failed resolves must be
  // no-ops on account balances and locks.
  if (outcome === 'secret') {
    const canonicalDelta = lock.senderIsLeft ? -lock.amount : lock.amount;
    delta.offdelta += canonicalDelta;
    events.push(`🔓 HTLC resolved (secret): ${lock.amount} token ${lock.tokenId}`);
  } else {
    const reason = accountTx.data.reason;
    htlcResolveLog.debug('resolve.error_outcome', { lock: shortHash(lockId), reason: reason || 'unknown' });
    events.push(`❌ HTLC resolved (error): ${lock.amount} token ${lock.tokenId} returned — ${reason || 'unknown'}`);
  }

  // 5. Remove lock
  accountMachine.locks.delete(lockId);

  const finalRecipient = typeof lock.envelope === 'object'
    && lock.envelope !== null
    && 'finalRecipient' in lock.envelope
    && (lock.envelope as { finalRecipient?: unknown }).finalRecipient === true;
  const resolvedDescription =
    typeof lock.envelope === 'object'
    && lock.envelope !== null
    && 'description' in lock.envelope
    && typeof (lock.envelope as { description?: unknown }).description === 'string'
      ? (lock.envelope as { description: string }).description
      : undefined;

  const result: {
    success: boolean; events: string[]; error?: string;
    outcome?: 'offer' | 'secret' | 'error'; secret?: string; offerHash?: string;
    hashlock?: string; reason?: string;
    finalRecipient?: boolean; amount?: bigint; tokenId?: number; description?: string;
  } = { success: true, events, outcome, hashlock: lock.hashlock };
  if (outcome === 'secret' && 'secret' in accountTx.data) result.secret = accountTx.data.secret;
  if (outcome === 'secret' && 'offerHash' in accountTx.data) result.offerHash = accountTx.data.offerHash;
  if (outcome === 'error') result.reason = accountTx.data.reason || 'unknown';
  if (outcome === 'secret') {
    result.finalRecipient = finalRecipient;
    result.amount = lock.amount;
    result.tokenId = lock.tokenId;
    if (resolvedDescription) result.description = resolvedDescription;
  }
  return result;
}
