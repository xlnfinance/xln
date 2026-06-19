/**
 * HTLC Lock Handler
 * Creates conditional payment, holds capacity until reveal/timeout
 *
 * Reference:
 * - 2024 AddPayment.apply() (Transition.ts:45-78)
 * - 2024 processAddPayment() (User.ts:641-724)
 *
 * Security:
 * - Validates capacity INCLUDING existing holds (prevents double-spend)
 * - Enforces revealBeforeHeight for griefing protection
 */

import type { AccountMachine, AccountTx, HtlcLock } from '../../types';
import { deriveDelta } from '../../account-utils';
import { FINANCIAL, LIMITS } from '../../constants';
import { ensureDelta } from '../delta-utils';
import { addHold } from '../hold-utils';

export async function handleHtlcLock(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_lock' }>,
  byLeft: boolean,
  currentTimestamp: number,
  currentHeight: number,
  _isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId, envelope } = accountTx.data;
  const events: string[] = [];

  // Initialize locks Map if not present (defensive - should be initialized at account creation)
  if (!accountMachine.locks) {
    accountMachine.locks = new Map();
  }

  // 1. Validate lockId uniqueness
  if (accountMachine.locks.has(lockId)) {
    return { success: false, error: `Lock ${lockId} already exists`, events };
  }
  if (accountMachine.locks.size >= LIMITS.MAX_ACCOUNT_HTLC_LOCKS) {
    return {
      success: false,
      error: `Too many active HTLC locks: max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`,
      events,
    };
  }

  // 2. Validate expiry is in future - BOTH timelock AND revealBeforeHeight
  if (timelock <= BigInt(currentTimestamp)) {
    return { success: false, error: `Timelock ${timelock} already expired (timestamp)`, events };
  }

  if (revealBeforeHeight <= currentHeight) {
    return {
      success: false,
      error: `revealBeforeHeight ${revealBeforeHeight} already passed (current height: ${currentHeight})`,
      events
    };
  }

  // 3. Validate amount bounds (network-wide payment limits)
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return {
      success: false,
      error: `Invalid amount: ${amount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
      events,
    };
  }

  const delta = ensureDelta(accountMachine, tokenId);

  // 5. Determine sender perspective (Channel.ts: byLeft = frame proposer = sender)
  const senderIsLeft = byLeft;

  // 6. Check available capacity (deriveDelta auto-deducts HTLC holds now)
  const derived = deriveDelta(delta, senderIsLeft);

  if (amount > derived.outCapacity) {
    return {
      success: false,
      error: `Insufficient capacity: need ${amount}, available ${derived.outCapacity}`,
      events,
    };
  }

  // 7. Create lock
  const lock: HtlcLock = {
    lockId,
    hashlock,
    timelock,
    revealBeforeHeight,
    amount,
    tokenId,
    senderIsLeft,
    createdHeight: accountMachine.currentHeight,
    createdTimestamp: currentTimestamp,
    ...(envelope !== undefined && { envelope }),
  };

  // 8. Update capacity hold (prevents double-spend)
  // CRITICAL CONSENSUS FIX: Apply holds during BOTH validation and commit
  // Holds must be in frame hash to prevent same-frame over-commit attacks
  const holdError = addHold(delta, senderIsLeft ? 'left' : 'right', amount);
  if (holdError) return { success: false, error: holdError, events };

  // 9. Add lock to locks Map
  // CRITICAL CONSENSUS FIX: Add during validation too (prevents duplicate lockId in same frame)
  // Validation runs on a temporary clone; commit runs on the real machine.
  accountMachine.locks.set(lockId, lock);

  events.push(`🔒 HTLC locked: ${amount} token ${tokenId}, expires block ${revealBeforeHeight}, hash ${hashlock.slice(0,16)}...`);

  return { success: true, events };
}
