/**
 * Same-jurisdiction swap settlement pipeline.
 *
 * The Account reducer validates immutable maker terms first, applies both
 * token deltas and holds atomically on the Account candidate, then updates or
 * closes the remaining order. Cross-j offers use their separate ACK protocol.
 */

import type { AccountDraftReplica } from '../../../../state/account-state-draft';
import {
  validateSwapResolve,
} from './validation';
import {
  applySwapResolveFinancials,
} from './settlement';
import {
  applySwapResolveRemainder,
} from './remainder';
import type {
  SwapResolveResult,
  SwapResolveTx,
} from './types';
import {
  accountTxApplied,
  accountTxSwapCancelled,
} from '../../../apply-result';

export async function handleSwapResolve(
  account: AccountDraftReplica,
  tx: SwapResolveTx,
  byLeft: boolean,
  _currentHeight: number,
  _isValidation = false,
): Promise<SwapResolveResult> {
  const events: string[] = [];
  const validated = validateSwapResolve(account.state, tx, byLeft, events);
  if ('ok' in validated) return validated;
  const applied = applySwapResolveFinancials(account.state, validated, events);
  if ('ok' in applied) return applied;
  const remainder = applySwapResolveRemainder(account.state, applied, events);
  if (!remainder.ok) return remainder;

  return remainder.swapOfferCancelled
    ? accountTxSwapCancelled(events, remainder.swapOfferCancelled)
    : accountTxApplied(events);
}
