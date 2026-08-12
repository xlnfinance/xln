import type { AccountState, Delta } from '../../types/account';
import { TOKENS } from '../../config/constants';
import {
  ACCOUNT_DELTA_ERROR_CODES,
  AccountDeltaError,
  assertAccountDeltaCapacity,
  createDefaultDelta,
} from '../state/delta';

export function ensureDelta(account: AccountState, tokenId: number): Delta {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
    throw new AccountDeltaError(
      ACCOUNT_DELTA_ERROR_CODES.tokenInvalid,
      String(tokenId),
    );
  }
  let delta = account.deltas.get(tokenId);
  if (!delta) {
    assertAccountDeltaCapacity(account.deltas.size + 1, 'insert');
    delta = createDefaultDelta(tokenId);
    account.deltas.set(tokenId, delta);
  }
  return delta;
}
