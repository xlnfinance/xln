import type { AccountReplica } from '@xln/runtime/api/public/runtime-module';
import { compareEntityAssetText } from './../assets/entity-asset-catalog';

export type DisputedAccountView = {
  counterpartyId: string;
  status: 'active' | 'finalized';
};

export function buildDisputedAccountViews(accounts: Map<string, AccountReplica> | undefined): DisputedAccountView[] {
  if (!(accounts instanceof Map)) return [];
  const out: DisputedAccountView[] = [];
  for (const [counterpartyId, account] of accounts.entries()) {
    const activeDispute = account.activeDispute;
    const status = String(account.status || '');
    if (status !== 'disputed') continue;
    out.push({
      counterpartyId: String(counterpartyId),
      status: activeDispute ? 'active' : 'finalized',
    });
  }
  return out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return compareEntityAssetText(a.counterpartyId, b.counterpartyId);
  });
}
