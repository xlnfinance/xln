import type { AccountState, Delta } from '../../types';
import { createDefaultDelta } from '../../validation-utils';

export function ensureDelta(account: AccountState, tokenId: number): Delta {
  let delta = account.deltas.get(tokenId);
  if (!delta) {
    delta = createDefaultDelta(tokenId);
    account.deltas.set(tokenId, delta);
  }
  return delta;
}
