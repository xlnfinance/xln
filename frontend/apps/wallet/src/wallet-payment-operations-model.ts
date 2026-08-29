import type { RuntimePaymentEntityTx } from '../../../packages/runtime-client/src/payment-command-types';

import type { WalletPaymentMath, WalletPaymentProjection } from './wallet-payment-model';
import { normalizeEntityIdForRuntimeView } from '../../../packages/runtime-client/src/runtime-view-model';

export type WalletOperationKind = 'r2r' | 'r2c' | 'c2r' | 'lend' | 'borrow';
export type WalletLendingTerm = '1h' | '1d' | '1m';

export type WalletOperationDraft = Readonly<{
  kind: WalletOperationKind;
  targetEntityId: string;
  tokenId: number;
  amount: string;
  termId: WalletLendingTerm;
  interestBps: number;
  intentId: string;
}>;

const requireTarget = (
  projection: WalletPaymentProjection,
  rawTarget: string,
): string => {
  const targetEntityId = normalizeEntityIdForRuntimeView(rawTarget);
  const recipient = projection.recipients.find(({ entityId }) => entityId === targetEntityId);
  if (!recipient) throw new Error('WALLET_OPERATION_TARGET_UNKNOWN');
  if (recipient.blocked) throw new Error('WALLET_OPERATION_TARGET_BLOCKED');
  return targetEntityId;
};

const requireToken = (
  projection: WalletPaymentProjection,
  tokenId: number,
) => {
  const token = projection.tokens.find((candidate) => candidate.tokenId === tokenId);
  if (!token) throw new Error('WALLET_OPERATION_TOKEN_UNKNOWN');
  return token;
};

const requireAccount = (
  projection: WalletPaymentProjection,
  targetEntityId: string,
) => {
  const account = projection.accounts.find(({ counterpartyId }) => counterpartyId === targetEntityId);
  if (!account) throw new Error('WALLET_OPERATION_ACCOUNT_REQUIRED');
  return account;
};

const requireRate = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error('WALLET_OPERATION_INTEREST_BPS_INVALID');
  }
  return value;
};

const requireIntentId = (value: string): string => {
  const intentId = value.trim().toLowerCase();
  if (!/^(?:lend|borrow)-[a-z0-9-]{8,72}$/.test(intentId)) {
    throw new Error('WALLET_OPERATION_INTENT_ID_INVALID');
  }
  return intentId;
};

export const buildWalletOperationTx = (
  draft: WalletOperationDraft,
  projection: WalletPaymentProjection,
  math: WalletPaymentMath,
): RuntimePaymentEntityTx => {
  const targetEntityId = requireTarget(projection, draft.targetEntityId);
  const token = requireToken(projection, draft.tokenId);
  const amount = math.parseTokenAmount(draft.tokenId, draft.amount.trim());
  if (amount <= 0n) throw new Error('WALLET_OPERATION_AMOUNT_NOT_POSITIVE');
  if (draft.kind === 'r2r') {
    if (amount > token.reserve) throw new Error('WALLET_OPERATION_RESERVE_EXCEEDED');
    return { type: 'r2r', data: { toEntityId: targetEntityId, tokenId: draft.tokenId, amount } };
  }
  const account = requireAccount(projection, targetEntityId);
  if (draft.kind === 'r2c') {
    if (amount > token.reserve) throw new Error('WALLET_OPERATION_RESERVE_EXCEEDED');
    return {
      type: 'r2c',
      data: { counterpartyId: targetEntityId, tokenId: draft.tokenId, amount },
    };
  }
  if (draft.kind === 'c2r') {
    const position = account.positions.find((candidate) => candidate.tokenId === draft.tokenId);
    if (!position || amount > position.collateral) throw new Error('WALLET_OPERATION_COLLATERAL_EXCEEDED');
    return {
      type: 'settle_propose',
      data: {
        counterpartyEntityId: targetEntityId,
        executorIsLeft: math.isLeftEntity(projection.activeEntityId, targetEntityId),
        memo: 'react-wallet-c2r',
        ops: [{ type: 'c2r', tokenId: draft.tokenId, amount }],
      },
    };
  }
  const rate = requireRate(draft.interestBps);
  const intentId = requireIntentId(draft.intentId);
  if (draft.kind === 'lend') {
    return {
      type: 'lendingOffer',
      data: {
        positionId: intentId,
        hubEntityId: targetEntityId,
        tokenId: draft.tokenId,
        amount,
        termId: draft.termId,
        interestBps: rate,
      },
    };
  }
  return {
    type: 'lendingBorrow',
    data: {
      requestId: intentId,
      hubEntityId: targetEntityId,
      tokenId: draft.tokenId,
      amount,
      termId: draft.termId,
      maxInterestBps: rate,
    },
  };
};
