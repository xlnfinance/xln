// The face of the book toward the Accounts: what one `place` asks of the swap clauses it touches. Every party that
// trades gets one Execution: what its Account moves, and what its clause becomes afterwards. The clause is the chain's
// swap (plan/swap-onchain.md): the maker gives one token and wants another, both in absolute full-order amounts, and it
// stays signed until a newer co-signed state replaces it.
//
// How a partial fill re-signs the remainder: the new state moves the offdeltas by `gives` and `gets` and carries the
// clause of the lots still open, `remaining`, at the offer's own price. Amounts are not subtracted, they are rebuilt
// from the lots (`clauseOf`), so the price of the clause never drifts. A clause that is `filled` or `withdrawn` is
// left out of the new state. Both legs of a fill come from the same lots, so what the parties give in one token is
// exactly what the parties get in it (the hub itself ends with neither), with no ratio and no rounding.
import type { TokenId } from "../account/model.ts";
import type { Tagged } from "../kernel/core/tagged.ts";
import {
  opposite, type DropReason, type Fill, type Market, type Order, type OrderId, type Owner, type Placed, type Side,
} from "./model.ts";

export type Amount = Readonly<{ token: TokenId; amount: bigint }>;

/** The swap clause's payload: what its maker gives and what it wants, for the whole open order. */
export type Clause = Readonly<{ gives: Amount; wants: Amount }>;

/** What the offer's clause becomes: still open for the lots left, or gone (all filled, or the hub withdrew it). */
export type Remaining =
  | Tagged<"open", { clause: Clause }>
  | Tagged<"filled">
  | Tagged<"withdrawn", { why: DropReason }>;

export type Execution = Readonly<{
  owner: Owner;
  order: OrderId;
  /** What the owner's Account pays out in the clause's give token, and takes in in its want token; both may be 0. */
  gives: Amount;
  gets: Amount;
  remaining: Remaining;
}>;

const baseOf = (market: Market, lots: bigint): Amount => ({ token: market.base, amount: lots * market.baseLot });

const quoteOf = (market: Market, price: bigint, lots: bigint): Amount =>
  ({ token: market.quote, amount: lots * price * market.quoteTick });

/** The clause of an offer of `lots` at `price`: a seller gives base and wants quote, a buyer the reverse. */
export const clauseOf = (market: Market, offer: Readonly<{ side: Side; price: bigint; lots: bigint }>): Clause =>
  (offer.side === "sell"
    ? { gives: baseOf(market, offer.lots), wants: quoteOf(market, offer.price, offer.lots) }
    : { gives: quoteOf(market, offer.price, offer.lots), wants: baseOf(market, offer.lots) });

const stillOpen = (market: Market, offer: Readonly<{ side: Side; price: bigint; lots: bigint }>): Remaining =>
  (offer.lots === 0n ? { _tag: "filled" } : { _tag: "open", clause: clauseOf(market, offer) });

/** A party's amounts: a seller gives base and gets quote, a buyer the reverse. */
const amountsOf = (market: Market, side: Side, base: bigint, quote: bigint): Pick<Execution, "gives" | "gets"> => {
  const inBase: Amount = { token: market.base, amount: base };
  const inQuote: Amount = { token: market.quote, amount: quote };
  return side === "sell" ? { gives: inBase, gets: inQuote } : { gives: inQuote, gets: inBase };
};

/** The maker's side of one fill: it trades at its own price, and the lots it has left stay open. */
const makerExecution = (market: Market, fill: Fill): Execution => {
  const side = opposite(fill.taker.side);
  const moved = amountsOf(market, side, fill.lots * market.baseLot, fill.lots * fill.price * market.quoteTick);
  const remaining = stillOpen(market, { side, price: fill.price, lots: fill.makerLotsLeft });
  return { owner: fill.maker.owner, order: fill.maker.order, ...moved, remaining };
};

const remainingOfTaker = (market: Market, order: Order, placed: Placed): Remaining => {
  const remainder = placed.remainder;
  switch (remainder._tag) {
    case "none":
      return { _tag: "filled" };
    case "rested":
      return stillOpen(market, { side: order.side, price: order.price, lots: remainder.lots });
    case "dropped":
      return { _tag: "withdrawn", why: remainder.why };
  }
};

/** The taker's side of the whole sweep in one step: every fill summed, so its Account signs one new state. */
const takerExecution = (market: Market, order: Order, placed: Placed): Execution => {
  const lots = placed.fills.reduce((sum, f) => sum + f.lots, 0n);
  const quote = placed.fills.reduce((sum, f) => sum + f.lots * f.price * market.quoteTick, 0n);
  const moved = amountsOf(market, order.side, lots * market.baseLot, quote);
  return { owner: order.owner, order: order.id, ...moved, remaining: remainingOfTaker(market, order, placed) };
};

/** One execution per resting offer that was met, in the order met, then the taker's. */
export const executions = (market: Market, order: Order, placed: Placed): readonly Execution[] =>
  [...placed.fills.map((fill) => makerExecution(market, fill)), takerExecution(market, order, placed)];
