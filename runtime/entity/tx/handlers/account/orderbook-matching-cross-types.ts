import type { EntityCandidateEffect, EntityState } from '../../../../types';
import type { BookState, OrderbookExtState } from '../../../../orderbook';
import type {
  CrossJurisdictionFillInstruction,
  CrossMarketOffer,
} from '../../../../extensions/cross-j/orderbook';
import type { CrossJurisdictionWorkingOrderbookOffer } from '../../../../orderbook/swap-execution';
import type { AccountTxTarget } from './orderbook-queue';

type RejectInvalidCrossOffer = (
  accountId: string,
  offerId: string,
  reason: string,
) => void;
type RecordDebugProjectionReject = (
  accountId: string,
  offerId: string,
  reason: string,
) => true;

export type CrossOrderbookProcessInput = {
  candidateEffects?: EntityCandidateEffect[];
  hubState: EntityState;
  ext: OrderbookExtState;
  crossJurisdictionSwapOffers: CrossJurisdictionWorkingOrderbookOffer[];
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  accountTxs: AccountTxTarget[];
  crossJurisdictionFills: CrossJurisdictionFillInstruction[];
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
  rejectInvalidCrossOffer: RejectInvalidCrossOffer;
  recordDebugProjectionReject: RecordDebugProjectionReject;
};

export type CrossAggregatedFill = {
  filledLots: bigint;
  weightedCost: bigint;
};

export type CrossOrderbookPass = CrossOrderbookProcessInput & {
  crossLiveOfferMeta: Map<string, CrossMarketOffer>;
  assertedPairs: Set<string>;
  aggregatedFills: Map<string, CrossAggregatedFill>;
  suspendedOrderIds: Set<string>;
  workingBookCache: Map<string, BookState>;
  speculativeTradePairs: Set<string>;
};

export type PreparedCrossOffer = {
  rawOffer: CrossJurisdictionWorkingOrderbookOffer;
  accountId: string;
  namespacedOrderId: string;
  marketOffer: CrossMarketOffer;
  qtyLots: bigint;
  committedBook: BookState;
};
