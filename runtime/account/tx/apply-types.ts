import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { AccountOutput, AccountTx } from '../../types/account';
import type { Hashlock, HtlcSecret, TokenAmount, TokenId } from './units';

export interface SwapOfferEvent {
  offerId: string;
  makerIsLeft: boolean;
  fromEntity: string;
  toEntity: string;
  accountId?: string;
  createdHeight?: number;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  maxFee: bigint;
  minNetReceive: bigint;
  priceTicks?: bigint | undefined;
  timeInForce?: 0 | 1 | 2 | undefined;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
}

export interface SwapCancelEvent {
  offerId: string;
  accountId: string;
}

export interface SwapCancelRequestEvent {
  offerId: string;
  accountId: string;
}

export const ACCOUNT_TX_REJECTION_CODES = {
  validation: 'ACCOUNT_TX_VALIDATION',
  closedForDispute: 'ACCOUNT_CLOSED_FOR_DISPUTE',
  settlementSignedAccountFrozen: 'SETTLEMENT_SIGNED_ACCOUNT_FROZEN',
  settlementSealNonceMismatch: 'SETTLEMENT_SEAL_NONCE_MISMATCH',
  deltaTokenInvalid: 'ACCOUNT_DELTA_TOKEN_INVALID',
  deltaRowCountInvalid: 'ACCOUNT_DELTA_ROW_COUNT_INVALID',
  deltaRowLimitExceeded: 'ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED',
} as const satisfies Record<string, string>;

export type AccountTxRejectionCode =
  (typeof ACCOUNT_TX_REJECTION_CODES)[keyof typeof ACCOUNT_TX_REJECTION_CODES];

export type AccountTxRejection =
  | Readonly<{
      kind: 'validation';
      code: typeof ACCOUNT_TX_REJECTION_CODES.validation;
      message: string;
    }>
  | Readonly<{
      kind: 'account_closed_for_dispute';
      code: typeof ACCOUNT_TX_REJECTION_CODES.closedForDispute;
      message: string;
      status: string;
      txType: AccountTx['type'];
    }>
  | Readonly<{
      kind: 'settlement_signed_account_frozen';
      code: typeof ACCOUNT_TX_REJECTION_CODES.settlementSignedAccountFrozen;
      message: string;
      txType: AccountTx['type'];
    }>
  | Readonly<{
      kind: 'settlement_seal_nonce_mismatch';
      code: typeof ACCOUNT_TX_REJECTION_CODES.settlementSealNonceMismatch;
      message: string;
      suppliedNonce: number;
      requiredNonce: number;
      basis: 'workspace' | 'account';
    }>
  | Readonly<{
      kind: 'delta_token_invalid';
      code: typeof ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid;
      message: string;
      tokenId: number;
    }>
  | Readonly<{
      kind: 'delta_row_count_invalid';
      code: typeof ACCOUNT_TX_REJECTION_CODES.deltaRowCountInvalid;
      message: string;
    }>
  | Readonly<{
      kind: 'delta_row_limit_exceeded';
      code: typeof ACCOUNT_TX_REJECTION_CODES.deltaRowLimitExceeded;
      message: string;
    }>;

export const ACCOUNT_TX_FAILURE_DISPOSITIONS = {
  reject: 'reject',
  retry: 'retry',
  dispute: 'dispute',
  halt_runtime: 'halt_runtime',
} as const satisfies Record<string, string>;

export type AccountTxFailureDisposition =
  (typeof ACCOUNT_TX_FAILURE_DISPOSITIONS)[keyof typeof ACCOUNT_TX_FAILURE_DISPOSITIONS];

type AccountTxEvents = {
  events: string[];
  candidateEffects?: AccountOutput[];
};

export type ApplyAccountTxApplied = Readonly<AccountTxEvents & {
  ok: true;
  outcome: 'applied';
}>;

export type ApplyAccountTxHtlcSecret = Readonly<AccountTxEvents & {
  ok: true;
  outcome: 'htlc_secret';
  secret: HtlcSecret;
  hashlock: Hashlock;
  amount: TokenAmount;
  tokenId: TokenId;
}>;

export type ApplyAccountTxHtlcError = Readonly<AccountTxEvents & {
  ok: true;
  outcome: 'htlc_error';
  hashlock: Hashlock;
}>;

export type ApplyAccountTxSwapOfferCreated = Readonly<AccountTxEvents & {
  ok: true;
  outcome: 'swap_offer_created';
  swapOfferCreated: SwapOfferEvent;
}>;

export type ApplyAccountTxSwapCancelRequested = Readonly<AccountTxEvents & {
  ok: true;
  outcome: 'swap_cancel_requested';
  swapOfferCancelRequested: { offerId: string };
}>;

export type ApplyAccountTxSwapCancelled = Readonly<AccountTxEvents & {
  ok: true;
  outcome: 'swap_cancelled';
  swapOfferCancelled: { offerId: string; accountId: string; makerId?: string };
}>;

export type ApplyAccountTxOk =
  | ApplyAccountTxApplied
  | ApplyAccountTxHtlcSecret
  | ApplyAccountTxHtlcError
  | ApplyAccountTxSwapOfferCreated
  | ApplyAccountTxSwapCancelRequested
  | ApplyAccountTxSwapCancelled;

export type ApplyAccountTxRejected = Readonly<AccountTxEvents & {
  ok: false;
  rejection: AccountTxRejection;
}>;

export type ApplyAccountTxResult = ApplyAccountTxOk | ApplyAccountTxRejected;
