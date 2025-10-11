/**
 * Approve Withdrawal Handler
 * Counterparty approves or rejects withdrawal request
 * Reference: 2019src.txt lines 855-978 (giveWithdrawal)
 */

import { AccountMachine, AccountTx } from '../../types';

export function handleApproveWithdrawal(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'approve_withdrawal' }>
): { success: boolean; events: string[]; error?: string; jBatchAction?: any } {
  const { tokenId, amount, requestId, approved } = accountTx.data;
  const events: string[] = [];

  const request = accountMachine.pendingWithdrawals.get(requestId);
  if (!request) {
    return { success: false, error: `Withdrawal request ${requestId} not found`, events };
  }

  if (request.tokenId !== tokenId || request.amount !== amount) {
    return {
      success: false,
      error: `Approval mismatch: expected ${request.amount} token ${request.tokenId}, got ${amount} token ${tokenId}`,
      events
    };
  }

  if (!approved) {
    request.status = 'rejected';
    events.push(`❌ Withdrawal ${requestId.slice(-4)} rejected`);
    return { success: true, events };
  }

  // Approved!
  request.status = 'approved';
  events.push(`✅ Withdrawal ${requestId.slice(-4)} approved`);

  // If we initiated, we can now submit C→R to jBatch
  if (request.direction === 'outgoing') {
    return {
      success: true,
      events,
      jBatchAction: {
        type: 'collateral_to_reserve',
        counterpartyId: accountMachine.counterpartyEntityId,
        tokenId,
        amount,
      }
    };
  }

  return { success: true, events };
}
