import type { AccountState, Delta } from '../../types/account';
import { TOKENS } from '../../config/constants';
import { assertAccountDeltaCapacity, createDefaultDelta } from '../delta';

export function ensureDelta(account: AccountState, tokenId: number): Delta {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
    throw new Error(`ACCOUNT_DELTA_TOKEN_INVALID:${String(tokenId)}`);
  }
  let delta = account.deltas.get(tokenId);
  if (!delta) {
    assertAccountDeltaCapacity(account.deltas.size + 1, 'insert');
    delta = createDefaultDelta(tokenId);
    account.deltas.set(tokenId, delta);
  }
  return delta;
}
