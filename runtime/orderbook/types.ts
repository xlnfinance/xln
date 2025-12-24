/**
 * Orderbook Types for XLN
 *
 * Modular LOB supporting same-J and cross-J swaps.
 * Uses uint16 (0-65535) for fill ratios, not bps (0-10000).
 */

export type Side = 0 | 1;       // 0 = BUY (bids), 1 = SELL (asks)
export type TIF  = 0 | 1 | 2;   // 0 = GTC, 1 = IOC, 2 = FOK

/** Fill ratio uses full uint16 range (0-65535) for maximum granularity */
export const MAX_FILL_RATIO = 65535;

/** Order command types */
export type OrderCmd =
  | {
      kind: 0;                  // NEW
      ownerId: string;          // entityId (bytes32)
      orderId: string;          // unique order identifier
      side: Side;
      tif: TIF;
      postOnly: boolean;
      priceTicks: bigint;       // price in ticks (BigInt)
      qtyLots: bigint;          // quantity in lots (BigInt)
    }
  | {
      kind: 1;                  // CANCEL
      ownerId: string;
      orderId: string;
    }
  | {
      kind: 2;                  // REPLACE
      ownerId: string;
      orderId: string;
      newPriceTicks: bigint | null;
      qtyDeltaLots: bigint;
    };

/** Core orderbook parameters */
export interface OrderbookParams {
  pairId: string;             // e.g., "1/2" for tokenId 1 vs tokenId 2
  tick: bigint;               // 1 tick = smallest price increment
  pmin: bigint;               // inclusive min price in ticks
  pmax: bigint;               // inclusive max price in ticks
  maxOrders: number;          // capacity
  stpPolicy: 0 | 1 | 2;       // self-trade prevention: 0=off, 1=cancel taker, 2=reduce maker
}

/** Egress events from orderbook */
export type OrderbookEvent =
  | { type: 'ACK';      orderId: string; ownerId: string }
  | { type: 'REJECT';   orderId: string; ownerId: string; reason: string }
  | { type: 'CANCELED'; orderId: string; ownerId: string }
  | { type: 'REDUCED';  orderId: string; ownerId: string; delta: bigint; remain: bigint }
  | { type: 'TRADE';    price: bigint; qty: bigint; makerOwnerId: string; takerOwnerId: string; makerOrderId: string; takerOrderId: string };

/** Order stored in the book */
export interface StoredOrder {
  orderId: string;
  ownerId: string;
  side: Side;
  priceTicks: bigint;
  qtyLots: bigint;
  timestamp: number;          // for FIFO ordering
}

/** Canonical pair normalization */
export function canonicalPair(tokenA: number, tokenB: number): { base: number; quote: number; pairId: string } {
  const base = Math.min(tokenA, tokenB);
  const quote = Math.max(tokenA, tokenB);
  return { base, quote, pairId: `${base}/${quote}` };
}

/** Derive side from token direction */
export function deriveSide(giveTokenId: number, wantTokenId: number): Side {
  // If giving base token (lower id), you're SELLING base
  // If giving quote token (higher id), you're BUYING base
  return giveTokenId < wantTokenId ? 1 : 0;  // 1 = SELL, 0 = BUY
}

/** Calculate fill amount from ratio (uint16) */
export function applyFillRatio(amount: bigint, ratio: number): bigint {
  if (ratio >= MAX_FILL_RATIO) return amount;
  if (ratio <= 0) return 0n;
  return (amount * BigInt(ratio)) / BigInt(MAX_FILL_RATIO);
}
