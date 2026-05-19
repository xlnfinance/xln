import type { AccountMachine } from '@xln/runtime/xln-api';
import type { EntityReplica } from '$lib/types/ui';

const COLLAPSED_ACCOUNT_LIMIT = 5;
const ACCOUNT_PAGE_SIZE = 50;

type AccountView = {
  status?: string;
  activeDispute?: unknown;
};

export type AccountListEntry = {
  counterpartyId: string;
  account: AccountMachine;
};

export type AccountPageView = {
  entries: AccountListEntry[];
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  isSearching: boolean;
};

function isFinalizedDisputed(account: AccountView): boolean {
  const status = String(account.status || '');
  const activeDispute = !!account.activeDispute;
  return status === 'disputed' && !activeDispute;
}

function getAccountsMap(sourceReplica: EntityReplica | null): Map<string, AccountMachine> | null {
  const accounts = sourceReplica?.state?.accounts;
  return accounts instanceof Map ? (accounts as Map<string, AccountMachine>) : null;
}

function accountMatchesSearch(counterpartyId: string, account: AccountMachine, query: string): boolean {
  if (!query) return true;
  const fields = [counterpartyId, account.leftEntity, account.rightEntity, account.status];
  return fields.some((field) => String(field || '').toLowerCase().includes(query));
}

export function buildAccountPageView(
  sourceReplica: EntityReplica | null,
  browserOpen: boolean,
  pageIndex: number,
  searchRaw: string,
): AccountPageView {
  const accounts = getAccountsMap(sourceReplica);
  const pageSize = browserOpen ? ACCOUNT_PAGE_SIZE : COLLAPSED_ACCOUNT_LIMIT;
  const page = browserOpen ? Math.max(0, pageIndex) : 0;
  const start = page * pageSize;
  const query = searchRaw.trim().toLowerCase();
  const entries: AccountListEntry[] = [];
  let matched = 0;
  let hasNext = false;

  if (!accounts) {
    return { entries, page, pageSize, hasPrevious: page > 0, hasNext, isSearching: Boolean(query) };
  }

  // Stop after the current page plus one sentinel so large hubs do not allocate every account.
  for (const [counterpartyId, account] of accounts.entries()) {
    if (isFinalizedDisputed(account)) continue;
    if (!accountMatchesSearch(String(counterpartyId), account, query)) continue;
    if (matched < start) {
      matched += 1;
      continue;
    }
    if (entries.length >= pageSize) {
      hasNext = true;
      break;
    }
    entries.push({ counterpartyId: String(counterpartyId), account });
    matched += 1;
  }

  return {
    entries,
    page,
    pageSize,
    hasPrevious: page > 0,
    hasNext,
    isSearching: Boolean(query),
  };
}
