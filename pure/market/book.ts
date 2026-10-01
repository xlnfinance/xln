// The matching rules of one hub book. `place` is Book x Order -> Result<Placed, PlaceFault>: the order trades against
// the best resting offers it reaches, at their prices, and what is left rests, is dropped, or refuses the whole order.
// `cancel` takes an offer back. Both return a new book and leave the old one alone.
import { MAX_AMOUNT } from "../account/ledger.ts";
import { err, flatMap, ok, type Result } from "../kernel/core/result.ts";
import { match, type Tagged } from "../kernel/core/tagged.ts";
import {
  opposite, type Book, type CancelFault, type DropReason, type Fill, type Limits, type Market, type Order,
  type OrderId, type Owner, type PlaceFault, type Placed, type Remainder, type Resting, type Side,
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

/** Only an order that may rest takes a place in the book. */
const hasRoom = (book: Book, order: Order): Result<Order, PlaceFault> => {
  if (order.terms !== "rest") return ok(order);
  if (ownedBy(book, order.owner) >= book.limits.maxPerOwner) {
    return err({ _tag: "owner_full", max: book.limits.maxPerOwner });
  }
  return everyOrder(book).length >= book.limits.maxOrders
    ? err({ _tag: "book_full", max: book.limits.maxOrders })
    : ok(order);
};

const admitted = (book: Book, order: Order): Result<Order, PlaceFault> =>
  flatMap(lotsInRange(order), () =>
    flatMap(priceInRange(order), () =>
      flatMap(amountsFit(book.market, order), () =>
        flatMap(notInBook(book, order), () => hasRoom(book, order)))));

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
type Walk = Readonly<{ at: number; fills: readonly Fill[]; left: bigint }>;

const sweep = (order: Order, makers: readonly Resting[], walk: Walk): Sweep =>
  match(nextStep(order, makers[walk.at], walk.left), {
    stop: ({ stop }) => ({ fills: walk.fills, left: walk.left, stop }),
    trade: ({ maker }) => {
      const lots = walk.left < maker.lots ? walk.left : maker.lots;
      return sweep(order, makers, {
        at: walk.at + 1, fills: [...walk.fills, fillOf(order, maker, lots)], left: walk.left - lots,
      });
    },
  });

/** The offers that are left after the fills: the ones met are gone, and the last one met may be partly open. */
const survivors = (makers: readonly Resting[], fills: readonly Fill[]): readonly Resting[] => {
  const last = fills.at(-1);
  const partlyOpen = last !== undefined && last.makerLotsLeft > 0n;
  const reduced = makers.map((m, i) => (partlyOpen && i === fills.length - 1 ? { ...m, lots: last.makerLotsLeft } : m));
  return reduced.slice(partlyOpen ? fills.length - 1 : fills.length);
};

// ---- what becomes of the part that did not trade ----

const dropWhy = (stop: Stop): DropReason => (stop === "own_order" ? "own_order" : "no_liquidity");

const remainderOf = (order: Order, swept: Sweep): Remainder => {
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

const traded = (book: Book, order: Order): Result<Placed, PlaceFault> => {
  const makers = sideOf(book, opposite(order.side));
  const swept = sweep(order, makers, { at: 0, fills: [], left: order.lots });
  if (!sweepFits(book.market, swept.fills)) return err({ _tag: "amount_too_large" });
  if (order.terms === "all_or_nothing" && swept.left > 0n) {
    return err({ _tag: "not_fillable", lots: order.lots, fillable: order.lots - swept.left });
  }
  const remainder = remainderOf(order, swept);
  const mine = sideOf(book, order.side);
  const own = remainder._tag === "rested" ? inserted(mine, restingOf(order, remainder.lots)) : mine;
  return ok({ book: withSides(book, order.side, own, survivors(makers, swept.fills)), fills: swept.fills, remainder });
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
