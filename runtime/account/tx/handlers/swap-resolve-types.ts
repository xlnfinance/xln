import type {
  AccountTx,
  Delta,
  SwapOffer,
} from '../../../types';

export type SwapResolveTx = Extract<AccountTx, { type: 'swap_resolve' }>;

export type SwapResolveResult = {
  success: boolean;
  events: string[];
  error?: string;
  swapOfferCancelled?: { offerId: string; accountId: string };
};

export type SwapResolveFailure = {
  success: false;
  events: string[];
  error: string;
};

export type ValidatedSwapResolve = {
  offerId: string;
  offer: SwapOffer;
  canonicalGiveAmount: bigint;
  canonicalWantAmount: bigint;
  canonicalQuantizedGive: bigint;
  canonicalQuantizedWant: bigint;
  canonicalPriceTicks?: bigint;
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
