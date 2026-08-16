import type { RuntimeOverlayRecord } from '../../../types/account';
import type { EntityState } from '../../types';
import { EntityAccountCandidateMap } from '../../state/persistent-account-map';

const addAccountId = (ids: Set<string>, accountId: string): void => {
  ids.add(accountId.toLowerCase());
};

const addStorageAccountIds = (
  ids: Set<string>,
  entityId: string,
  storageChanges: readonly RuntimeOverlayRecord[],
): void => {
  const owner = entityId.toLowerCase();
  for (const change of storageChanges) {
    if (change.family !== 'account') continue;
    if (change.entityId.toLowerCase() !== owner) continue;
    addAccountId(ids, change.counterpartyId);
  }
};

export const dirtyAccountIdsFromState = (state: EntityState): Iterable<string> =>
  state.accounts instanceof EntityAccountCandidateMap ? state.accounts.dirtyKeys() : [];

/** proposableAccounts ∪ account storageChanges ∪ candidate dirty keys. No all-account scan. */
export const collectTouchedAccountIds = (
  entityId: string,
  proposableAccounts: Iterable<string>,
  storageChanges: readonly RuntimeOverlayRecord[],
  dirtyAccountIds: Iterable<string> = [],
): string[] => {
  const ids = new Set<string>();
  for (const accountId of proposableAccounts) addAccountId(ids, accountId);
  for (const accountId of dirtyAccountIds) addAccountId(ids, accountId);
  addStorageAccountIds(ids, entityId, storageChanges);
  return [...ids];
};

export const copyProposableAccounts = (proposableAccounts: Iterable<string> | undefined): string[] =>
  [...(proposableAccounts ?? [])].map(accountId => accountId.toLowerCase());

export const touchedAccountIdsForHankoSeal = (
  state: EntityState,
  proposableAccounts: Iterable<string> | undefined,
  storageChanges: readonly RuntimeOverlayRecord[],
): string[] => collectTouchedAccountIds(
  state.entityId,
  proposableAccounts ?? [],
  storageChanges,
  dirtyAccountIdsFromState(state),
);
