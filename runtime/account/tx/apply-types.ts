import type { EntityCandidateEffect } from '../../types';

export type ApplyAccountTxResult = {
  success: boolean;
  events: string[];
  error?: string;
  secret?: string;
  hashlock?: string;
  timedOutHashlock?: string;
  amount?: bigint;
  tokenId?: number;
  swapOfferCreated?: {
    offerId: string;
    makerIsLeft: boolean;
    fromEntity: string;
    toEntity: string;
    createdHeight?: number;
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    priceTicks?: bigint | undefined;
    timeInForce?: 0 | 1 | 2 | undefined;
  };
  swapOfferCancelRequested?: { offerId: string };
  swapOfferCancelled?: { offerId: string; accountId: string; makerId?: string };
  pullResolved?: { pullId: string; fillRatio: number };
  pullCancelled?: { pullId: string; status: 'cancelled' | 'already-closed' };
  candidateEffects?: EntityCandidateEffect[];
};
