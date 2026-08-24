import type { AccountOutput, AccountTx } from '../../types/account';
import { AccountDeltaError } from '../state/delta';
import type {
  AccountTxRejection,
  ApplyAccountTxApplied,
  ApplyAccountTxHtlcError,
  ApplyAccountTxHtlcSecret,
  ApplyAccountTxRejected,
  ApplyAccountTxResult,
  ApplyAccountTxSwapCancelRequested,
  ApplyAccountTxSwapCancelled,
  ApplyAccountTxSwapOfferCreated,
  SwapOfferEvent,
} from './apply-types';
import { ACCOUNT_TX_REJECTION_CODES } from './apply-types';
import {
  toHashlock,
  toHtlcSecret,
  toTokenAmount,
  toTokenId,
} from './units';

const eventsOf = (events: readonly string[]): string[] => [...events];

export const accountTxApplied = (
  events: readonly string[],
): ApplyAccountTxApplied => ({
  ok: true,
  outcome: 'applied',
  events: eventsOf(events),
});

export const accountTxHtlcSecret = (
  events: readonly string[],
  lockId: string,
  hashlock: string,
  secret: string,
  tokenId: number,
  amount: bigint,
): ApplyAccountTxHtlcSecret => ({
  ok: true,
  outcome: 'htlc_secret',
  events: eventsOf(events),
  lockId,
  hashlock: toHashlock(hashlock),
  secret: toHtlcSecret(secret),
  tokenId: toTokenId(tokenId),
  amount: toTokenAmount(amount),
});

export const accountTxHtlcError = (
  events: readonly string[],
  lockId: string,
  hashlock: string,
  tokenId: number,
  amount: bigint,
  reason?: string,
): ApplyAccountTxHtlcError => ({
  ok: true,
  outcome: 'htlc_error',
  events: eventsOf(events),
  lockId,
  hashlock: toHashlock(hashlock),
  tokenId: toTokenId(tokenId),
  amount: toTokenAmount(amount),
  ...(reason === undefined ? {} : { reason }),
});

export const accountTxSwapOfferCreated = (
  events: readonly string[],
  swapOfferCreated: SwapOfferEvent,
): ApplyAccountTxSwapOfferCreated => ({
  ok: true,
  outcome: 'swap_offer_created',
  events: eventsOf(events),
  swapOfferCreated,
});

export const accountTxSwapCancelRequested = (
  events: readonly string[],
  offerId: string,
): ApplyAccountTxSwapCancelRequested => ({
  ok: true,
  outcome: 'swap_cancel_requested',
  events: eventsOf(events),
  swapOfferCancelRequested: { offerId },
});

export const accountTxSwapCancelled = (
  events: readonly string[],
  swapOfferCancelled: { offerId: string; accountId: string; makerId?: string },
): ApplyAccountTxSwapCancelled => ({
  ok: true,
  outcome: 'swap_cancelled',
  events: eventsOf(events),
  swapOfferCancelled,
});

export const accountTxRejected = (
  rejection: AccountTxRejection,
  events: readonly string[],
): ApplyAccountTxRejected => ({
  ok: false,
  events: eventsOf(events),
  rejection,
});

export const accountTxValidationRejected = (
  message: string,
  events: readonly string[],
): ApplyAccountTxRejected =>
  accountTxRejected(
    {
      kind: 'validation',
      code: ACCOUNT_TX_REJECTION_CODES.validation,
      message,
    },
    events,
  );

export const accountTxHtlcLockCapacityRejected = (
  message: string,
  events: readonly string[],
): ApplyAccountTxRejected =>
  accountTxRejected(
    { kind: 'htlc_lock_capacity', code: ACCOUNT_TX_REJECTION_CODES.htlcLockCapacity, message },
    events,
  );

export const withAccountTxCandidateEffects = (
  result: ApplyAccountTxResult,
  candidateEffects: AccountOutput[],
): ApplyAccountTxResult =>
  candidateEffects.length > 0 ? { ...result, candidateEffects } : result;

export const accountTxRejectionMessage = (rejection: AccountTxRejection): string =>
  rejection.message;

export const accountTxFailureMessage = (result: ApplyAccountTxResult): string =>
  result.ok ? 'ACCOUNT_TX_UNEXPECTED_OK' : result.rejection.message;

export const closedForDisputeRejection = (
  status: string,
  txType: AccountTx['type'],
): AccountTxRejection => {
  const message = `ACCOUNT_CLOSED_FOR_DISPUTE:status=${status};tx=${txType}`;
  return {
    kind: 'account_closed_for_dispute',
    code: ACCOUNT_TX_REJECTION_CODES.closedForDispute,
    message,
    status,
    txType,
  };
};

export const settlementFrozenRejection = (
  txType: AccountTx['type'],
  message: string,
): AccountTxRejection => ({
  kind: 'settlement_signed_account_frozen',
  code: ACCOUNT_TX_REJECTION_CODES.settlementSignedAccountFrozen,
  message,
  txType,
});

export const settlementHankoNonceRejection = (
  message: string,
  suppliedNonce: number,
  requiredNonce: number,
  basis: 'workspace' | 'account',
): Extract<AccountTxRejection, { kind: 'settlement_hanko_nonce_mismatch' }> => ({
  kind: 'settlement_hanko_nonce_mismatch',
  code: ACCOUNT_TX_REJECTION_CODES.settlementHankoNonceMismatch,
  message,
  suppliedNonce,
  requiredNonce,
  basis,
});

export const rejectionFromDeltaError = (
  error: AccountDeltaError,
  tokenId: number,
): AccountTxRejection => {
  if (error.code === ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid) {
    return {
      kind: 'delta_token_invalid',
      code: ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid,
      message: error.message,
      tokenId,
    };
  }
  if (error.code === ACCOUNT_TX_REJECTION_CODES.deltaRowLimitExceeded) {
    return {
      kind: 'delta_row_limit_exceeded',
      code: ACCOUNT_TX_REJECTION_CODES.deltaRowLimitExceeded,
      message: error.message,
    };
  }
  return {
    kind: 'delta_row_count_invalid',
    code: ACCOUNT_TX_REJECTION_CODES.deltaRowCountInvalid,
    message: error.message,
  };
};

export const assertNever = (value: never): never => {
  throw new Error(`ACCOUNT_TX_OUTCOME_UNHANDLED:${String(value)}`);
};
