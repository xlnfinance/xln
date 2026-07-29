import type { AccountState, SwapOffer } from '../../../../types/account';
import type { SwapCancelEvent, SwapCancelRequestEvent, SwapOfferEvent } from '../../../../account/tx/apply-types';
import type { BookState } from '../../../../orderbook';
import type { CrossJurisdictionFillInstruction } from '../../../../extensions/cross-j/orderbook';
import type { AccountTxTarget } from './orderbook-queue';

type StoredOfferEntityRefs = {
  fromEntity?: string;
  toEntity?: string;
};

export const resolveStoredOfferEntityRefs = (
  account: AccountState,
  offer: SwapOffer,
): { fromEntity: string; toEntity: string } => {
  const persistedRefs = offer as SwapOffer & StoredOfferEntityRefs;
  return {
    fromEntity: account.leftEntity || persistedRefs.fromEntity || '',
    toEntity: account.rightEntity || persistedRefs.toEntity || '',
  };
};

export type { SwapCancelEvent, SwapCancelRequestEvent, SwapOfferEvent };

export interface MatchResult {
  accountTxs: AccountTxTarget[];
  crossJurisdictionFills: CrossJurisdictionFillInstruction[];
  bookUpdates: {
    pairId: string;
    book: BookState;
  }[];
  debugProjectionRejects: Array<{
    offerId: string;
    accountId: string;
    reason: string;
  }>;
}
