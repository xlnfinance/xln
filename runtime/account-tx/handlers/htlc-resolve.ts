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

import type { AccountMachine, AccountTx } from '../../types';
import { hashHtlcSecret } from '../../htlc-utils';

export async function handleHtlcResolve(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_resolve' }>,
  currentHeight: number,
  currentTimestamp: number,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  outcome?: 'secret' | 'error';
  secret?: string;
  hashlock?: string;
  reason?: string;
  finalRecipient?: boolean;
  amount?: bigint;
  tokenId?: number;
  description?: string;
}> {
  const { lockId, outcome, secret, reason } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Get delta
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  if (outcome === 'secret') {
    // === SUCCESS PATH: Verify preimage, apply delta ===

    if (!secret) {
      return { success: false, error: 'Secret required for outcome=secret', events };
    }

    // Verify not expired
    if (currentHeight > 0 && currentHeight > lock.revealBeforeHeight) {
      return { success: false, error: `Lock expired by height: ${currentHeight} > ${lock.revealBeforeHeight}`, events };
    }
    if (currentTimestamp > Number(lock.timelock)) {
      return { success: false, error: `Lock expired by time: ${currentTimestamp} > ${lock.timelock}`, events };
    }

    // Verify preimage
    let computedHash: string;
    try {
      computedHash = hashHtlcSecret(secret);
    } catch (e) {
      return { success: false, error: `Invalid secret: ${e instanceof Error ? e.message : String(e)}`, events };
    }
    if (computedHash !== lock.hashlock) {
      return { success: false, error: `Hash mismatch: expected ${lock.hashlock.slice(0,8)}..., got ${computedHash.slice(0,8)}...`, events };
    }

    // Apply delta (left sends → decrease, right sends → increase)
    const canonicalDelta = lock.senderIsLeft ? -lock.amount : lock.amount;
    delta.offdelta += canonicalDelta;

    events.push(`🔓 HTLC resolved (secret): ${lock.amount} token ${lock.tokenId}`);
  } else {
    // === ERROR PATH: Just release hold ===

    // For timeout-type errors, verify expiry
    if (reason === 'timeout') {
      const heightExpired = currentHeight > 0 && currentHeight > lock.revealBeforeHeight;
      const timestampExpired = currentTimestamp > Number(lock.timelock);
      if (!heightExpired && !timestampExpired) {
        return { success: false, error: `Lock not expired yet`, events };
      }
    }

    console.log(`❌ HTLC-RESOLVE error: lockId=${lockId.slice(0,16)}..., reason=${reason || 'unknown'}`);
    events.push(`❌ HTLC resolved (error): ${lock.amount} token ${lock.tokenId} returned — ${reason || 'unknown'}`);
  }

  // 3. Release hold (common to both paths)
  if (lock.senderIsLeft) {
    const currentHold = delta.leftHold || 0n;
    delta.leftHold = currentHold < lock.amount ? 0n : currentHold - lock.amount;
  } else {
    const currentHold = delta.rightHold || 0n;
    delta.rightHold = currentHold < lock.amount ? 0n : currentHold - lock.amount;
  }

  // 4. Remove lock
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
    outcome?: 'secret' | 'error'; secret?: string; hashlock?: string; reason?: string;
    finalRecipient?: boolean; amount?: bigint; tokenId?: number; description?: string;
  } = { success: true, events, outcome, hashlock: lock.hashlock };
  if (outcome === 'secret' && secret) result.secret = secret;
  if (outcome === 'error') result.reason = reason || 'unknown';
  if (outcome === 'secret') {
    result.finalRecipient = finalRecipient;
    result.amount = lock.amount;
    result.tokenId = lock.tokenId;
    if (resolvedDescription) result.description = resolvedDescription;
  }
  return result;
}
