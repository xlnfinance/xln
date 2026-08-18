import type { AccountTx, Delta, SwapOffer } from '../../../../../types/account';
import type { ApplyAccountTxRejected, ApplyAccountTxResult } from '../../../apply-types';

export type SwapResolveTx = Extract<AccountTx, { type: 'swap_resolve' }>;

export type SwapResolveResult = ApplyAccountTxResult;

export type SwapResolveFailure = ApplyAccountTxRejected;

export type ValidatedSwapResolve = {
  offerId: string;
  offer: SwapOffer;
  canonicalGiveAmount: bigint;
  canonicalWantAmount: bigint;
  canonicalQuantizedGive: bigint;
  canonicalQuantizedWant: bigint;
  canonicalPriceTicks: bigint;
  effectiveCancelRemainder: boolean;
  filledGive: bigint;
  filledWant: bigint;
  canonicalFillRatio: number;
  exactFillRatio: { numerator: bigint; denominator: bigint };
  effectiveFeeTokenId: number;
  feeAmount: bigint;
};

export type AppliedSwapResolve = ValidatedSwapResolve & {
  giveDelta: Delta;
  wantDelta: Delta;
  makerHoldSide: 'left' | 'right';
};
