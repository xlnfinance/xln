import type { AccountState, Delta } from '../../types/account';
import { createDefaultDelta } from '../delta';

export function ensureDelta(account: AccountState, tokenId: number): Delta {
  let delta = account.deltas.get(tokenId);
  if (!delta) {
    delta = createDefaultDelta(tokenId);
    account.deltas.set(tokenId, delta);
  }
  return delta;
}
