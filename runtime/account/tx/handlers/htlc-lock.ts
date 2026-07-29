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

import type { AccountReplica, AccountTx, HtlcLock } from '../../../types';
import { deriveDelta } from '../../utils';
import { FINANCIAL, LIMITS } from '../../../config/constants';
import { ensureDelta } from '../delta-utils';
import { addHold } from '../hold-utils';
import { isHtlcTimelockExpired } from '../../htlc-deadline';
import { encryptedHtlcLayer, hashEncryptedHtlcLayer } from '../../../protocol/htlc/onion-advance';

type HtlcLockTx = Extract<AccountTx, { type: 'htlc_lock' }>;

const validateHtlcLock = (
  account: AccountReplica,
  tx: HtlcLockTx,
  currentTimestamp: number,
  currentHeight: number,
): string | undefined => {
  const { lockId, timelock, revealBeforeHeight, amount } = tx.data;
  if (account.locks.has(lockId)) return `Lock ${lockId} already exists`;
  if (account.locks.size >= LIMITS.MAX_ACCOUNT_HTLC_LOCKS) {
    return `Too many active HTLC locks: max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`;
  }
  if (isHtlcTimelockExpired(currentTimestamp, timelock)) {
    return `Timelock ${timelock} already expired (timestamp)`;
  }
  if (revealBeforeHeight <= currentHeight) {
    return `revealBeforeHeight ${revealBeforeHeight} already passed (current height: ${currentHeight})`;
  }
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return `Invalid amount: ${amount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`;
  }
  return undefined;
};

export async function handleHtlcLock(
  account: AccountReplica,
  accountTx: HtlcLockTx,
  byLeft: boolean,
  currentTimestamp: number,
  currentHeight: number,
  _isValidation: boolean = false
): Promise<{ success: boolean; events: string[]; error?: string }> {
  const { lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId } = accountTx.data;
  const events: string[] = [];

  // Initialize locks Map if not present (defensive - should be initialized at account creation)
  if (!account.locks) {
    account.locks = new Map();
  }

  const validationError = validateHtlcLock(account, accountTx, currentTimestamp, currentHeight);
  if (validationError) return { success: false, error: validationError, events };

  const delta = ensureDelta(account, tokenId);

  // 5. Determine sender perspective (Channel.ts: byLeft = frame proposer = sender)
  const senderIsLeft = byLeft;

  // Account state retains only a compact commitment. The signed AccountTx is
  // the authority for the full encrypted onion during post-commit processing.
  const encryptedLayer = accountTx.data.envelope === undefined
    ? null
    : encryptedHtlcLayer(accountTx.data.envelope);
  if (accountTx.data.envelope !== undefined && !encryptedLayer) {
    return { success: false, error: 'HTLC lock envelope must be encrypted', events };
  }

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
    createdHeight: account.currentHeight,
    createdTimestamp: currentTimestamp,
    ...(encryptedLayer ? { envelopeHash: hashEncryptedHtlcLayer(encryptedLayer) } : {}),
  };

  // 8. Update capacity hold (prevents double-spend)
  // CRITICAL CONSENSUS FIX: Apply holds during BOTH validation and commit
  // Holds must be in frame hash to prevent same-frame over-commit attacks
  const holdError = addHold(delta, senderIsLeft ? 'left' : 'right', amount);
  if (holdError) return { success: false, error: holdError, events };

  // 9. Add lock to locks Map
  // CRITICAL CONSENSUS FIX: Add during validation too (prevents duplicate lockId in same frame)
  // Validation runs on an isolated clone; commit runs on the real machine.
  account.locks.set(lockId, lock);

  events.push(`🔒 HTLC locked: ${amount} token ${tokenId}, expires block ${revealBeforeHeight}, hash ${hashlock.slice(0,16)}...`);

  return { success: true, events };
}
