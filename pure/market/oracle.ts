// A second, naive book for the walk to compare with: no sorted queues, only a list of open offers, each with the number
// of its arrival, sorted again in full whenever an order comes. It decides the same things `place` and `cancel` decide,
// by the plain statement of price-time priority, and it shares none of the engine's structure. Only tests import this.
import { MAX_AMOUNT } from "../account/ledger.ts";
import {
  orderId, type CancelFault, type Fill, type Limits, type Market, type Order, type PlaceFault, type Remainder,
  type Resting,
} from "./model.ts";

type Open = Readonly<{ offer: Resting; arrival: number }>;

export type Model = Readonly<{ market: Market; limits: Limits; open: readonly Open[]; arrivals: number }>;

export const emptyModel = (market: Market, limits: Limits): Model => ({ market, limits, open: [], arrivals: 0 });

/** What a fill is, for comparing: who was met, how many lots, at what price. */
export type Trade = readonly [string, bigint, bigint];

export const tradeOf = (fill: Fill): Trade => [fill.maker.order, fill.lots, fill.price];

export type Expected =
  | Readonly<{ refused: PlaceFault["_tag"] }>
  | Readonly<{ model: Model; trades: readonly Trade[]; remainder: Remainder }>;

/** Best first: the better price, then the earlier arrival. */
const ahead = (side: Order["side"]) => (a: Open, b: Open): number => {
  if (a.offer.price === b.offer.price) return a.arrival - b.arrival;
  const aBetter = side === "buy" ? a.offer.price > b.offer.price : a.offer.price < b.offer.price;
  return aBetter ? -1 : 1;
};

const refusal = (m: Model, order: Order): PlaceFault["_tag"] | undefined => {
  if (order.lots < 1n) return "bad_lots";
  if (order.price < 1n) return "bad_price";
  if (order.lots * m.market.baseLot > MAX_AMOUNT || order.lots * order.price * m.market.quoteTick > MAX_AMOUNT) {
    return "amount_too_large";
  }
  if (m.open.some((o) => o.offer.id === order.id)) return "duplicate_order";
  return undefined;
};

/** Room is judged on the offers left after the order's own trades: only a resting remainder needs a place. */
const roomRefusal = (m: Model, open: readonly Open[], order: Order): PlaceFault["_tag"] | undefined => {
  if (open.filter((o) => o.offer.owner === order.owner).length >= m.limits.maxPerOwner) return "owner_full";
  return open.length >= m.limits.maxOrders ? "book_full" : undefined;
};

type Run = Readonly<{ left: bigint; trades: readonly Trade[]; stopped: "own" | "reach" | undefined }>;

const meet = (order: Order) => (run: Run, c: Open): Run => {
  if (run.left === 0n || run.stopped !== undefined) return run;
  const reached = order.side === "buy" ? c.offer.price <= order.price : c.offer.price >= order.price;
  if (!reached) return { ...run, stopped: "reach" };
  if (c.offer.owner === order.owner) return { ...run, stopped: "own" };
  const lots = run.left < c.offer.lots ? run.left : c.offer.lots;
  return { left: run.left - lots, trades: [...run.trades, [c.offer.id, lots, c.offer.price]], stopped: undefined };
};

const afterTrades = (open: readonly Open[], trades: readonly Trade[]): readonly Open[] =>
  open.flatMap((o) => {
    const taken = trades.filter(([id]) => id === o.offer.id).reduce((sum, [, lots]) => sum + lots, 0n);
    return taken === o.offer.lots ? [] : [{ ...o, offer: { ...o.offer, lots: o.offer.lots - taken } }];
  });

const remainderOf = (run: Run, how: Readonly<{ resting: boolean }>): Remainder => {
  if (run.left === 0n) return { _tag: "none" };
  if (how.resting) return { _tag: "rested", lots: run.left };
  return { _tag: "dropped", lots: run.left, why: run.stopped === "own" ? "own_order" : "no_liquidity" };
};

export const modelPlace = (m: Model, order: Order): Expected => {
  const refused = refusal(m, order);
  if (refused !== undefined) return { refused };
  const against = order.side === "buy" ? "sell" : "buy";
  const candidates = m.open.filter((o) => o.offer.side === against).toSorted(ahead(against));
  const run = candidates.reduce(meet(order), { left: order.lots, trades: [], stopped: undefined });
  const quoteMoved = run.trades.reduce((sum, [, lots, price]) => sum + lots * price * m.market.quoteTick, 0n);
  if (quoteMoved > MAX_AMOUNT) return { refused: "amount_too_large" };
  if (order.terms === "all_or_nothing" && run.left > 0n) return { refused: "not_fillable" };
  const resting = order.terms === "rest" && run.stopped !== "own" && run.left > 0n;
  const left = afterTrades(m.open, run.trades);
  const noRoom = resting ? roomRefusal(m, left, order) : undefined;
  if (noRoom !== undefined) return { refused: noRoom };
  const offer: Resting = { id: order.id, owner: order.owner, side: order.side, price: order.price, lots: run.left };
  const arrived: readonly Open[] = resting ? [{ offer, arrival: m.arrivals }] : [];
  const open = [...left, ...arrived];
  const model = { ...m, open, arrivals: m.arrivals + 1 };
  return { model, trades: run.trades, remainder: remainderOf(run, { resting }) };
};

export const modelCancel = (m: Model, id: string, who: string): CancelFault["_tag"] | Model => {
  const found = m.open.find((o) => o.offer.id === orderId(id));
  if (found === undefined) return "no_such_order";
  return found.offer.owner === who ? { ...m, open: m.open.filter((o) => o !== found) } : "not_owner";
};

/** The open offers of one side, best first, as the book should hold them. */
export const modelSide = (m: Model, side: Order["side"]): readonly Resting[] =>
  m.open.filter((o) => o.offer.side === side).toSorted(ahead(side)).map((o) => o.offer);
