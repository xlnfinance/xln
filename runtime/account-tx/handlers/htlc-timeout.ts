/**
 * HTLC Timeout Handler
 * Expires lock after revealBeforeHeight deadline, returns funds to sender
 *
 * Reference:
 * - 2024 CancelPayment.apply() (Transition.ts:146-163)
 *
 * Note: NO delta change - funds stay with sender (hold just releases)
 */

import { AccountMachine, AccountTx } from '../../types';

export async function handleHtlcTimeout(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_timeout' }>,
  isOurFrame: boolean,
  currentHeight: number
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { lockId } = accountTx.data;
  const events: string[] = [];

  // 1. Find lock
  const lock = accountMachine.locks.get(lockId);
  if (!lock) {
    return { success: false, error: `Lock ${lockId} not found`, events };
  }

  // 2. Verify deadline passed (enforced at J-block height)
  if (currentHeight <= lock.revealBeforeHeight) {
    const remaining = lock.revealBeforeHeight - currentHeight;
    return {
      success: false,
      error: `Lock not expired: ${remaining} blocks remaining (current ${currentHeight}, deadline ${lock.revealBeforeHeight})`,
      events
    };
  }

  // 3. Get delta to release hold
  const delta = accountMachine.deltas.get(lock.tokenId);
  if (!delta) {
    return { success: false, error: `Delta ${lock.tokenId} not found`, events };
  }

  // 4. Release hold (NO delta change - funds return to sender)
  if (lock.senderIsLeft) {
    delta.leftHtlcHold = (delta.leftHtlcHold || 0n) - lock.amount;
  } else {
    delta.rightHtlcHold = (delta.rightHtlcHold || 0n) - lock.amount;
  }

  // 5. Remove lock
  accountMachine.locks.delete(lockId);

  events.push(`⏰ HTLC timeout: ${lock.amount} token ${lock.tokenId} returned to sender (lock ${lockId.slice(0,8)}...)`);

  return { success: true, events };
}
