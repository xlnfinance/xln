import { describe, expect, test } from "bun:test";
import { lcg31, seedOf, seedTag } from "../diff/seed.ts";
import { bump } from "../kernel/core/collections.ts";
import { mapAccum } from "../kernel/core/result.ts";
import { cancel, openBook, place } from "./book.ts";
import { MARKET, must, orderOf, type Draft } from "./fixtures.ts";
import { orderId, owner, type Book, type Limits, type Market, type Order, type Placed } from "./model.ts";
import {
  emptyModel, modelCancel, modelPlace, modelSide, tradeOf, type Expected, type Model,
} from "./oracle.ts";
import { executions, clauseOf, type Execution } from "./settlement.ts";

// The walk: a seeded stream of orders and cancels against the book and, side by side, the naive oracle. After every
// step the book must agree with the oracle, hold its own invariants, and name the same refusal or the same remainder.
// Small limits and a narrow price range make every outcome common: crossing, partial fills, own orders, full books.

/** A tick of 7 and a lot of 1000, so no leg can pass for its lots by accident. */
const WALK_MARKET: Market = { ...MARKET, quoteTick: 7n };
const WALK_LIMITS: Limits = { maxOrders: 12, maxPerOwner: 5 };
const OWNERS = ["o0", "o1", "o2", "o3"] as const;
const SEED_BASE = 0x3a17;
const NOMINAL = 600;
const CAP = 12_000;

/** Eight draws of 20 bits each from the stream: what one step needs. */
const draws = (seed: number): readonly [number, readonly number[]] =>
  mapAccum(Array.from({ length: 8 }), seed, (s) => [lcg31(s), lcg31(s) >>> 11] as const);

type Step =
  | Readonly<{ kind: "place"; draft: Draft }>
  | Readonly<{ kind: "cancel"; id: string; who: string }>;

const termsOf = (roll: number): Order["terms"] => {
  if (roll < 60) return "rest";
  return roll < 85 ? "immediate" : "all_or_nothing";
};

const stepOf = (raw: readonly number[], i: number, book: Book): Step => {
  const at = (k: number): number => raw[k] ?? 0;
  const open = [...book.buys, ...book.sells];
  const target = open[at(6) % Math.max(open.length, 1)];
  const oddity = at(7) % 100;
  const who = OWNERS[at(1) % OWNERS.length] ?? "o0";
  if (at(0) % 100 >= 85) {
    const id = at(6) % 7 === 0 ? "ghost" : (target?.id ?? "ghost");
    return { kind: "cancel", id, who: at(5) % 5 === 0 ? who : (target?.owner ?? who) };
  }
  return {
    kind: "place",
    draft: {
      id: oddity < 3 && target !== undefined ? target.id : `n${i}`,
      who,
      side: at(2) % 2 === 0 ? "buy" : "sell",
      price: oddity >= 3 && oddity < 5 ? 0n : BigInt(8 + (at(3) % 7)),
      lots: oddity >= 5 && oddity < 7 ? 0n : BigInt(1 + (at(4) % 6)),
      terms: termsOf(at(5) % 100),
    },
  };
};

type Walk = Readonly<{ seed: number; i: number; book: Book; model: Model; seen: ReadonlyMap<string, bigint> }>;

const start = (seed: number): Walk =>
  ({
    seed, i: 0, book: must(openBook(WALK_MARKET, WALK_LIMITS)), model: emptyModel(WALK_MARKET, WALK_LIMITS),
    seen: new Map(),
  });

const sameBook = (book: Book, model: Model): void => {
  expect(book.buys).toEqual(modelSide(model, "buy"));
  expect(book.sells).toEqual(modelSide(model, "sell"));
};

const neverCrossed = (book: Book): void => {
  const buy = book.buys[0];
  const sell = book.sells[0];
  if (buy !== undefined && sell !== undefined) expect(buy.price).toBeLessThan(sell.price);
};

const bounded = (book: Book): void => {
  const all = [...book.buys, ...book.sells];
  expect(all.length).toBeLessThanOrEqual(WALK_LIMITS.maxOrders);
  const held = (o: string): number => all.filter((r) => r.owner === owner(o)).length;
  OWNERS.forEach((o) => expect(held(o)).toBeLessThanOrEqual(WALK_LIMITS.maxPerOwner));
  expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
};

/** Every fill is the maker's price, within the taker's limit, between two owners. */
const fillsAreSound = (order: Order, placed: Placed): void =>
  placed.fills.forEach((fill) => {
    const reachable = order.side === "buy" ? fill.price <= order.price : fill.price >= order.price;
    expect(reachable).toBe(true);
    expect(fill.maker.owner).not.toBe(fill.taker.owner);
  });

const tokenTotal = (xs: readonly Execution[], pick: "gives" | "gets", token: bigint): bigint =>
  xs.filter((x) => x[pick].token === token).reduce((sum, x) => sum + x[pick].amount, 0n);

/** The parties give in each token exactly what they get in it, and every clause left is its open lots in the book. */
const executionsAreSound = (order: Order, placed: Placed): void => {
  const xs = executions(WALK_MARKET, order, placed);
  [WALK_MARKET.base, WALK_MARKET.quote].forEach((token) =>
    expect(tokenTotal(xs, "gives", token)).toBe(tokenTotal(xs, "gets", token)));
  xs.forEach((x) => {
    const open = [...placed.book.buys, ...placed.book.sells].find((r) => r.id === x.order);
    if (x.remaining._tag !== "open") return expect(open).toBeUndefined();
    const offer = open ?? expect.unreachable("an open clause has its offer in the book");
    expect(x.remaining.clause).toEqual(clauseOf(WALK_MARKET, offer));
  });
};

const lotsAddUp = (order: Order, placed: Placed): void => {
  const filled = placed.fills.reduce((sum, f) => sum + f.lots, 0n);
  const rest = placed.remainder._tag === "none" ? 0n : placed.remainder.lots;
  expect(filled + rest).toBe(order.lots);
};

const placeStep = (w: Walk, draft: Draft): Walk => {
  const order = orderOf(draft);
  const expected: Expected = modelPlace(w.model, order);
  const placed = place(w.book, order);
  if ("refused" in expected) {
    expect(placed.ok ? "admitted" : placed.error._tag).toBe(expected.refused);
    return { ...w, seen: bump(w.seen, `refused:${expected.refused}`, 1n) };
  }
  const value = must(placed);
  expect(value.fills.map(tradeOf)).toEqual([...expected.trades]);
  expect(value.remainder).toEqual(expected.remainder);
  sameBook(value.book, expected.model);
  neverCrossed(value.book);
  bounded(value.book);
  fillsAreSound(order, value);
  executionsAreSound(order, value);
  lotsAddUp(order, value);
  const why = value.remainder._tag === "dropped" ? `:${value.remainder.why}` : "";
  const partial = value.fills.some((f) => f.makerLotsLeft > 0n) ? "partial" : "whole";
  const fills = value.fills.length > 0 ? partial : "none";
  return {
    ...w, book: value.book, model: expected.model,
    seen: bump(bump(w.seen, `remainder:${value.remainder._tag}${why}`, 1n), `fills:${fills}`, 1n),
  };
};

const cancelStep = (w: Walk, id: string, who: string): Walk => {
  const expected = modelCancel(w.model, id, who);
  const taken = cancel(w.book, { id: orderId(id), owner: owner(who) });
  if (typeof expected === "string") {
    expect(taken.ok ? "cancelled" : taken.error._tag).toBe(expected);
    return { ...w, seen: bump(w.seen, `refused:${expected}`, 1n) };
  }
  const value = must(taken);
  sameBook(value.book, expected);
  return { ...w, book: value.book, model: expected, seen: bump(w.seen, "cancelled", 1n) };
};

const advance = (w: Walk): Walk => {
  const [seed, raw] = draws(w.seed);
  const step = stepOf(raw, w.i, w.book);
  const next = step.kind === "place" ? placeStep(w, step.draft) : cancelStep(w, step.id, step.who);
  return { ...next, seed, i: w.i + 1 };
};

/** Every outcome the walk is for must have happened; the walk runs on past its nominal length until they have. */
const OUTCOMES = [
  "refused:duplicate_order", "refused:bad_lots", "refused:bad_price", "refused:owner_full", "refused:book_full",
  "refused:not_fillable", "refused:no_such_order", "refused:not_owner", "cancelled", "remainder:none",
  "remainder:rested", "remainder:dropped:no_liquidity", "remainder:dropped:own_order", "fills:partial", "fills:whole",
] as const;

const covered = (w: Walk): boolean => OUTCOMES.every((k) => (w.seen.get(k) ?? 0n) > 0n);

const run = (w: Walk): Walk => (w.i < NOMINAL || (w.i < CAP && !covered(w)) ? run(advance(w)) : w);

describe(seedTag("market walk"), () => {
  test("R-BOOK-PRICE-TIME R-BOOK-NEVER-CROSSED R-BOOK-CLAUSE-LOCKSTEP the book matches the oracle", () => {
    const end = run(start(seedOf(SEED_BASE)));
    expect(OUTCOMES.filter((k) => (end.seen.get(k) ?? 0n) === 0n)).toEqual([]);
  });
});
