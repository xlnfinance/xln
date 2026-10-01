import { describe, expect, test } from "bun:test";
import { err } from "../kernel/core/result.ts";
import { cancel, openBook, place } from "./book.ts";
import { LIMITS, MARKET, QUOTE, BASE, must, newBook, orderOf, placeAll } from "./fixtures.ts";
import { orderId, owner, type Book } from "./model.ts";
import { clauseOf, executions } from "./settlement.ts";

const ask = (id: string, who: string, price: bigint, lots: bigint) => ({ id, who, side: "sell" as const, price, lots });
const bid = (id: string, who: string, price: bigint, lots: bigint) => ({ id, who, side: "buy" as const, price, lots });

const idsOf = (rows: readonly { id: string }[]): readonly string[] => rows.map((r) => r.id);

/** Three sellers: a at 12, b at 11, c at 12, in that order of arrival. */
const sellers: Book =
  placeAll(newBook(), [ask("a", "ann", 12n, 4n), ask("b", "bob", 11n, 3n), ask("c", "cat", 12n, 5n)]);

describe("market/book price-time priority", () => {
  test("R-BOOK-PRICE-TIME the best price fills first, and the earlier offer first within a price", () => {
    expect(idsOf(sellers.sells)).toEqual(["b", "a", "c"]);
    const placed = must(place(sellers, orderOf(bid("t", "dan", 12n, 10n))));
    expect(placed.fills.map((f) => [String(f.maker.order), f.lots, f.price]))
      .toEqual([["b", 3n, 11n], ["a", 4n, 12n], ["c", 3n, 12n]]);
  });

  test("R-BOOK-PRICE-TIME a trade is at the resting offer's price, so the taker gets any improvement", () => {
    const placed = must(place(sellers, orderOf(bid("t", "dan", 20n, 1n))));
    expect(placed.fills.map((f) => f.price)).toEqual([11n]);
  });

  test("R-BOOK-PRICE-TIME a seller meets the highest bids first, and a bid below its limit is out of reach", () => {
    const buyers = placeAll(newBook(), [bid("x", "ann", 9n, 2n), bid("y", "bob", 10n, 2n), bid("z", "cat", 8n, 2n)]);
    expect(idsOf(buyers.buys)).toEqual(["y", "x", "z"]);
    const placed = must(place(buyers, orderOf(ask("t", "dan", 9n, 5n))));
    expect(placed.fills.map((f) => [String(f.maker.order), f.price])).toEqual([["y", 10n], ["x", 9n]]);
    expect(placed.unfilled).toEqual({ _tag: "rested", lots: 1n });
    expect(idsOf(placed.book.sells)).toEqual(["t"]);
    expect(idsOf(placed.book.buys)).toEqual(["z"]);
  });

  test("R-BOOK-PRICE-TIME a resting order joins behind the equal prices and in front of the worse ones", () => {
    const book = placeAll(newBook(), [
      bid("p", "ann", 10n, 1n), bid("q", "bob", 12n, 1n), bid("r", "cat", 10n, 1n), bid("s", "dan", 11n, 1n),
    ]);
    expect(idsOf(book.buys)).toEqual(["q", "s", "p", "r"]);
  });
});

describe("market/book lots", () => {
  test("R-BOOK-LOTS-CONSERVED a partial fill leaves the maker's rest in place, at the front of its price", () => {
    const placed = must(place(sellers, orderOf(bid("t", "dan", 11n, 2n))));
    expect(placed.fills).toEqual([{
      price: 11n, lots: 2n, maker: { owner: owner("bob"), order: orderId("b") },
      taker: { owner: owner("dan"), order: orderId("t"), side: "buy" }, makerLotsLeft: 1n,
    }]);
    expect(placed.unfilled).toEqual({ _tag: "none" });
    expect(placed.book.sells.map((r) => [String(r.id), r.lots])).toEqual([["b", 1n], ["a", 4n], ["c", 5n]]);
  });

  test("R-BOOK-LOTS-CONSERVED a taker's unfilled lots rest, and the fills plus the rest are the order", () => {
    const placed = must(place(sellers, orderOf(bid("t", "dan", 12n, 20n))));
    const filled = placed.fills.reduce((sum, f) => sum + f.lots, 0n);
    expect(filled).toBe(12n);
    expect(placed.unfilled).toEqual({ _tag: "rested", lots: 8n });
    expect(placed.book.sells).toEqual([]);
    expect(placed.book.buys.map((r) => [String(r.id), r.lots])).toEqual([["t", 8n]]);
  });

  test("R-BOOK-LOTS-CONSERVED an offer that fills exactly leaves the book", () => {
    const placed = must(place(sellers, orderOf(bid("t", "dan", 11n, 3n))));
    expect(idsOf(placed.book.sells)).toEqual(["a", "c"]);
  });
});

describe("market/book terms", () => {
  test("R-BOOK-NO-SILENT-DROP an immediate order drops what it cannot trade, and says why", () => {
    const placed = must(place(sellers, orderOf({ ...bid("t", "dan", 11n, 5n), terms: "immediate" })));
    expect(placed.fills.map((f) => f.lots)).toEqual([3n]);
    expect(placed.unfilled).toEqual({ _tag: "dropped", lots: 2n, why: "no_liquidity" });
    expect(placed.book.buys).toEqual([]);
  });

  test("R-BOOK-ALL-OR-NOTHING an order that cannot fill whole is refused with what it could fill", () => {
    const refused = place(sellers, orderOf({ ...bid("t", "dan", 11n, 5n), terms: "all_or_nothing" }));
    expect(refused).toEqual(err({ _tag: "not_fillable", lots: 5n, fillable: 3n }));
    const whole = must(place(sellers, orderOf({ ...bid("t", "dan", 11n, 3n), terms: "all_or_nothing" })));
    expect(whole.unfilled).toEqual({ _tag: "none" });
  });

  test("R-BOOK-NO-SELF-TRADE a taker never trades with its own offer: it stops there and the rest is dropped", () => {
    const book = placeAll(newBook(), [ask("b", "bob", 10n, 2n), ask("a", "ann", 11n, 2n), ask("c", "cat", 12n, 2n)]);
    const placed = must(place(book, orderOf({ ...bid("t", "ann", 12n, 6n), terms: "rest" })));
    expect(placed.fills.map((f) => [f.maker.owner, f.maker.order])).toEqual([[owner("bob"), orderId("b")]]);
    expect(placed.unfilled).toEqual({ _tag: "dropped", lots: 4n, why: "own_order" });
    expect(idsOf(placed.book.sells)).toEqual(["a", "c"]);
    expect(placed.book.buys).toEqual([]);
    const sweptLast = executions(MARKET, orderOf({ ...bid("t", "ann", 12n, 6n), terms: "rest" }), placed).at(-1);
    expect(sweptLast?.after).toEqual({ _tag: "withdrawn", why: "own_order" });
    const first = must(place(book, orderOf(bid("u", "bob", 12n, 1n))));
    expect(first.fills).toEqual([]);
    expect(first.unfilled).toEqual({ _tag: "dropped", lots: 1n, why: "own_order" });
  });

  test("R-BOOK-NO-SELF-TRADE an all-or-nothing order that would meet itself is refused", () => {
    const book = placeAll(newBook(), [ask("a", "ann", 10n, 2n)]);
    const refused = place(book, orderOf({ ...bid("t", "ann", 12n, 2n), terms: "all_or_nothing" }));
    expect(refused).toEqual(err({ _tag: "not_fillable", lots: 2n, fillable: 0n }));
  });
});

describe("market/book admission", () => {
  const faultOf = (book: Book, draft: Parameters<typeof orderOf>[0]) => {
    const placed = place(book, orderOf(draft));
    return placed.ok ? expect.unreachable("admitted") : placed.error;
  };

  test("R-BOOK-NO-SILENT-DROP R-BOOK-EXACT-AMOUNTS an order has lots, a price, and amounts that fit a uint256", () => {
    expect(faultOf(sellers, bid("t", "dan", 12n, 0n))).toEqual({ _tag: "bad_lots", lots: 0n });
    expect(faultOf(sellers, bid("t", "dan", 0n, 1n))).toEqual({ _tag: "bad_price", price: 0n });
    expect(faultOf(sellers, bid("t", "dan", 1n, 2n ** 256n))).toEqual({ _tag: "amount_too_large" });
    expect(faultOf(sellers, bid("t", "dan", 2n ** 250n, 2n ** 250n))).toEqual({ _tag: "amount_too_large" });
    const biggest = 2n ** 256n - 1n;
    expect(place(sellers, orderOf({ ...bid("t", "dan", biggest, 1n), terms: "immediate" })).ok).toBe(true);
    expect(faultOf(sellers, bid("t", "dan", biggest + 1n, 1n))).toEqual({ _tag: "amount_too_large" });
    expect(place(sellers, orderOf({ ...bid("t", "dan", 1n, biggest / 1000n), terms: "immediate" })).ok).toBe(true);
    expect(faultOf(sellers, bid("t", "dan", 1n, biggest / 1000n + 1n))).toEqual({ _tag: "amount_too_large" });
    const unit = must(openBook({ ...MARKET, baseLot: 1n }, LIMITS));
    expect(place(unit, orderOf({ ...bid("t", "dan", 1n, biggest), terms: "immediate" })).ok).toBe(true);
  });

  test("R-BOOK-NO-SILENT-DROP an id names one offer in the book", () => {
    expect(faultOf(sellers, bid("b", "dan", 1n, 1n))).toEqual({ _tag: "duplicate_order", id: orderId("b") });
  });

  test("R-BOOK-BOUNDED an owner holds at most maxPerOwner offers, and the book at most maxOrders", () => {
    const small = must(openBook(MARKET, { maxOrders: 3, maxPerOwner: 2 }));
    const two = placeAll(small, [bid("a", "ann", 1n, 1n), bid("b", "ann", 2n, 1n)]);
    expect(faultOf(two, bid("c", "ann", 3n, 1n))).toEqual({ _tag: "owner_full", max: 2 });
    const full = placeAll(two, [bid("c", "bob", 1n, 1n)]);
    expect(faultOf(full, bid("d", "cat", 1n, 1n))).toEqual({ _tag: "book_full", max: 3 });
  });

  test("R-BOOK-BOUNDED an order that cannot rest needs no room, and a cancel gives the room back", () => {
    const small = must(openBook(MARKET, { maxOrders: 1, maxPerOwner: 1 }));
    const one = placeAll(small, [ask("a", "ann", 10n, 1n)]);
    const taker = place(one, orderOf({ ...bid("t", "bob", 10n, 1n), terms: "immediate" }));
    expect(taker.ok && taker.value.book.sells).toEqual([]);
    const freed = must(cancel(one, { id: orderId("a"), owner: owner("ann") })).book;
    expect(place(freed, orderOf(bid("t", "ann", 1n, 1n))).ok).toBe(true);
  });

  test("a market names two tokens, positive steps and positive limits", () => {
    expect(openBook({ ...MARKET, quote: BASE }, LIMITS)).toEqual(err({ _tag: "same_token" }));
    expect(openBook({ ...MARKET, baseLot: 0n }, LIMITS)).toEqual(err({ _tag: "bad_step" }));
    expect(openBook({ ...MARKET, quoteTick: 0n }, LIMITS)).toEqual(err({ _tag: "bad_step" }));
    expect(openBook(MARKET, { ...LIMITS, maxOrders: 0 })).toEqual(err({ _tag: "bad_limits" }));
    expect(openBook(MARKET, { ...LIMITS, maxPerOwner: 0 })).toEqual(err({ _tag: "bad_limits" }));
  });
});

describe("market/book cancel", () => {
  test("R-BOOK-CANCEL-OWN only the owner takes an offer back, and what it took is returned", () => {
    const by = (id: string, who: string) => cancel(sellers, { id: orderId(id), owner: owner(who) });
    expect(by("a", "bob")).toEqual(err({ _tag: "not_owner", id: orderId("a") }));
    expect(by("zz", "ann")).toEqual(err({ _tag: "no_such_order", id: orderId("zz") }));
    const taken = must(cancel(sellers, { id: orderId("a"), owner: owner("ann") }));
    expect(taken.cancelled).toEqual({ id: orderId("a"), owner: owner("ann"), side: "sell", price: 12n, lots: 4n });
    expect(idsOf(taken.book.sells)).toEqual(["b", "c"]);
  });
});

describe("market/settlement", () => {
  const exec = (book: Book, draft: Parameters<typeof orderOf>[0]) => {
    const order = orderOf(draft);
    return executions(MARKET, order, must(place(book, order)));
  };
  const base = (amount: bigint) => ({ token: BASE, amount });
  const quote = (amount: bigint) => ({ token: QUOTE, amount });

  test("R-BOOK-EXACT-AMOUNTS a buyer gives quote and gets base at the maker's price, each leg exact", () => {
    const [maker, taker] = exec(sellers, bid("t", "dan", 12n, 2n));
    expect(maker).toEqual({
      owner: owner("bob"), order: orderId("b"), gives: base(2000n), gets: quote(22n),
      after: { _tag: "open", clause: { gives: base(1000n), wants: quote(11n) } },
    });
    expect(taker).toEqual({
      owner: owner("dan"), order: orderId("t"), gives: quote(22n), gets: base(2000n), after: { _tag: "filled" },
    });
  });

  test("R-BOOK-EXACT-AMOUNTS the steps scale the amounts, and a clause is its lots at its own price", () => {
    const wide = { ...MARKET, baseLot: 10_000n, quoteTick: 7n };
    expect(clauseOf(wide, { side: "sell", price: 12n, lots: 5n }))
      .toEqual({ gives: base(50_000n), wants: quote(5n * 12n * 7n) });
    expect(clauseOf(wide, { side: "buy", price: 12n, lots: 5n }))
      .toEqual({ gives: quote(5n * 12n * 7n), wants: base(50_000n) });
  });

  test("R-BOOK-CLAUSE-LOCKSTEP a partial fill re-signs the clause of the lots left, and a full fill drops it", () => {
    const [partial] = exec(sellers, bid("t", "dan", 12n, 1n));
    const left = clauseOf(MARKET, { side: "sell", price: 11n, lots: 2n });
    expect(partial?.after).toEqual({ _tag: "open", clause: left });
    const [whole] = exec(sellers, bid("t", "dan", 12n, 3n));
    expect(whole?.after).toEqual({ _tag: "filled" });
  });

  test("R-BOOK-CLAUSE-LOCKSTEP a taker that rests keeps a clause for what is left, at its own limit price", () => {
    const taker = exec(sellers, bid("t", "dan", 12n, 20n)).at(-1);
    expect(taker?.after).toEqual({ _tag: "open", clause: clauseOf(MARKET, { side: "buy", price: 12n, lots: 8n }) });
    expect(taker?.gives).toEqual(quote(3n * 11n + 4n * 12n + 5n * 12n));
  });

  test("R-BOOK-CLAUSE-LOCKSTEP a dropped remainder withdraws the clause, with its reason", () => {
    const taker = exec(sellers, { ...bid("t", "dan", 11n, 5n), terms: "immediate" }).at(-1);
    expect(taker?.after).toEqual({ _tag: "withdrawn", why: "no_liquidity" });
    const none = exec(newBook(), { ...bid("t", "dan", 11n, 5n), terms: "immediate" });
    expect(none).toEqual([{
      owner: owner("dan"), order: orderId("t"), gives: quote(0n), gets: base(0n),
      after: { _tag: "withdrawn", why: "no_liquidity" },
    }]);
  });

  test("R-BOOK-EXACT-AMOUNTS what the parties give in each token is what they get in it", () => {
    const placed = exec(sellers, bid("t", "dan", 12n, 10n));
    const total = (pick: (e: (typeof placed)[number]) => { token: bigint; amount: bigint }, token: bigint) =>
      placed.filter((e) => pick(e).token === token).reduce((sum, e) => sum + pick(e).amount, 0n);
    expect(total((e) => e.gives, BASE)).toBe(total((e) => e.gets, BASE));
    expect(total((e) => e.gives, QUOTE)).toBe(total((e) => e.gets, QUOTE));
    expect(total((e) => e.gives, BASE)).toBe(10_000n);
  });
});
