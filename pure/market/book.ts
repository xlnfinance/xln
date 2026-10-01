// The matching rules of one hub book. `place` is Book x Order -> Result<Placed, PlaceFault>: the order trades against
// the best resting offers it reaches, at their prices, and what is left rests, is dropped, or refuses the whole order.
// `cancel` takes an offer back. Both return a new book and leave the old one alone.
import { MAX_AMOUNT } from "../account/ledger.ts";
import { err, flatMap, map, ok, type Result } from "../kernel/core/result.ts";
import { match, type Tagged } from "../kernel/core/tagged.ts";
import {
  opposite, type Book, type CancelFault, type DropReason, type Fill, type Limits, type Market, type Order,
  type OrderId, type Owner, type PlaceFault, type Placed, type Unfilled, type Resting, type Side,
} from "./model.ts";

/** A market names two different tokens and positive steps; the limits are positive. */
export type OpenFault =
  | Tagged<"same_token">
  | Tagged<"bad_step">
  | Tagged<"bad_limits">;

export const openBook = (market: Market, limits: Limits): Result<Book, OpenFault> => {
  if (market.base === market.quote) return err({ _tag: "same_token" });
  if (market.baseLot < 1n || market.quoteTick < 1n) return err({ _tag: "bad_step" });
  if (limits.maxOrders < 1 || limits.maxPerOwner < 1) return err({ _tag: "bad_limits" });
  return ok({ market, limits, buys: [], sells: [] });
};

const sideOf = (book: Book, side: Side): readonly Resting[] => (side === "buy" ? book.buys : book.sells);

const withSides = (book: Book, side: Side, own: readonly Resting[], other: readonly Resting[]): Book =>
  (side === "buy" ? { ...book, buys: own, sells: other } : { ...book, buys: other, sells: own });

const everyOrder = (book: Book): readonly Resting[] => [...book.buys, ...book.sells];

// ---- admission: the checks on the order itself, in order ----

const lotsInRange = (order: Order): Result<Order, PlaceFault> =>
  (order.lots >= 1n ? ok(order) : err({ _tag: "bad_lots", lots: order.lots }));

const priceInRange = (order: Order): Result<Order, PlaceFault> =>
  (order.price >= 1n ? ok(order) : err({ _tag: "bad_price", price: order.price }));

/** Both amounts of a trade at the order's own price are uint256s, as the Account's ledger needs them. */
const amountsFit = (market: Market, order: Order): Result<Order, PlaceFault> => {
  const base = order.lots * market.baseLot;
  const quote = order.lots * order.price * market.quoteTick;
  return base <= MAX_AMOUNT && quote <= MAX_AMOUNT ? ok(order) : err({ _tag: "amount_too_large" });
};

const notInBook = (book: Book, order: Order): Result<Order, PlaceFault> =>
  (everyOrder(book).some((r) => r.id === order.id) ? err({ _tag: "duplicate_order", id: order.id }) : ok(order));

const ownedBy = (book: Book, who: Owner): number => everyOrder(book).filter((r) => r.owner === who).length;

/** Only the part of an order that rests takes a place: the room is judged on the book the sweep leaves behind. */
const hasRoom = (after: Book, order: Order): Result<Order, PlaceFault> => {
  if (ownedBy(after, order.owner) >= after.limits.maxPerOwner) {
    return err({ _tag: "owner_full", max: after.limits.maxPerOwner });
  }
  return everyOrder(after).length >= after.limits.maxOrders
    ? err({ _tag: "book_full", max: after.limits.maxOrders })
    : ok(order);
};

const admitted = (book: Book, order: Order): Result<Order, PlaceFault> =>
  flatMap(lotsInRange(order), () =>
    flatMap(priceInRange(order), () =>
      flatMap(amountsFit(book.market, order), () => notInBook(book, order))));

// ---- the sweep: the order walks the opposite side from its best offer until something stops it ----

/** Why a sweep ended: the order is done, nothing is left at its price, or the next offer is its own. */
type Stop = "filled" | "book_empty" | "out_of_reach" | "own_order";

type Next = Tagged<"stop", { stop: Stop }> | Tagged<"trade", { maker: Resting }>;

/** A buyer reaches every offer priced at or below its limit, a seller every offer priced at or above it. */
const reaches = (order: Order, maker: Resting): boolean =>
  (order.side === "buy" ? maker.price <= order.price : maker.price >= order.price);

const nextStep = (order: Order, maker: Resting | undefined, left: bigint): Next => {
  if (left === 0n) return { _tag: "stop", stop: "filled" };
  if (maker === undefined) return { _tag: "stop", stop: "book_empty" };
  if (!reaches(order, maker)) return { _tag: "stop", stop: "out_of_reach" };
  return maker.owner === order.owner ? { _tag: "stop", stop: "own_order" } : { _tag: "trade", maker };
};

const fillOf = (order: Order, maker: Resting, lots: bigint): Fill => ({
  price: maker.price,
  lots,
  maker: { owner: maker.owner, order: maker.id },
  taker: { owner: order.owner, order: order.id, side: order.side },
  makerLotsLeft: maker.lots - lots,
});

type Sweep = Readonly<{ fills: readonly Fill[]; left: bigint; stop: Stop }>;

/** Where the sweep stands: the next offer to meet, the fills so far, and the lots still to trade. */
type Progress = Readonly<{ at: number; fills: readonly Fill[]; left: bigint }>;

const sweep = (order: Order, makers: readonly Resting[], progress: Progress): Sweep =>
  match(nextStep(order, makers[progress.at], progress.left), {
    stop: ({ stop }) => ({ fills: progress.fills, left: progress.left, stop }),
    trade: ({ maker }) => {
      const lots = progress.left < maker.lots ? progress.left : maker.lots;
      return sweep(order, makers, {
        at: progress.at + 1, fills: [...progress.fills, fillOf(order, maker, lots)], left: progress.left - lots,
      });
    },
  });

/** The offers still open after the fills. Each offer met is gone, unless the last is only partly taken. */
const offersLeft = (makers: readonly Resting[], fills: readonly Fill[]): readonly Resting[] => {
  const last = fills.at(-1);
  const partlyTaken = last !== undefined && last.makerLotsLeft > 0n;
  const firstLeft = partlyTaken ? fills.length - 1 : fills.length;
  return makers.slice(firstLeft).map((m, i) => (partlyTaken && i === 0 ? { ...m, lots: last.makerLotsLeft } : m));
};

// ---- what becomes of the part that did not trade ----

const dropWhy = (stop: Stop): DropReason => (stop === "own_order" ? "own_order" : "no_liquidity");

const unfilledOf = (order: Order, swept: Sweep): Unfilled => {
  if (swept.left === 0n) return { _tag: "none" };
  if (order.terms === "rest" && swept.stop !== "own_order") return { _tag: "rested", lots: swept.left };
  return { _tag: "dropped", lots: swept.left, why: dropWhy(swept.stop) };
};

const restingOf = (order: Order, lots: bigint): Resting =>
  ({ id: order.id, owner: order.owner, side: order.side, price: order.price, lots });

/** Behind every offer at its price or better, in front of every worse one: the order of the array is the priority. */
const inserted = (queue: readonly Resting[], offer: Resting): readonly Resting[] => {
  const worse = (r: Resting): boolean => (offer.side === "buy" ? r.price < offer.price : r.price > offer.price);
  const at = queue.findIndex(worse);
  return at < 0 ? [...queue, offer] : [...queue.slice(0, at), offer, ...queue.slice(at)];
};

/** All the quote a taker moves in one sweep is one amount in its Account, so the sum of its fills must fit too. */
const sweepFits = (market: Market, fills: readonly Fill[]): boolean =>
  fills.reduce((sum, f) => sum + f.lots * f.price * market.quoteTick, 0n) <= MAX_AMOUNT;

/** A finished sweep refuses its order if its quote overflows an amount, or an all-or-nothing order falls short. */
const sweepAccepted = (market: Market, order: Order, swept: Sweep): Result<Sweep, PlaceFault> => {
  if (!sweepFits(market, swept.fills)) return err({ _tag: "amount_too_large" });
  if (order.terms === "all_or_nothing" && swept.left > 0n) {
    return err({ _tag: "not_fillable", lots: order.lots, fillable: order.lots - swept.left });
  }
  return ok(swept);
};

/** The book once the sweep is done: the offers met are taken out, then what is left of the order rests if it may. */
const bookAfter = (book: Book, order: Order, swept: Sweep): Result<Placed, PlaceFault> => {
  const unfilled = unfilledOf(order, swept);
  const mine = sideOf(book, order.side);
  const theirs = offersLeft(sideOf(book, opposite(order.side)), swept.fills);
  const left = withSides(book, order.side, mine, theirs);
  if (unfilled._tag !== "rested") return ok({ book: left, fills: swept.fills, unfilled });
  const joined = inserted(mine, restingOf(order, unfilled.lots));
  return map(hasRoom(left, order), () => ({
    book: withSides(left, order.side, joined, theirs), fills: swept.fills, unfilled,
  }));
};

const traded = (book: Book, order: Order): Result<Placed, PlaceFault> => {
  const makers = sideOf(book, opposite(order.side));
  const swept = sweep(order, makers, { at: 0, fills: [], left: order.lots });
  return flatMap(sweepAccepted(book.market, order, swept), (accepted) => bookAfter(book, order, accepted));
};

export const place = (book: Book, order: Order): Result<Placed, PlaceFault> =>
  flatMap(admitted(book, order), (checked) => traded(book, checked));

export const cancel = (
  book: Book, request: Readonly<{ id: OrderId; owner: Owner }>,
): Result<Readonly<{ book: Book; cancelled: Resting }>, CancelFault> => {
  const found = everyOrder(book).find((r) => r.id === request.id);
  if (found === undefined) return err({ _tag: "no_such_order", id: request.id });
  if (found.owner !== request.owner) return err({ _tag: "not_owner", id: request.id });
  const kept = (r: Resting): boolean => r.id !== request.id;
  return ok({ book: { ...book, buys: book.buys.filter(kept), sells: book.sells.filter(kept) }, cancelled: found });
};
