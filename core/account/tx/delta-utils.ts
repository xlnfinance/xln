import type { AccountState, Delta, HtlcLock } from '../../types/account';
import type { AccountDraftState } from '../state/account-state-draft';
import { TOKENS } from '../../config/constants';
import { INT512_MAX, INT512_MIN } from '../../protocol/boundary/integer-ranges';
import { deriveTransferOffdeltaChange } from '../../protocol/transform/delta-movement';
import {
  ACCOUNT_DELTA_ERROR_CODES,
  AccountDeltaError,
  assertAccountDeltaCapacity,
  createDefaultDelta,
} from '../state/delta';

/** Own one mutable leaf copy; caller must publish it with `commitDeltaDraft`. */
export function createDeltaDraft(account: AccountDraftState, tokenId: number): Delta {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
    throw new AccountDeltaError(ACCOUNT_DELTA_ERROR_CODES.tokenInvalid, String(tokenId), tokenId);
  }
  const existing = account.deltas.get(tokenId);
  if (!existing) {
    assertAccountDeltaCapacity(account.deltas.size + 1, 'insert');
    return createDefaultDelta(tokenId);
  }
  return { ...existing };
}

export const commitDeltaDraft = (account: AccountDraftState, delta: Delta): void => {
  account.deltas.put(delta.tokenId, delta);
};

type HtlcRangeChange =
  | Readonly<{ addedLock: Pick<HtlcLock, 'senderIsLeft' | 'amount'>; removedLockId?: never }>
  | Readonly<{ removedLockId: string; addedLock?: never }>;

/**
 * Each admitted HTLC may resolve independently. Its beneficiary can reveal
 * while every opposite-direction HTLC expires, so their movements never net.
 * General holds also reserve R2C deposits and cannot substitute for live locks.
 */
export const getOffdeltaRepresentationError = (
  account: Pick<AccountState, 'locks'>,
  delta: Pick<Delta, 'tokenId' | 'offdelta'>,
  change?: HtlcRangeChange,
): string | undefined => {
  let lower = delta.offdelta;
  let upper = delta.offdelta;
  const include = (lock: Pick<HtlcLock, 'senderIsLeft' | 'amount'>): void => {
    const movement = deriveTransferOffdeltaChange(lock.senderIsLeft, lock.amount);
    if (movement < 0n) lower += movement;
    else upper += movement;
  };
  for (const [lockId, lock] of account.locks) {
    if (lock.tokenId === delta.tokenId && lockId !== change?.removedLockId) include(lock);
  }
  if (change?.addedLock) include(change.addedLock);
  const outside = lower < INT512_MIN ? lower : upper > INT512_MAX ? upper : null;
  return outside === null ? undefined : `Offdelta outside int512: ${outside}`;
};
