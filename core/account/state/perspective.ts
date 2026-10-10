import type { AccountState } from '../../types/account';

export type AccountPerspective = {
  iAmLeft: boolean;
  counterparty: string;
};

/**
 * Derive the local side from the canonical bilateral Account endpoints.
 *
 * LEFT/RIGHT is never caller-selected: both replicas must derive the same
 * orientation from the committed AccountState.
 */
export const getAccountPerspective = (account: AccountState, myEntityId: string): AccountPerspective => {
  const iAmLeft = myEntityId === account.leftEntity;
  return {
    iAmLeft,
    counterparty: iAmLeft ? account.rightEntity : account.leftEntity,
  };
};
