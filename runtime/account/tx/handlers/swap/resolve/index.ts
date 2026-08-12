/**
 * Same-jurisdiction swap settlement pipeline.
 *
 * The Account reducer validates immutable maker terms first, applies both
 * token deltas and holds atomically on the Account candidate, then updates or
 * closes the remaining order. Cross-j offers use their separate ACK protocol.
 */

import type { AccountReplica } from '../../../../../types/account';
import { recordSwapClosedLifecycle, recordSwapResolveLifecycle } from '../lifecycle/history';
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

const recordSwapResolveHistory = (
  account: AccountReplica,
  tx: SwapResolveTx,
  currentHeight: number,
  resolve: ReturnType<typeof validateSwapResolve> & { ok?: never },
  closeOrder: boolean,
): void => {
  const data = tx.data;
  recordSwapResolveLifecycle(
    account,
    resolve.offerId,
    currentHeight,
    {
      fillRatio: data.fillRatio,
      fillNumerator: data.fillNumerator ?? resolve.exactFillRatio.numerator,
      fillDenominator: data.fillDenominator ?? resolve.exactFillRatio.denominator,
      cancelRemainder: resolve.effectiveCancelRemainder,
      height: currentHeight,
      ...(data.executionGiveAmount !== undefined
        ? { executionGiveAmount: data.executionGiveAmount }
        : {}),
      ...(data.executionWantAmount !== undefined
        ? { executionWantAmount: data.executionWantAmount }
        : {}),
      ...(data.feeTokenId !== undefined ? { feeTokenId: data.feeTokenId } : {}),
      ...(resolve.feeAmount > 0n ? { feeAmount: resolve.feeAmount } : {}),
      ...(typeof data.comment === 'string' && data.comment.trim()
        ? { comment: data.comment }
        : {}),
    },
  );
  if (closeOrder) recordSwapClosedLifecycle(account, resolve.offerId);
};

export async function handleSwapResolve(
  account: AccountReplica,
  tx: SwapResolveTx,
  byLeft: boolean,
  currentHeight: number,
  _isValidation = false,
): Promise<SwapResolveResult> {
  const events: string[] = [];
  const validated = validateSwapResolve(account.state, tx, byLeft, events);
  if ('ok' in validated) return validated;
  const applied = applySwapResolveFinancials(account.state, validated, events);
  if ('ok' in applied) return applied;
  const remainder = applySwapResolveRemainder(account.state, applied, events);
  if (!remainder.ok) return remainder;

  recordSwapResolveHistory(
    account,
    tx,
    currentHeight,
    validated,
    remainder.closeOrderInHistory,
  );
  return remainder.swapOfferCancelled
    ? accountTxSwapCancelled(events, remainder.swapOfferCancelled)
    : accountTxApplied(events);
}
