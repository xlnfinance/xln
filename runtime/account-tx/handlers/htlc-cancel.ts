/**
 * HTLC Cancel Handler
 * Cancels a lock immediately with error reason, releases hold, propagates backward
 *
 * Unlike htlc_timeout (waits for expiry), htlc_cancel is IMMEDIATE:
 * - No capacity at next hop → cancel
 * - No account with next hop → cancel
 * - Counter desync → cancel
 * - Any forwarding failure → cancel
 *
 * Pattern from 2019: DeleteLockNew with outcomeType (NoCapacity/invalid/fail)
 */

import type { AccountMachine, AccountTx } from '../../types';

export async function handleHtlcCancel(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_cancel' }>,
): Promise<{ success: boolean; events: string[]; error?: string; cancelledHashlock?: string; cancelReason?: string }> {
  const { lockId, reason } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Get delta to release hold
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  // 3. Release hold (NO delta change - funds return to sender)
  if (lock.senderIsLeft) {
    const currentHold = delta.leftHtlcHold || 0n;
    delta.leftHtlcHold = currentHold < lock.amount ? 0n : currentHold - lock.amount;
  } else {
    const currentHold = delta.rightHtlcHold || 0n;
    delta.rightHtlcHold = currentHold < lock.amount ? 0n : currentHold - lock.amount;
  }

  // 4. Remove lock
  accountMachine.locks.delete(lockId);

  console.log(`❌ HTLC-CANCEL: lockId=${lockId.slice(0,16)}..., reason=${reason}, amount=${lock.amount}`);
  events.push(`❌ HTLC cancelled: ${lock.amount} token ${lock.tokenId} returned (${reason})`);

  return {
    success: true,
    events,
    cancelledHashlock: lock.hashlock,
    cancelReason: reason,
  };
}
