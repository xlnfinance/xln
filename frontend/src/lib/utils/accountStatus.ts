import type { AccountMachine } from '$lib/types/ui';

type AccountStatusSource = Pick<AccountMachine, 'status' | 'mempool'> &
  Partial<Pick<AccountMachine, 'pendingFrame' | 'activeDispute'>>;

export type AccountUiStatus = 'ready' | 'sent' | 'disputed' | 'finalized_disputed';

export function getAccountUiStatus(account: AccountStatusSource): AccountUiStatus {
  const hasActiveDispute = Boolean(account.activeDispute);
  if (hasActiveDispute) return 'disputed';

  const rawStatus = String(account.status || '').toLowerCase();
  if (rawStatus === 'disputed') return 'finalized_disputed';

  const hasPending = Boolean(account.pendingFrame) || Number(account.mempool?.length || 0) > 0;
  if (hasPending) return 'sent';

  return 'ready';
}

export function getAccountUiStatusLabel(status: AccountUiStatus): string {
  if (status === 'sent') return 'SENT';
  if (status === 'disputed') return 'DISPUTED';
  if (status === 'finalized_disputed') return 'FINALIZED DISPUTED';
  return 'READY';
}
