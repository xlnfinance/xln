import type { AccountReplica } from '@xln/core/api/public/runtime-module';
import { compareEntityAssetText } from './../assets/entity-asset-catalog';
import { isMapLike } from '$lib/utils/runtime/liveRuntimeEnv';

export type DisputedAccountView = {
  counterpartyId: string;
  status: 'active' | 'finalized';
};

export function buildDisputedAccountViews(accounts: ReadonlyMap<string, AccountReplica> | undefined): DisputedAccountView[] {
  if (!isMapLike(accounts)) return [];
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
