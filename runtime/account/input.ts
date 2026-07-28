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

/** Validate the common envelope before any Account variant can mutate state. */
export const getAccountInputEnvelopeError = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity' | 'domain' | 'watchSeed'>,
  input: AccountInput,
): string | undefined => {
  if (
    !input.domain ||
    !Number.isSafeInteger(input.domain.chainId) ||
    typeof input.domain.depositoryAddress !== 'string'
  ) {
    return `ACCOUNT_INPUT_DOMAIN_INVALID:${input.fromEntityId}`;
  }
  const left = account.leftEntity.toLowerCase();
  const right = account.rightEntity.toLowerCase();
  const from = input.fromEntityId.toLowerCase();
  const to = input.toEntityId.toLowerCase();
  if (
    from === to ||
    !((from === left && to === right) || (from === right && to === left))
  ) {
    return `ACCOUNT_INPUT_PARTY_MISMATCH:${input.fromEntityId}:${input.toEntityId}`;
  }
  if (
    input.domain.chainId !== account.domain.chainId ||
    input.domain.depositoryAddress.toLowerCase() !==
      account.domain.depositoryAddress.toLowerCase()
  ) {
    return `ACCOUNT_INPUT_DOMAIN_MISMATCH:${input.fromEntityId}`;
  }
  if (input.kind === 'txs' && input.watchSeed === undefined) {
    return `ACCOUNT_LOCAL_INPUT_WATCH_SEED_MISSING:${input.fromEntityId}`;
  }
  if (
    input.watchSeed !== undefined &&
    input.watchSeed.toLowerCase() !== account.watchSeed.toLowerCase()
  ) {
    return `ACCOUNT_WATCH_SEED_MISMATCH:${input.fromEntityId}`;
  }
  return undefined;
};
