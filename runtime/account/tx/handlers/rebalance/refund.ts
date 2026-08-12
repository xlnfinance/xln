import type { AccountReplica, AccountTx } from '../../../../types/account';
import { deriveDelta } from '../../../utils';
import { deriveTransferOffdeltaChange } from '../../../../protocol/transform/delta-movement';

type RebalanceRefundTx = Extract<AccountTx, { type: 'rebalance_refund' }>;

export function handleRebalanceRefund(
  account: AccountReplica,
  tx: RebalanceRefundTx,
  byLeft: boolean,
): { success: boolean; events: string[]; error?: string } {
  const { requestId, requestTokenId, amount, reason } = tx.data;
  if (!requestId || amount <= 0n) {
    return { success: false, events: [], error: 'rebalance_refund: requestId and positive amount required' };
  }
  const feeState = account.state.requestedRebalanceFeeState.get(requestTokenId);
  const requestedAmount = account.state.requestedRebalance.get(requestTokenId) ?? 0n;
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
  const feeDelta = account.state.deltas.get(feeState.feeTokenId);
  if (!feeDelta) {
    return { success: false, events: [], error: `rebalance_refund: fee token ${feeState.feeTokenId} missing` };
  }
  const capacity = deriveDelta(feeDelta, byLeft).outCapacity;
  if (amount > capacity) {
    return { success: false, events: [], error: `rebalance_refund: insufficient capacity (${capacity} < ${amount})` };
  }

  feeDelta.offdelta += deriveTransferOffdeltaChange(byLeft, amount);
  const nextRefunded = refundedAmount + amount;
  if (nextRefunded === feeState.feePaidUpfront) {
    account.state.requestedRebalance.delete(requestTokenId);
    account.state.requestedRebalanceFeeState.delete(requestTokenId);
    // The submission marker is local execution bookkeeping, but it controls
    // whether a later request may enter J-batch. Clearing the canonical request
    // without clearing this marker permanently suppresses a new request for
    // the same token after a full bilateral refund.
    account.shadow.rebalance.submittedAtByToken.delete(requestTokenId);
  } else {
    feeState.refund = { reason, refundedAmount: nextRefunded };
  }
  return {
    success: true,
    events: [`Rebalance refund ${requestId}: ${nextRefunded}/${feeState.feePaidUpfront}`],
  };
}
