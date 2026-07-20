import type { AccountMachine, AccountTx } from '../../../types';
import { deriveDelta } from '../../utils';

type RebalanceRefundTx = Extract<AccountTx, { type: 'rebalance_refund' }>;

export function handleRebalanceRefund(
  account: AccountMachine,
  tx: RebalanceRefundTx,
  byLeft: boolean,
): { success: boolean; events: string[]; error?: string } {
  const { requestId, requestTokenId, amount, reason } = tx.data;
  if (!requestId || amount <= 0n) {
    return { success: false, events: [], error: 'rebalance_refund: requestId and positive amount required' };
  }
  const feeState = account.requestedRebalanceFeeState.get(requestTokenId);
  const requestedAmount = account.requestedRebalance.get(requestTokenId) ?? 0n;
  if (!feeState || requestedAmount <= 0n || feeState.requestId !== requestId) {
    return { success: false, events: [], error: `rebalance_refund: pending request not found (${requestId})` };
  }
  if (byLeft === feeState.requestedByLeft) {
    return { success: false, events: [], error: 'rebalance_refund: requester cannot refund itself' };
  }
  if (feeState.refund && feeState.refund.reason !== reason) {
    return { success: false, events: [], error: 'rebalance_refund: reason conflicts with partial refund' };
  }
  const refundedAmount = feeState.refund?.refundedAmount ?? 0n;
  const outstanding = feeState.feePaidUpfront - refundedAmount;
  if (outstanding <= 0n) throw new Error(`REBALANCE_REFUND_STATE_CORRUPT:${requestId}`);
  if (amount > outstanding) {
    return { success: false, events: [], error: `rebalance_refund: amount ${amount} exceeds outstanding ${outstanding}` };
  }
  const feeDelta = account.deltas.get(feeState.feeTokenId);
  if (!feeDelta) {
    return { success: false, events: [], error: `rebalance_refund: fee token ${feeState.feeTokenId} missing` };
  }
  const capacity = deriveDelta(feeDelta, byLeft).outCapacity;
  if (amount > capacity) {
    return { success: false, events: [], error: `rebalance_refund: insufficient capacity (${capacity} < ${amount})` };
  }

  if (byLeft) feeDelta.offdelta -= amount;
  else feeDelta.offdelta += amount;
  const nextRefunded = refundedAmount + amount;
  if (nextRefunded === feeState.feePaidUpfront) {
    account.requestedRebalance.delete(requestTokenId);
    account.requestedRebalanceFeeState.delete(requestTokenId);
  } else {
    feeState.refund = { reason, refundedAmount: nextRefunded };
  }
  return {
    success: true,
    events: [`Rebalance refund ${requestId}: ${nextRefunded}/${feeState.feePaidUpfront}`],
  };
}
