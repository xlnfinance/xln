import type {
  AccountMachine,
  CrossJurisdictionSwapRoute,
  EntityState,
  SwapOffer,
} from '../../../types';
import { computeSwapPriceTicks, type BookState } from '../../../orderbook';
import {
  compareCanonicalText,
  type NormalizedOrderbookOffer,
} from '../../../swap-execution';
import type { CrossJurisdictionFillInstruction } from '../../../cross-jurisdiction-orderbook';
import type { MempoolOp } from './orderbook-queue';

type StoredOfferEntityRefs = {
  fromEntity?: string;
  toEntity?: string;
};

export const resolveStoredOfferEntityRefs = (
  account: AccountMachine,
  offer: SwapOffer,
): { fromEntity: string; toEntity: string } => {
  const persistedRefs = offer as SwapOffer & StoredOfferEntityRefs;
  return {
    fromEntity: account.leftEntity || persistedRefs.fromEntity || '',
    toEntity: account.rightEntity || persistedRefs.toEntity || '',
  };
};

// Events returned by account handlers and consumed by the entity orchestrator.
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
  minFillRatio: number;
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

export interface MatchResult {
  mempoolOps: MempoolOp[];
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

export const normalizeSwapOfferForOrderbook = (
  offer: SwapOfferEvent,
  accountId: string,
): NormalizedOrderbookOffer => {
  const priceTicks = typeof offer.priceTicks === 'bigint' && offer.priceTicks > 0n
    ? offer.priceTicks
    : computeSwapPriceTicks(
        offer.giveTokenId,
        offer.wantTokenId,
        offer.giveAmount,
        offer.wantAmount,
      );
  if (priceTicks <= 0n) {
    throw new Error(`ORDERBOOK_NORMALIZE_INVALID_PRICE: offer=${offer.offerId}`);
  }

  return {
    offerId: String(offer.offerId),
    accountId: String(accountId),
    makerIsLeft: !!offer.makerIsLeft,
    fromEntity: String(offer.fromEntity),
    toEntity: String(offer.toEntity),
    createdHeight: Number(offer.createdHeight ?? 0),
    giveTokenId: Number(offer.giveTokenId),
    giveAmount: BigInt(offer.giveAmount),
    wantTokenId: Number(offer.wantTokenId),
    wantAmount: BigInt(offer.wantAmount),
    priceTicks,
    timeInForce: offer.timeInForce ?? 0,
    minFillRatio: Number(offer.minFillRatio ?? 0),
    ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
  };
};

export const compareSwapOffersForOrderbook = <T extends NormalizedOrderbookOffer>(left: T, right: T): number => {
  const leftHeight = left.createdHeight;
  const rightHeight = right.createdHeight;
  if (leftHeight !== rightHeight) return leftHeight - rightHeight;
  const accountCmp = compareCanonicalText(left.accountId, right.accountId);
  if (accountCmp !== 0) return accountCmp;
  return compareCanonicalText(left.offerId, right.offerId);
};

export const sortSwapOffersForOrderbook = <T extends NormalizedOrderbookOffer>(swapOffers: readonly T[]): T[] =>
  [...swapOffers].sort(compareSwapOffersForOrderbook);

export const collectOpenSwapOffersForOrderbook = (hubState: EntityState): NormalizedOrderbookOffer[] =>
  sortSwapOffersForOrderbook(
    Array.from(hubState.accounts.entries()).flatMap(([accountId, account]) =>
      Array.from(account.swapOffers.entries()).flatMap(([offerId, offer]) => {
        if (
          !offer ||
          typeof offer.giveTokenId !== 'number' ||
          typeof offer.wantTokenId !== 'number' ||
          typeof offer.giveAmount !== 'bigint' ||
          typeof offer.wantAmount !== 'bigint'
        ) {
          return [];
        }
        return [
          normalizeSwapOfferForOrderbook(
            {
              offerId: String(offerId),
              makerIsLeft: offer.makerIsLeft,
              fromEntity: account.leftEntity,
              toEntity: account.rightEntity,
              createdHeight: offer.createdHeight,
              giveTokenId: offer.giveTokenId,
              giveAmount: offer.giveAmount,
              wantTokenId: offer.wantTokenId,
              wantAmount: offer.wantAmount,
              priceTicks: offer.priceTicks,
              timeInForce: offer.timeInForce,
              minFillRatio: offer.minFillRatio,
              ...(offer.crossJurisdiction ? { crossJurisdiction: offer.crossJurisdiction } : {}),
            },
            accountId,
          ),
        ];
      }),
    ),
  );
