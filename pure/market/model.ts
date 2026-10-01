// The hub's order book, in its own words. A hub holds many Accounts, and in each one a user may offer to swap one token
// for another. The book is where those offers meet: it knows who offered what at which price, and when an offer meets a
// better one it says which fills happen. It never touches an Account. A Fill carries the two legs an Account's swap
// clause must execute (`settlement`), so the clause design can change without the matching changing.
//
// A market is one token pair. A trader is a buyer or a seller of the BASE token, paying or receiving the QUOTE token.
// Quantities are whole lots and prices are whole ticks, so every amount of every fill is an exact integer:
//   base amount  = lots * baseLot
//   quote amount = lots * price * quoteTick
// A lot is the smallest base amount a trade can move, a tick is the smallest price step. There is no rounding to argue
// about, and so no leg that two Accounts could disagree on.
import type { Brand, Tagged } from "../kernel/core/tagged.ts";
import type { TokenId } from "../account/model.ts";

/** The Entity whose Account holds the offer's swap clause. */
export type Owner = Brand<string, "Owner">;

/** Names one offer in one book. The hub builds it from the owner and the clause slot; the book only needs it unique. */
export type OrderId = Brand<string, "OrderId">;

export const owner = (name: string): Owner => name as Owner;
export const orderId = (name: string): OrderId => name as OrderId;

export type Market = Readonly<{
  base: TokenId;
  quote: TokenId;
  /** Base token units in one lot. */
  baseLot: bigint;
  /** Quote token units in one tick of price, per lot. */
  quoteTick: bigint;
}>;

/** What a trader does with the base token. */
export type Side = "buy" | "sell";

export const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

/**
 * What happens to the part of an order that does not trade at once:
 * - `rest`: it waits in the book for a later order.
 * - `immediate`: it is dropped, with its reason named.
 * - `all_or_nothing`: the whole order trades now or the order is refused and nothing changes.
 */
export type Terms = "rest" | "immediate" | "all_or_nothing";

/** A limit order: it trades at its price or better. */
export type Order = Readonly<{
  id: OrderId;
  owner: Owner;
  side: Side;
  /** Ticks of quote per lot of base. */
  price: bigint;
  lots: bigint;
  terms: Terms;
}>;

/** An order waiting in the book, with the lots still open. */
export type Resting = Readonly<{ id: OrderId; owner: Owner; side: Side; price: bigint; lots: bigint }>;

/**
 * Both sides, best price first and, within a price, first come first served. The order of the arrays is the whole
 * priority rule: nothing else stores time. A book is never crossed: its best buy is below its best sell.
 */
export type Book = Readonly<{
  market: Market;
  limits: Limits;
  buys: readonly Resting[];
  sells: readonly Resting[];
}>;

/** The most a book holds, so its state is bounded by construction. An Account holds 32 clauses at most. */
export type Limits = Readonly<{ maxOrders: number; maxPerOwner: number }>;

/** One trade between a resting order (the maker) and the order that met it (the taker), at the maker's price. */
export type Fill = Readonly<{
  price: bigint;
  lots: bigint;
  maker: Readonly<{ owner: Owner; order: OrderId }>;
  taker: Readonly<{ owner: Owner; order: OrderId; side: Side }>;
  /** The maker's open lots after this fill: 0 when the offer is done. */
  makerLotsLeft: bigint;
}>;

/** What happened to the lots of an order that did not trade. */
export type Remainder =
  | Tagged<"none">
  | Tagged<"rested", { lots: bigint }>
  | Tagged<"dropped", { lots: bigint; why: DropReason }>;

/** `no_liquidity`: an `immediate` order met nothing at its price. `own_order`: the next trade would be with itself. */
export type DropReason = "no_liquidity" | "own_order";

/** The book after an order, every fill it made, and what became of the rest of it. */
export type Placed = Readonly<{ book: Book; fills: readonly Fill[]; remainder: Remainder }>;

export type PlaceFault =
  | Tagged<"bad_lots", { lots: bigint }>
  | Tagged<"bad_price", { price: bigint }>
  | Tagged<"amount_too_large">
  | Tagged<"duplicate_order", { id: OrderId }>
  | Tagged<"owner_full", { max: number }>
  | Tagged<"book_full", { max: number }>
  | Tagged<"not_fillable", { lots: bigint; fillable: bigint }>;

export type CancelFault =
  | Tagged<"no_such_order", { id: OrderId }>
  | Tagged<"not_owner", { id: OrderId }>;
