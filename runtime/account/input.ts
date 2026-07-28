import type { AccountInput, AccountState, AccountTx } from '../types';

/**
 * Build the local-only Account input committed by the owning Entity frame.
 * The direction is derived from the canonical Account pair, never supplied by
 * a transaction handler that could accidentally route to a third entity.
 */
export const createLocalAccountInput = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity' | 'domain' | 'watchSeed'>,
  fromEntityId: string,
  txs: AccountTx[],
): AccountInput => {
  if (fromEntityId !== account.leftEntity && fromEntityId !== account.rightEntity) {
    throw new Error(`ACCOUNT_LOCAL_INPUT_OWNER_MISMATCH:${fromEntityId}`);
  }
  return {
    kind: 'txs',
    fromEntityId,
    toEntityId:
      fromEntityId === account.leftEntity ? account.rightEntity : account.leftEntity,
    domain: { ...account.domain },
    watchSeed: account.watchSeed,
    txs,
  };
};
