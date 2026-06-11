import type { AccountMachine } from '$lib/types/ui';

type AccountStatusSource = Pick<AccountMachine, 'status' | 'mempool'> &
  Partial<Pick<AccountMachine, 'pendingFrame' | 'activeDispute'>>;

export type AccountUiStatus = 'ready' | 'sent' | 'dispute_preparing' | 'disputed' | 'finalized_disputed';

export function getAccountUiStatus(account: AccountStatusSource): AccountUiStatus {
  const hasActiveDispute = Boolean(account.activeDispute);
  if (hasActiveDispute) return 'disputed';

  const rawStatus = String(account.status || '').toLowerCase();
  if (rawStatus === 'dispute_preparing') return 'dispute_preparing';
  if (rawStatus === 'disputed') return 'finalized_disputed';

  const hasPending = Boolean(account.pendingFrame) || Number(account.mempool?.length || 0) > 0;
  if (hasPending) return 'sent';

  return 'ready';
}

export function getAccountUiStatusLabel(status: AccountUiStatus): string {
  if (status === 'sent') return 'PENDING';
  if (status === 'dispute_preparing') return 'DISPUTE PREP';
  if (status === 'disputed') return 'DISPUTED';
  if (status === 'finalized_disputed') return 'FINALIZED DISPUTED';
  return 'READY';
}

export function getAccountUiStatusDescription(status: AccountUiStatus): string {
  // "sent" is bilateral/off-chain account work: local mempool or pendingFrame.
  // On-chain confirmation belongs only to settlement/dispute batches.
  if (status === 'sent') return 'Pending off-chain frame';
  if (status === 'dispute_preparing') return 'Dispute preparation';
  if (status === 'disputed') return 'Dispute active';
  if (status === 'finalized_disputed') return 'Finalized dispute';
  return 'Active';
}
