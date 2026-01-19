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

import { AccountMachine, AccountTx } from '../../types';
import { hashHtlcSecret } from '../../htlc-utils';

export async function handleHtlcReveal(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_reveal' }>,
  isOurFrame: boolean,
  currentHeight: number,
  currentTimestamp: number
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

  console.log(`🔓 REVEAL: lockId=${lockId.slice(0,16)}..., locks.size=${accountMachine.locks.size}`);
  console.log(`🔓 REVEAL: Available lockIds: ${Array.from(accountMachine.locks.keys()).map(k => k.slice(0,16)).join(', ')}`);

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    console.log(`🔓 REVEAL FAIL: Lock ${lockId.slice(0,16)}... not found`);
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Verify not expired - BOTH conditions (height AND timestamp)
  // Must reveal BEFORE both deadlines for HTLC safety
  if (currentHeight > lock.revealBeforeHeight) {
    return {
      success: false,
      error: `Lock expired by height: current ${currentHeight} > deadline ${lock.revealBeforeHeight}`,
      events
    };
  }

  if (currentTimestamp > Number(lock.timelock)) {
    return {
      success: false,
      error: `Lock expired by time: current ${currentTimestamp} > deadline ${lock.timelock}`,
      events
    };
  }

  // 3. Verify secret hashes to hashlock (CRITICAL)
  let computedHash: string;
  try {
    computedHash = hashHtlcSecret(secret);
  } catch (error) {
    return {
      success: false,
      error: `Invalid secret: ${error instanceof Error ? error.message : String(error)}`,
      events
    };
  }
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

  // 5. Apply canonical delta (2024 pattern from DirectPayment:337)
  // If left sends → delta decreases (negative)
  // If right sends → delta increases (positive)
  const canonicalDelta = lock.senderIsLeft ? -lock.amount : lock.amount;
  console.log(`🔓 REVEAL-DELTA: senderIsLeft=${lock.senderIsLeft}, amount=${lock.amount}, canonicalDelta=${canonicalDelta}`);
  console.log(`🔓 REVEAL-DELTA: offdelta BEFORE=${delta.offdelta}`);
  delta.offdelta += canonicalDelta;
  console.log(`🔓 REVEAL-DELTA: offdelta AFTER=${delta.offdelta}`);

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
