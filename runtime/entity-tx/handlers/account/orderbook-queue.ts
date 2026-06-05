import type { AccountTx, EntityState } from '../../../types';
import { swapKey } from '../../../swap-execution';

export interface MempoolOp {
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

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

export function hasQueuedSwapResolveForEntityState(
  hubState: EntityState,
  queuedSwapResolutions: Set<string>,
  accountId: string,
  offerId: string,
): boolean {
  const key = swapKey(accountId, offerId);
  if (queuedSwapResolutions.has(key)) return true;
  if (hubState.pendingSwapFillRatios?.has(key) === true) return true;
  const accountMachine = hubState.accounts.get(accountId);
  if (!accountMachine) return false;
  if ((accountMachine.mempool ?? []).some((tx) => tx.type === 'swap_resolve' && tx.data.offerId === offerId)) return true;
  if ((accountMachine.pendingFrame?.accountTxs ?? []).some((tx) => tx.type === 'swap_resolve' && tx.data.offerId === offerId)) return true;
  return false;
}

export function hasQueuedCrossSwapAckForEntityState(
  hubState: EntityState,
  accountId: string,
  offerId: string,
): boolean {
  const accountMachine = hubState.accounts.get(accountId);
  if (!accountMachine) return false;
  if ((accountMachine.mempool ?? []).some((tx) => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId)) return true;
  if ((accountMachine.pendingFrame?.accountTxs ?? []).some((tx) => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId)) return true;
  return false;
}

export function findQueuedCrossSwapAckForEntityState(
  hubState: EntityState,
  accountId: string,
  offerId: string,
): CrossSwapFillAckTx | null {
  const accountMachine = hubState.accounts.get(accountId);
  if (!accountMachine) return null;
  const mempoolAck = (accountMachine.mempool ?? []).find(
    (tx): tx is CrossSwapFillAckTx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId,
  );
  if (mempoolAck) return mempoolAck;
  const pendingAck = (accountMachine.pendingFrame?.accountTxs ?? []).find(
    (tx): tx is CrossSwapFillAckTx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId,
  );
  return pendingAck ?? null;
}

export function queueUniqueSwapResolveForEntityState(
  mempoolOps: MempoolOp[],
  hubState: EntityState,
  queuedSwapResolutions: Set<string>,
  accountId: string,
  data: SwapResolveEnqueueData,
): boolean {
  if (hasQueuedSwapResolveForEntityState(hubState, queuedSwapResolutions, accountId, data.offerId)) {
    return false;
  }
  queuedSwapResolutions.add(swapKey(accountId, data.offerId));
  mempoolOps.push({
    accountId,
    tx: {
      type: 'swap_resolve',
      data,
    },
  });
  return true;
}
