import type { AccountState } from '../types/account';

export type AccountPerspective = {
  iAmLeft: boolean;
  from: string;
  to: string;
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
    from: iAmLeft ? account.leftEntity : account.rightEntity,
    to: iAmLeft ? account.rightEntity : account.leftEntity,
    counterparty: iAmLeft ? account.rightEntity : account.leftEntity,
  };
};
