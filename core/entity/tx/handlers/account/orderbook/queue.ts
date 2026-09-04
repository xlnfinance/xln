import type { AccountTx } from '../../../../../types/account';
import type { EntityState } from '../../../../types';
import { swapKey } from '../../../../../orderbook/swap-execution';

export interface AccountTxTarget {
  accountId: string;
  tx: AccountTx;
}

export type SwapResolveEnqueueData = {
  offerId: string;
  fillRatio: number;
  fillNumerator?: bigint;
  fillDenominator?: bigint;
  cancelRemainder: boolean;
  comment?: string;
  feeTokenId?: number;
  feeAmount?: bigint;
  executionGiveAmount?: bigint;
  executionWantAmount?: bigint;
  restingGiveTokenId?: number;
  restingWantTokenId?: number;
  restingPriceTicks?: bigint;
  restingGiveAmount?: bigint;
  restingWantAmount?: bigint;
  restingQuantizedGive?: bigint;
  restingQuantizedWant?: bigint;
};

export function hasQueuedSwapResolveForEntityState(
  hubState: EntityState,
  queuedSwapResolutions: Set<string>,
  accountId: string,
  offerId: string,
): boolean {
  const key = swapKey(accountId, offerId);
  if (queuedSwapResolutions.has(key)) return true;
  const account = hubState.accounts.get(accountId);
  if (!account) return false;
  if ((account.mempool ?? []).some((tx) => tx.type === 'swap_resolve' && tx.data.offerId === offerId)) return true;
  if ((account.pendingFrame?.accountTxs ?? []).some((tx) => tx.type === 'swap_resolve' && tx.data.offerId === offerId)) return true;
  return false;
}

export function queueUniqueSwapResolveForEntityState(
  accountTxs: AccountTxTarget[],
  hubState: EntityState,
  queuedSwapResolutions: Set<string>,
  accountId: string,
  data: SwapResolveEnqueueData,
): boolean {
  if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, accountId, data.offerId)) {
    return false;
  }
  queuedSwapResolutions.add(swapKey(accountId, data.offerId));
  accountTxs.push({
    accountId,
    tx: {
      type: 'swap_resolve',
      data,
    },
  });
  return true;
}
