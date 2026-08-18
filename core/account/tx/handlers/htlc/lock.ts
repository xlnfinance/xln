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

import type { AccountReplica, AccountTx, HtlcLock } from '../../../../types/account';
import type { AccountDraftReplica } from '../../../state/account-state-draft';
import { deriveDelta } from '../../../utils';
import { FINANCIAL, LIMITS } from '../../../../config/constants';
import { commitDeltaDraft, createDeltaDraft } from '../../delta-utils';
import { addHold } from '../../hold-utils';
import { isHtlcTimelockExpired } from '../../../htlc-deadline';
import { encryptedHtlcLayer, hashEncryptedHtlcLayer } from '../../../../protocol/htlc/codec/onion-layer';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxHtlcLockCapacityRejected, accountTxValidationRejected } from '../../apply-result';

type HtlcLockTx = Extract<AccountTx, { type: 'htlc_lock' }>;
type HtlcLockClock = Readonly<{
  committedTimestamp: number;
  enforcementTimestamp: number;
  enforcementJHeight: number;
}>;

const validateHtlcLock = (
  account: AccountReplica,
  tx: HtlcLockTx,
  currentTimestamp: number,
  currentJHeight: number,
): string | undefined => {
  const { lockId, timelock, revealBeforeHeight, amount } = tx.data;
  if (account.state.locks.has(lockId)) return `Lock ${lockId} already exists`;
  if (isHtlcTimelockExpired(currentTimestamp, timelock)) {
    return `Timelock ${timelock} already expired (timestamp)`;
  }
  if (revealBeforeHeight <= currentJHeight) {
    return `revealBeforeHeight ${revealBeforeHeight} already passed (current J height: ${currentJHeight})`;
  }
  if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return `Invalid amount: ${amount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`;
  }
  return undefined;
};

export async function handleHtlcLock(
  account: AccountDraftReplica,
  accountTx: HtlcLockTx,
  byLeft: boolean,
  clock: HtlcLockClock,
  _isValidation: boolean = false
): Promise<ApplyAccountTxResult> {
  const { lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId } = accountTx.data;
  const events: string[] = [];

  const validationError = validateHtlcLock(
    account,
    accountTx,
    clock.enforcementTimestamp,
    clock.enforcementJHeight,
  );
  if (validationError) return accountTxValidationRejected(validationError, events);
  if (account.state.locks.size >= LIMITS.MAX_ACCOUNT_HTLC_LOCKS) {
    // Not a bad lock: the account is full. Proposal keeps it queued and
    // retries once earlier locks resolve (a batched payer would otherwise lose
    // every payment past the 32nd).
    return accountTxHtlcLockCapacityRejected(
      `Too many active HTLC locks: max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`,
      events,
    );
  }

  const delta = createDeltaDraft(account.state, tokenId);

  // 5. Determine sender perspective (Channel.ts: byLeft = frame proposer = sender)
  const senderIsLeft = byLeft;

  // Account state retains only a compact commitment. The signed AccountTx is
  // the authority for the full encrypted onion during post-commit processing.
  const encryptedLayer = accountTx.data.envelope === undefined
    ? null
    : encryptedHtlcLayer(accountTx.data.envelope);
  if (accountTx.data.envelope !== undefined && !encryptedLayer) {
    return accountTxValidationRejected('HTLC lock envelope must be encrypted', events);
  }

  // 6. Check available capacity (deriveDelta auto-deducts HTLC holds now)
  const derived = deriveDelta(delta, senderIsLeft);

  if (amount > derived.outCapacity) {
    return accountTxValidationRejected(
      `Insufficient capacity: need ${amount}, available ${derived.outCapacity}`,
      events,
    );
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
    // Root metadata is signed-frame data. The parent Entity clock is only an
    // admission oracle; committing it here would make honest skew fork roots.
    createdTimestamp: clock.committedTimestamp,
    ...(encryptedLayer ? { envelopeHash: hashEncryptedHtlcLayer(encryptedLayer) } : {}),
  };

  // 8. Update capacity hold (prevents double-spend)
  // CRITICAL CONSENSUS FIX: Apply holds during BOTH validation and commit
  // Holds must be in frame hash to prevent same-frame over-commit attacks
  const holdError = addHold(delta, senderIsLeft ? 'left' : 'right', amount);
  if (holdError) return accountTxValidationRejected(holdError, events);

  // 9. Add lock to locks Map
  // CRITICAL CONSENSUS FIX: Add during validation too (prevents duplicate lockId in same frame)
  // Validation runs on an isolated clone; commit runs on the real machine.
  commitDeltaDraft(account.state, delta);
  account.state.locks.put(lockId, lock);

  events.push(`🔒 HTLC locked: ${amount} token ${tokenId}, expires block ${revealBeforeHeight}, hash ${hashlock.slice(0,16)}...`);

  return accountTxApplied(events);
}
