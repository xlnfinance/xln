import type { AccountExternalFinalityInput, AccountInput, AccountState, AccountTx } from '../types/account';
import type { AccountPeerRejectionCode } from './peer-rejection';
import { isAccountWatchSeed } from '../protocol/account-watch-seed';
import { canonicalAccountDisputeConfig } from './dispute-config';

export type AccountInputEnvelopeError = Readonly<{
  code: AccountPeerRejectionCode;
  reason: string;
}>;

/**
 * Build the local-only Account input committed by the owning Entity frame.
 * The direction is derived from the canonical Account pair, never supplied by
 * a transaction handler that could accidentally route to a third entity.
 */
export const createLocalAccountInput = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity' | 'domain' | 'watchSeed' | 'disputeConfig'>,
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
    disputeConfig: canonicalAccountDisputeConfig(account.disputeConfig),
    watchSeed: account.watchSeed,
    txs,
  };
};

export const createAccountDisputeFinalityInput = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity' | 'domain' | 'disputeConfig'>,
  owningEntityId: string,
  finalizedJNonce: number,
  finalizedTokenIds: number[],
): AccountExternalFinalityInput => {
  if (
    owningEntityId !== account.leftEntity &&
    owningEntityId !== account.rightEntity
  ) {
    throw new Error(`ACCOUNT_FINALITY_INPUT_OWNER_MISMATCH:${owningEntityId}`);
  }
  return {
    kind: 'external_finality',
    fromEntityId: owningEntityId,
    toEntityId:
      owningEntityId === account.leftEntity
        ? account.rightEntity
        : account.leftEntity,
    domain: { ...account.domain },
    disputeConfig: canonicalAccountDisputeConfig(account.disputeConfig),
    finality: {
      kind: 'dispute_finalized',
      finalizedJNonce,
      finalizedTokenIds: [...finalizedTokenIds],
    },
  };
};

export const createAccountDisputeStartedInput = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity' | 'domain' | 'disputeConfig'>,
  owningEntityId: string,
  finality: Extract<
    AccountExternalFinalityInput['finality'],
    { kind: 'dispute_started' }
  >,
): AccountExternalFinalityInput => {
  if (
    owningEntityId !== account.leftEntity &&
    owningEntityId !== account.rightEntity
  ) {
    throw new Error(`ACCOUNT_FINALITY_INPUT_OWNER_MISMATCH:${owningEntityId}`);
  }
  return {
    kind: 'external_finality',
    fromEntityId: owningEntityId,
    toEntityId:
      owningEntityId === account.leftEntity
        ? account.rightEntity
        : account.leftEntity,
    domain: { ...account.domain },
    disputeConfig: canonicalAccountDisputeConfig(account.disputeConfig),
    finality: { ...finality },
  };
};

/** Validate the common envelope before any Account variant can mutate state. */
export const getAccountInputEnvelopeError = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity' | 'domain' | 'watchSeed' | 'disputeConfig'>,
  input: AccountInput,
): AccountInputEnvelopeError | undefined => {
  if (
    !input.domain ||
    !Number.isSafeInteger(input.domain.chainId) ||
    typeof input.domain.depositoryAddress !== 'string'
  ) {
    return {
      code: 'ACCOUNT_PEER_DOMAIN_INVALID',
      reason: `ACCOUNT_INPUT_DOMAIN_INVALID:${input.fromEntityId}`,
    };
  }
  let inputDisputeConfig: AccountState['disputeConfig'];
  try {
    inputDisputeConfig = canonicalAccountDisputeConfig(input.disputeConfig);
  } catch {
    return {
      code: 'ACCOUNT_PEER_DISPUTE_CONFIG_INVALID',
      reason: `ACCOUNT_INPUT_DISPUTE_CONFIG_INVALID:${input.fromEntityId}`,
    };
  }
  const accountDisputeConfig = canonicalAccountDisputeConfig(account.disputeConfig);
  if (
    inputDisputeConfig.leftResponseSeconds !== accountDisputeConfig.leftResponseSeconds ||
    inputDisputeConfig.rightResponseSeconds !== accountDisputeConfig.rightResponseSeconds
  ) {
    return {
      code: 'ACCOUNT_PEER_DISPUTE_CONFIG_MISMATCH',
      reason: `ACCOUNT_INPUT_DISPUTE_CONFIG_MISMATCH:${input.fromEntityId}`,
    };
  }
  const left = account.leftEntity.toLowerCase();
  const right = account.rightEntity.toLowerCase();
  const from = input.fromEntityId.toLowerCase();
  const to = input.toEntityId.toLowerCase();
  if (
    from === to ||
    !((from === left && to === right) || (from === right && to === left))
  ) {
    return {
      code: 'ACCOUNT_PEER_PARTY_MISMATCH',
      reason: `ACCOUNT_INPUT_PARTY_MISMATCH:${input.fromEntityId}:${input.toEntityId}`,
    };
  }
  if (
    input.domain.chainId !== account.domain.chainId ||
    input.domain.depositoryAddress.toLowerCase() !==
      account.domain.depositoryAddress.toLowerCase()
  ) {
    return {
      code: 'ACCOUNT_PEER_DOMAIN_MISMATCH',
      reason: `ACCOUNT_INPUT_DOMAIN_MISMATCH:${input.fromEntityId}`,
    };
  }
  if (input.kind === 'txs' && input.watchSeed === undefined) {
    return {
      code: 'ACCOUNT_PEER_WATCH_SEED_INVALID',
      reason: `ACCOUNT_LOCAL_INPUT_WATCH_SEED_MISSING:${input.fromEntityId}`,
    };
  }
  if (input.watchSeed !== undefined && !isAccountWatchSeed(input.watchSeed)) {
    return {
      code: 'ACCOUNT_PEER_WATCH_SEED_INVALID',
      reason: `ACCOUNT_INPUT:ACCOUNT_WATCH_SEED_INVALID:${input.fromEntityId}`,
    };
  }
  if (
    input.watchSeed !== undefined &&
    input.watchSeed.toLowerCase() !== account.watchSeed.toLowerCase()
  ) {
    return {
      code: 'ACCOUNT_PEER_WATCH_SEED_MISMATCH',
      reason: `ACCOUNT_WATCH_SEED_MISMATCH:${input.fromEntityId}`,
    };
  }
  return undefined;
};
