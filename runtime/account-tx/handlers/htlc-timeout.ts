/**
 * HTLC Timeout Handler
 * Expires lock after revealBeforeHeight deadline, returns funds to sender
 *
 * Reference:
 * - 2024 CancelPayment.apply() (Transition.ts:146-163)
 *
 * Note: NO delta change - funds stay with sender (hold just releases)
 */

import type { AccountMachine, AccountTx } from '../../types';

export async function handleHtlcTimeout(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_timeout' }>,
  isOurFrame: boolean,
  currentHeight: number,
  currentTimestamp: number
): Promise<{ success: boolean; events: string[]; error?: string; timedOutHashlock?: string }> {
  const { lockId } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Verify deadline passed - BOTH conditions (height OR timestamp)
  // Height: J-block deadline (on-chain enforcement)
  // Timestamp: Time-based deadline (deterministic entity clock)
  const heightExpired = currentHeight > 0 && currentHeight > lock.revealBeforeHeight;
  const timestampExpired = currentTimestamp > Number(lock.timelock);

  if (!heightExpired && !timestampExpired) {
    const blocksRemaining = lock.revealBeforeHeight - currentHeight;
    const timeRemaining = Number(lock.timelock) - currentTimestamp;
    return {
      success: false,
      error: `Lock not expired: ${blocksRemaining} blocks OR ${Math.floor(timeRemaining / 1000)}s remaining`,
      events
    };
  }

  // 3. Get delta to release hold
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  // 4. Release hold (NO delta change - funds return to sender, with underflow guard)
  if (lock.senderIsLeft) {
    const currentHold = delta.leftHtlcHold || 0n;
    if (currentHold < lock.amount) {
      console.error(`⚠️ HTLC timeout hold underflow! leftHtlcHold=${currentHold} < amount=${lock.amount}`);
      delta.leftHtlcHold = 0n;
    } else {
      delta.leftHtlcHold = currentHold - lock.amount;
    }
  } else {
    const currentHold = delta.rightHtlcHold || 0n;
    if (currentHold < lock.amount) {
      console.error(`⚠️ HTLC timeout hold underflow! rightHtlcHold=${currentHold} < amount=${lock.amount}`);
      delta.rightHtlcHold = 0n;
    } else {
      delta.rightHtlcHold = currentHold - lock.amount;
    }
  }

  // 5. Remove lock
  accountMachine.locks.delete(lockId);

  events.push(`⏰ HTLC timeout: ${lock.amount} token ${lock.tokenId} returned to sender (lock ${lockId.slice(0,8)}...)`);

  // 6. Return hashlock for entity-level cleanup (MEDIUM-7: htlcRoutes cleanup)
  return {
    success: true,
    events,
    timedOutHashlock: lock.hashlock // Signal to entity layer to clean up htlcRoutes
  };
}
