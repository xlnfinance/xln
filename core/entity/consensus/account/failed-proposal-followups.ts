import type { AccountFailedHtlcLock, AccountFailedLendingDisbursement } from '../../../account/consensus/types';
import type { AccountReplica, AccountTxBatch } from '../../../types/account';
import type { EntityState } from '../../types';
import { hasInboundPayment } from '../../../paybook/views';

export type FailedProposalHtlcFollowup =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'originated'; hashlock: string; reason: string }>
  | Readonly<{
      kind: 'forwarded';
      hashlock: string;
      reason: string;
      accountId: string;
      input: AccountTxBatch;
    }>;

/** One canonical interpretation of a genuine Account proposal rejection. */
export const failedProposalHtlcFollowup = (
  state: EntityState,
  failure: AccountFailedHtlcLock,
): FailedProposalHtlcFollowup => {
  const route = state.paybook.entries.get(failure.hashlock);
  if (!route) return { kind: 'absent' };
  if (!hasInboundPayment(route)) return { kind: 'originated', ...failure };
  return {
    kind: 'forwarded',
    ...failure,
    accountId: route.inboundEntity,
    input: {
      kind: 'enqueue',
      txs: [
        {
          type: 'htlc_resolve',
          data: {
            lockId: failure.hashlock,
            outcome: 'error',
            reason: `forward_failed:${failure.reason}`,
          },
        },
      ],
    },
  };
};

/** Account validation removed this exact local draw before signing. Release
 * only its bank reservation; the committed borrower request remains consumed.
 * A duplicate rejected row must never release an already signed pending draw
 * or a committed claim. Neither elapsed time nor transport silence proves that.
 */
export const applyRejectedLendingDraws = (
  state: EntityState,
  account: AccountReplica,
  failed: readonly AccountFailedLendingDisbursement[],
): void => {
  const lending = state.lending;
  if (!lending) return;
  for (const draw of failed) {
    const loan = lending.loans.get(draw.loanId);
    if (!loan || loan.status !== 'opening') continue;
    if (
      account.state.subcontracts?.has(loan.loanId) ||
      account.pendingFrame?.accountTxs.some(
        pending => pending.type === 'lending_disburse' && pending.data.loanId === loan.loanId,
      )
    )
      continue;
    if (
      loan.hubEntityId !== state.entityId ||
      loan.hubEntityId !== draw.hubEntityId ||
      loan.borrowerEntityId !== draw.borrowerEntityId ||
      loan.requestId !== draw.requestId ||
      loan.tokenId !== draw.tokenId ||
      loan.principalAmount !== draw.amount
    ) {
      throw new Error(`LENDING_REJECTED_DRAW_BINDING:${loan.loanId}`);
    }
    lending.loans.delete(loan.loanId);
  }
};