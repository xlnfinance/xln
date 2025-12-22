/**
 * HTLC Reveal Handler
 * Verifies secret matches hashlock, commits delta, releases hold
 *
 * Reference:
 * - 2024 SettlePayment.apply() (Transition.ts:90-143)
 * - 2024 processSettlePayment() (User.ts:726-760)
 *
 * Returns:
 * - secret + hashlock for entity layer to propagate backward
 */

import { ethers } from 'ethers';
import { AccountMachine, AccountTx } from '../../types';

export async function handleHtlcReveal(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_reveal' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  secret?: string;     // For backward propagation
  hashlock?: string;   // To identify route
}> {
  console.log('🔓 handleHtlcReveal CALLED');
  const { lockId, secret } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Verify not expired (can't reveal after deadline)
  if (currentHeight > lock.revealBeforeHeight) {
    return {
      success: false,
      error: `Lock expired: current height ${currentHeight} > deadline ${lock.revealBeforeHeight}`,
      events
    };
  }

  // 3. Verify secret hashes to hashlock (CRITICAL)
  const computedHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
  if (computedHash !== lock.hashlock) {
    return {
      success: false,
      error: `Hash mismatch: expected ${lock.hashlock.slice(0,8)}..., got ${computedHash.slice(0,8)}...`,
      events
    };
  }

  // 4. Get delta
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  // 5. Apply canonical delta (2024 pattern from SettlePayment:127-128)
  // If left locked → right receives → delta increases (positive)
  // If right locked → left receives → delta decreases (negative)
  const canonicalDelta = lock.senderIsLeft ? lock.amount : -lock.amount;
  delta.offdelta += canonicalDelta;

  // 6. Release hold
  if (lock.senderIsLeft) {
    delta.leftHtlcHold = (delta.leftHtlcHold || 0n) - lock.amount;
  } else {
    delta.rightHtlcHold = (delta.rightHtlcHold || 0n) - lock.amount;
  }

  // 7. Remove lock
  accountMachine.locks.delete(lockId);

  events.push(`🔓 HTLC revealed: ${lock.amount} token ${lock.tokenId}, secret ${secret.slice(0,8)}...`);

  // 8. Return secret for routing layer (2024 pattern from processSettlePayment:738-749)
  return {
    success: true,
    events,
    secret,           // Entity layer will propagate backward
    hashlock: lock.hashlock
  };
}
