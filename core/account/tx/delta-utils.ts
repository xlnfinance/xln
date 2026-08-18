import type { Delta } from '../../types/account';
import type { AccountDraftState } from '../state/account-state-draft';
import { TOKENS } from '../../config/constants';
import {
  ACCOUNT_DELTA_ERROR_CODES,
  AccountDeltaError,
  assertAccountDeltaCapacity,
  createDefaultDelta,
} from '../state/delta';

/** Own one mutable leaf copy; caller must publish it with `commitDeltaDraft`. */
export function createDeltaDraft(account: AccountDraftState, tokenId: number): Delta {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
    throw new AccountDeltaError(
      ACCOUNT_DELTA_ERROR_CODES.tokenInvalid,
      String(tokenId),
    );
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
