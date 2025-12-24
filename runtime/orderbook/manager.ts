/**
 * Orderbook Manager
 *
 * Manages multiple orderbooks for a hub entity.
 * Handles canonical pair normalization and cross-J coordination.
 */

import { OrderbookEngine } from './engine';
import { OrderbookParams, OrderbookEvent, canonicalPair, deriveSide, Side, TIF } from './types';

export interface SwapOffer {
  offerId: string;
  ownerId: string;          // entityId
  accountId: string;        // which bilateral account
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  minFillRatio: number;     // 0-65535 (uint16)
  expiresAtHeight: number;
  jurisdictionId?: string;  // for cross-J tracking
}

export interface MatchResult {
  makerOfferId: string;
  takerOfferId: string;
  makerAccountId: string;
  takerAccountId: string;
  price: bigint;
  baseQty: bigint;
  quoteQty: bigint;
}

export class OrderbookManager {
  private books: Map<string, OrderbookEngine> = new Map();
  private offers: Map<string, SwapOffer> = new Map();
  private pendingMatches: MatchResult[] = [];

  // Default params for new books
  private defaultParams: Omit<OrderbookParams, 'pairId'> = {
    tick: 1n,
    pmin: 1n,
    pmax: 10n ** 18n,  // Reasonable max price
    maxOrders: 10000,
    stpPolicy: 0,
  };

  constructor(params?: Partial<Omit<OrderbookParams, 'pairId'>>) {
    if (params) {
      this.defaultParams = { ...this.defaultParams, ...params };
    }
  }

  /** Get or create orderbook for a token pair */
  getBook(tokenA: number, tokenB: number): OrderbookEngine {
    const { pairId } = canonicalPair(tokenA, tokenB);

    let book = this.books.get(pairId);
    if (!book) {
      book = new OrderbookEngine({
        pairId,
        ...this.defaultParams,
      });
      this.books.set(pairId, book);
    }
    return book;
  }

  /** Ingest a swap offer from an account */
  ingestOffer(offer: SwapOffer): void {
    this.offers.set(offer.offerId, offer);

    const { base, quote, pairId } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
    const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
    const book = this.getBook(offer.giveTokenId, offer.wantTokenId);

    // Calculate price in quote/base terms
    // Price = wantAmount / giveAmount (how much quote per base)
    let priceTicks: bigint;
    let qtyLots: bigint;

    if (side === 1) { // SELL base (giving base, want quote)
      // Price = quote received / base given
      priceTicks = (offer.wantAmount * 10n ** 18n) / offer.giveAmount;
      qtyLots = offer.giveAmount;
    } else { // BUY base (giving quote, want base)
      // Price = quote given / base received
      priceTicks = (offer.giveAmount * 10n ** 18n) / offer.wantAmount;
      qtyLots = offer.wantAmount;
    }

    book.applyCommand({
      kind: 0,
      ownerId: offer.ownerId,
      orderId: offer.offerId,
      side,
      tif: 0 as TIF, // GTC
      postOnly: false,
      priceTicks,
      qtyLots,
    });
  }

  /** Cancel an offer */
  cancelOffer(offerId: string): void {
    const offer = this.offers.get(offerId);
    if (!offer) return;

    const book = this.getBook(offer.giveTokenId, offer.wantTokenId);
    book.applyCommand({
      kind: 1,
      ownerId: offer.ownerId,
      orderId: offerId,
    });

    this.offers.delete(offerId);
  }

  /** Process matching and return fill instructions */
  processMatches(): MatchResult[] {
    const results: MatchResult[] = [];

    for (const [pairId, book] of this.books) {
      const events = book.drainEvents();

      for (const event of events) {
        if (event.type === 'TRADE') {
          const makerOffer = this.offers.get(event.makerOrderId);
          const takerOffer = this.offers.get(event.takerOrderId);

          if (makerOffer && takerOffer) {
            results.push({
              makerOfferId: event.makerOrderId,
              takerOfferId: event.takerOrderId,
              makerAccountId: makerOffer.accountId,
              takerAccountId: takerOffer.accountId,
              price: event.price,
              baseQty: event.qty,
              quoteQty: (event.price * event.qty) / 10n ** 18n,
            });
          }
        }
      }
    }

    return results;
  }

  /** Get all active offers for an entity */
  getOffersForEntity(entityId: string): SwapOffer[] {
    return Array.from(this.offers.values()).filter(o => o.ownerId === entityId);
  }

  /** Get book state for a pair */
  getBookState(tokenA: number, tokenB: number): {
    pairId: string;
    bestBid: bigint | null;
    bestAsk: bigint | null;
    spread: bigint | null;
  } | null {
    const { pairId } = canonicalPair(tokenA, tokenB);
    const book = this.books.get(pairId);
    if (!book) return null;

    return {
      pairId,
      bestBid: book.getBestBid(),
      bestAsk: book.getBestAsk(),
      spread: book.getSpread(),
    };
  }

  /** Compute combined state hash for all books */
  computeStateHash(): string {
    const hashes: string[] = [];
    for (const [pairId, book] of this.books) {
      hashes.push(`${pairId}:${book.computeStateHash()}`);
    }
    return hashes.sort().join('|');
  }

  /** Prune expired offers */
  pruneExpired(currentHeight: number): string[] {
    const expired: string[] = [];

    for (const [offerId, offer] of this.offers) {
      if (offer.expiresAtHeight <= currentHeight) {
        this.cancelOffer(offerId);
        expired.push(offerId);
      }
    }

    return expired;
  }
}
