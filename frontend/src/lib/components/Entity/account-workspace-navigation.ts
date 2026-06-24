import type { AccountWorkspaceTab, ViewTab } from './entity-panel-routing';

export type AccountWorkspaceNavigationState = {
  activeTab: ViewTab;
  accountWorkspaceTab: AccountWorkspaceTab;
  workspaceAccountId: string;
  selectedAccountId: string | null;
};

export type AccountWorkspaceNavigationPatch = Partial<AccountWorkspaceNavigationState>;

export function matchWorkspaceAccountId(workspaceAccountIds: string[], rawAccountId: string): string {
  const nextRaw = String(rawAccountId || '').trim();
  if (!nextRaw) return '';
  return workspaceAccountIds.find((id) => String(id).toLowerCase() === nextRaw.toLowerCase()) || nextRaw;
}

export function selectAccountNavigation(
  workspaceAccountIds: string[],
  rawAccountId: string,
): AccountWorkspaceNavigationPatch {
  const selectedAccountId = String(rawAccountId || '').trim();
  if (!selectedAccountId) return { selectedAccountId: null };
  const matched = workspaceAccountIds.find((id) => String(id).toLowerCase() === selectedAccountId.toLowerCase());
  return {
    selectedAccountId,
    ...(matched ? { workspaceAccountId: matched } : {}),
  };
}

export function returnToAccountsWorkspace(
  state: Pick<AccountWorkspaceNavigationState, 'selectedAccountId'>,
  workspaceAccountIds: string[],
  accountWorkspaceTab: AccountWorkspaceTab,
): AccountWorkspaceNavigationPatch {
  const nextWorkspaceId = String(state.selectedAccountId || '').trim();
  return {
    ...(nextWorkspaceId ? { workspaceAccountId: matchWorkspaceAccountId(workspaceAccountIds, nextWorkspaceId) } : {}),
    selectedAccountId: null,
    activeTab: 'accounts',
    accountWorkspaceTab,
  };
}

export function selectTopLevelTabNavigation(
  state: Pick<AccountWorkspaceNavigationState, 'selectedAccountId'>,
  workspaceAccountIds: string[],
  nextTab: ViewTab,
): AccountWorkspaceNavigationPatch {
  if (nextTab === 'accounts' && state.selectedAccountId) {
    return returnToAccountsWorkspace(state, workspaceAccountIds, 'activity');
  }
  return {
    ...(state.selectedAccountId ? { selectedAccountId: null } : {}),
    activeTab: nextTab,
  };
}

export function openDisputedAccountNavigation(counterpartyEntityId: string): AccountWorkspaceNavigationPatch {
  const selectedAccountId = String(counterpartyEntityId || '').trim();
  if (!selectedAccountId) return {};
  return {
    selectedAccountId,
    activeTab: 'accounts',
  };
}
