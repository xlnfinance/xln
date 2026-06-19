import type { AccountMachine, Delta } from '../types';
import { createDefaultDelta } from '../validation-utils';

export function ensureDelta(accountMachine: AccountMachine, tokenId: number): Delta {
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    delta = createDefaultDelta(tokenId);
    accountMachine.deltas.set(tokenId, delta);
  }
  return delta;
}
