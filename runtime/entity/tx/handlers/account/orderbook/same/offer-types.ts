import type { BookState } from '../../../../../../orderbook';
import type { SwapPairPolicy } from '../../../../../../account/utils';
import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';

export type MaterializedSameOffer = {
  offer: SameJurisdictionWorkingOrderbookOffer;
  accountId: string;
  bookKey: string;
  side: 0 | 1;
  priceTicks: bigint;
  qtyLots: bigint;
  makerId: string;
  namespacedOrderId: string;
  pairPolicy: SwapPairPolicy;
  hasExplicitPairPolicy: boolean;
  bucketWidthTicks: number;
};

export type PreparedSameOffer = MaterializedSameOffer & {
  book: BookState;
  bestBid: bigint | null;
  bestAsk: bigint | null;
};
