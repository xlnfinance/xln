import type { AccountTx, Delta, SwapOffer } from '../../../../../types/account';
import type { ApplyAccountTxRejected, ApplyAccountTxResult } from '../../../apply-types';

export type SwapResolveTx = Extract<AccountTx, { type: 'swap_resolve' }>;

export type SwapResolveResult = ApplyAccountTxResult;

export type SwapResolveFailure = ApplyAccountTxRejected;

export type ValidatedSwapResolve = {
  offerId: string;
  offer: SwapOffer;
  canonicalQuantizedGive: bigint;
  canonicalQuantizedWant: bigint;
  canonicalPriceTicks: bigint;
  effectiveCancelRemainder: boolean;
  filledGive: bigint;
  filledWant: bigint;
  canonicalFillRatio: number;
  effectiveFeeTokenId: number;
  feeAmount: bigint;
};

export type AppliedSwapResolve = ValidatedSwapResolve & {
  giveDelta: Delta;
  wantDelta: Delta;
  makerHoldSide: 'left' | 'right';
};
