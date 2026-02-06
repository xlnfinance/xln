/**
 * Request Withdrawal Handler
 * Entity requests to withdraw collateral → reserve (bilateral approval required)
 * Reference: 2019src.txt lines 904-978 (requestWithdrawal + giveWithdrawal)
 */

import type { AccountMachine, AccountTx } from '../../types';
// deriveDelta used for withdrawable calculation

export function handleRequestWithdrawal(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'request_withdrawal' }>,
  byLeft: boolean
): { success: boolean; events: string[]; error?: string; approvalNeeded?: AccountTx } {
  const { tokenId, amount, requestId } = accountTx.data;
  const events: string[] = [];

  const delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    return { success: false, error: `No delta for token ${tokenId}`, events };
  }

  // CRITICAL: Calculate withdrawable amount (2019src.txt line 945)
  // withdrawable = collateral - abs(offdelta) [uninsured balance]
  const totalDelta = delta.ondelta + delta.offdelta;
  const uninsuredBalance = totalDelta > 0n ? totalDelta : -totalDelta;
  const withdrawable = delta.collateral > uninsuredBalance ? delta.collateral - uninsuredBalance : 0n;

  if (amount > withdrawable) {
    return {
      success: false,
      error: `Insufficient withdrawable: ${amount} > ${withdrawable} (collateral ${delta.collateral}, uninsured ${uninsuredBalance})`,
      events
    };
  }

  // Derive perspective from byLeft (cosmetic: direction labeling)
  const iAmLeft = accountMachine.leftEntity === accountMachine.proofHeader.fromEntity;
  const isOurFrame = (byLeft === iAmLeft);

  if (isOurFrame) {
    // We are requesting
    accountMachine.pendingWithdrawals.set(requestId, {
      requestId,
      tokenId,
      amount,
      requestedAt: 0, // Will be set to frame.timestamp when committed
      direction: 'outgoing',
      status: 'pending',
    });
    events.push(`📤 Withdrawal requested: ${amount} token ${tokenId} (${requestId.slice(-4)})`);
  } else {
    // They are requesting - auto-approve if valid
    accountMachine.pendingWithdrawals.set(requestId, {
      requestId,
      tokenId,
      amount,
      requestedAt: 0, // Will be set to frame.timestamp when committed
      direction: 'incoming',
      status: 'pending',
    });
    events.push(`📥 Withdrawal request received: ${amount} token ${tokenId} (${requestId.slice(-4)})`);

    // Return approval needed (will be sent in response frame)
    return {
      success: true,
      events,
      approvalNeeded: {
        type: 'approve_withdrawal',
        data: {
          tokenId,
          amount,
          requestId,
          approved: true,
        }
      } as AccountTx
    };
  }

  return { success: true, events };
}
