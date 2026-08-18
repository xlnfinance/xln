import type { AccountTx } from '../../../../types/account';
import type { AccountDraftReplica } from '../../../state/account-state-draft';
import { commitDeltaDraft, createDeltaDraft } from '../../delta-utils';
import { deriveDelta } from '../../../utils';
import { deriveTransferOffdeltaChange } from '../../../../protocol/transform/delta-movement';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied, accountTxValidationRejected } from '../../apply-result';

type RebalanceRefundTx = Extract<AccountTx, { type: 'rebalance_refund' }>;

export function handleRebalanceRefund(
  account: AccountDraftReplica,
  tx: RebalanceRefundTx,
  byLeft: boolean,
): ApplyAccountTxResult {
  const { requestId, requestTokenId, amount, reason } = tx.data;
  if (!requestId || amount <= 0n) {
    return accountTxValidationRejected('rebalance_refund: requestId and positive amount required', []);
  }
  const feeState = account.state.requestedRebalanceFeeState.get(requestTokenId);
  const requestedAmount = account.state.requestedRebalance.get(requestTokenId) ?? 0n;
  if (!feeState || requestedAmount <= 0n || feeState.requestId !== requestId) {
    return accountTxValidationRejected(`rebalance_refund: pending request not found (${requestId})`, []);
  }
  if (byLeft === feeState.requestedByLeft) {
    return accountTxValidationRejected('rebalance_refund: requester cannot refund itself', []);
  }
  if (feeState.refund && feeState.refund.reason !== reason) {
    return accountTxValidationRejected('rebalance_refund: reason conflicts with partial refund', []);
  }
  const refundedAmount = feeState.refund?.refundedAmount ?? 0n;
  const outstanding = feeState.feePaidUpfront - refundedAmount;
  if (outstanding <= 0n) throw new Error(`REBALANCE_REFUND_STATE_CORRUPT:${requestId}`);
  if (amount > outstanding) {
    return accountTxValidationRejected(
      `rebalance_refund: amount ${amount} exceeds outstanding ${outstanding}`,
      [],
    );
  }
  const feeDelta = account.state.deltas.get(feeState.feeTokenId);
  if (!feeDelta) {
    return accountTxValidationRejected(`rebalance_refund: fee token ${feeState.feeTokenId} missing`, []);
  }
  const capacity = deriveDelta(feeDelta, byLeft).outCapacity;
  if (amount > capacity) {
    return accountTxValidationRejected(
      `rebalance_refund: insufficient capacity (${capacity} < ${amount})`,
      [],
    );
  }

  const nextFeeDelta = createDeltaDraft(account.state, feeState.feeTokenId);
  nextFeeDelta.offdelta += deriveTransferOffdeltaChange(byLeft, amount);
  commitDeltaDraft(account.state, nextFeeDelta);
  const nextRefunded = refundedAmount + amount;
  if (nextRefunded === feeState.feePaidUpfront) {
    account.state.requestedRebalance.del(requestTokenId);
    account.state.requestedRebalanceFeeState.del(requestTokenId);
    // The submission marker is local execution bookkeeping, but it controls
    // whether a later request may enter J-batch. Clearing the canonical request
    // without clearing this marker permanently suppresses a new request for
    // the same token after a full bilateral refund.
    account.shadow.rebalance.submittedAtByToken.del(requestTokenId);
  } else {
    account.state.requestedRebalanceFeeState.put(requestTokenId, {
      ...feeState,
      refund: { reason, refundedAmount: nextRefunded },
    });
  }
  return accountTxApplied([
    `Rebalance refund ${requestId}: ${nextRefunded}/${feeState.feePaidUpfront}`,
  ]);
}
