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

import { AccountMachine, AccountTx, HtlcLock, Delta } from '../../types';
import { deriveDelta, getDefaultCreditLimit } from '../../account-utils';
import { HTLC } from '../../constants';

export async function handleHtlcLock(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'htlc_lock' }>,
  isOurFrame: boolean,
  currentTimestamp: number,
  currentHeight: number,
  isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string }> {
  console.log('🔒 handleHtlcLock CALLED');
  const { lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId, envelope } = accountTx.data;
  const events: string[] = [];

  // Initialize locks Map if not present (defensive - should be initialized at account creation)
  if (!accountMachine.locks) {
    console.log('⚠️ Initializing locks Map (should have been initialized at account creation)');
    accountMachine.locks = new Map();
  }

  // 1. Validate lockId uniqueness
  if (accountMachine.locks.has(lockId)) {
    return { success: false, error: `Lock ${lockId} already exists`, events };
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

  // 3. Validate amount > 0
  if (amount <= 0n) {
    return { success: false, error: `Invalid amount: ${amount}`, events };
  }

  // 4. Get or create delta
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    const defaultCreditLimit = getDefaultCreditLimit(tokenId);
    delta = {
      tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: defaultCreditLimit,
      rightCreditLimit: defaultCreditLimit,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHtlcHold: 0n,
      rightHtlcHold: 0n,
    };
    accountMachine.deltas.set(tokenId, delta);
  }

  // Initialize HTLC holds if not present
  if (delta.leftHtlcHold === undefined) delta.leftHtlcHold = 0n;
  if (delta.rightHtlcHold === undefined) delta.rightHtlcHold = 0n;

  // 5. Determine sender perspective (canonical direction)
  const leftEntity = accountMachine.proofHeader.fromEntity < accountMachine.proofHeader.toEntity
    ? accountMachine.proofHeader.fromEntity
    : accountMachine.proofHeader.toEntity;

  // CRITICAL: Lock is ALWAYS initiated by sender (who is creating the AccountTx)
  const senderIsLeft = isOurFrame
    ? (accountMachine.proofHeader.fromEntity === leftEntity)
    : (accountMachine.proofHeader.fromEntity !== leftEntity);

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
    envelope
  };

  // 8. Update capacity hold (prevents double-spend)
  // CRITICAL CONSENSUS FIX: Apply holds during BOTH validation and commit
  // Holds must be in frame hash to prevent same-frame over-commit attacks
  if (senderIsLeft) {
    delta.leftHtlcHold += amount;
    if (!isValidation) console.log(`✅ Updated leftHtlcHold: ${delta.leftHtlcHold}`);
  } else {
    delta.rightHtlcHold += amount;
    if (!isValidation) console.log(`✅ Updated rightHtlcHold: ${delta.rightHtlcHold}`);
  }

  // 9. Add lock to locks Map
  // CRITICAL CONSENSUS FIX: Add during validation too (prevents duplicate lockId in same frame)
  // BUT only on commit persist to real accountMachine (validation uses temporary clone)
  if (!isValidation) {
    console.log(`🔒 COMMIT: Adding lock, lockId=${lockId.slice(0,16)}`);
    accountMachine.locks.set(lockId, lock);
    console.log(`✅ Lock added to Map: ${lockId.slice(0,16)}..., locks.size=${accountMachine.locks.size}`);
  } else {
    // Validation: Add to clone to check duplicates, but clone is discarded
    accountMachine.locks.set(lockId, lock);
    console.log(`⏭️ VALIDATION: Lock added to validation clone (dup check), size=${accountMachine.locks.size}`);
  }

  events.push(`🔒 HTLC locked: ${amount} token ${tokenId}, expires block ${revealBeforeHeight}, hash ${hashlock.slice(0,16)}...`);

  console.log(`✅ handleHtlcLock SUCCESS, returning events: ${events.length}`);
  return { success: true, events };
}
