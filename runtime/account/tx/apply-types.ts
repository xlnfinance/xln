import type { CrossJurisdictionSwapRoute, EntityCandidateEffect } from '../../types';

// Account transitions own these outputs. Entity consumes them to update its
// orderbook projection, but must not redefine the financial result shape.
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

export type ApplyAccountTxResult = {
  success: boolean;
  events: string[];
  error?: string;
  secret?: string;
  hashlock?: string;
  timedOutHashlock?: string;
  amount?: bigint;
  tokenId?: number;
  swapOfferCreated?: SwapOfferEvent;
  swapOfferCancelRequested?: { offerId: string };
  swapOfferCancelled?: { offerId: string; accountId: string; makerId?: string };
  pullResolved?: { pullId: string; fillRatio: number };
  pullCancelled?: { pullId: string; status: 'cancelled' | 'already-closed' };
  candidateEffects?: EntityCandidateEffect[];
};
