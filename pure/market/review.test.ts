import { describe, expect, test } from "bun:test";
import { err } from "../kernel/core/result.ts";
import { cancel, openBook, place } from "./book.ts";
import { LIMITS, MARKET, must, newBook, orderOf, placeAll } from "./fixtures.ts";
import { orderId, owner, type Market } from "./model.ts";
import { executions } from "./settlement.ts";

// Reviewer B of PR 92: refusals that the walk never draws together, the amount checks the walk's market cannot reach,
// and the one sum no single order's check covers.

const fault = (result: ReturnType<typeof place>) => (result.ok ? expect.unreachable("admitted") : result.error);

describe("market/book review: which refusal wins", () => {
  const book = placeAll(newBook(), [{ id: "a", who: "ann", side: "sell", price: 12n, lots: 1n }]);

  test("R-BOOK-NO-SILENT-DROP an order with no lots and no price is named for its lots first", () => {
    const refused = place(book, orderOf({ id: "t", who: "bob", side: "buy", price: 0n, lots: 0n }));
    expect(fault(refused)).toEqual({ _tag: "bad_lots", lots: 0n });
  });

  test("R-BOOK-NO-SILENT-DROP amounts that do not fit are named first", () => {
    const huge = 2n ** 250n;
    const refused = place(book, orderOf({ id: "a", who: "bob", side: "buy", price: huge, lots: huge }));
    expect(fault(refused)).toEqual({ _tag: "amount_too_large" });
  });

  test("R-BOOK-NO-SILENT-DROP a repeated id is named before a full book", () => {
    const one = { id: "a", who: "ann", side: "sell" as const, price: 12n, lots: 1n };
    const small = placeAll(newBook({ maxOrders: 1, maxPerOwner: 1 }), [one]);
    const refused = place(small, orderOf({ id: "a", who: "bob", side: "buy", price: 1n, lots: 1n }));
    expect(fault(refused)).toEqual({ _tag: "duplicate_order", id: orderId("a") });
  });
});

describe("market/book review: amounts", () => {
  test("R-BOOK-EXACT-AMOUNTS the quote leg is checked with the tick in a coarse market", () => {
    const coarse: Market = { ...MARKET, baseLot: 1n, quoteTick: 2n ** 200n };
    const book = must(openBook(coarse, LIMITS));
    const refused = place(book, orderOf({ id: "t", who: "bob", side: "buy", price: 2n ** 60n, lots: 2n ** 20n }));
    expect(fault(refused)).toEqual({ _tag: "amount_too_large" });
  });

  test("R-BOOK-EXACT-AMOUNTS a taker whose fills together move more than a uint256 is refused", () => {
    const market: Market = { ...MARKET, baseLot: 1n, quoteTick: 2n };
    const bids = placeAll(must(openBook(market, LIMITS)), [
      { id: "b1", who: "bob", side: "buy", price: 2n ** 254n, lots: 1n },
      { id: "b2", who: "cat", side: "buy", price: 2n ** 254n, lots: 1n },
    ]);
    const seller = orderOf({ id: "t", who: "dan", side: "sell", price: 1n, lots: 2n, terms: "immediate" });
    expect(place(bids, seller)).toEqual(err({ _tag: "amount_too_large" }));
    const one = orderOf({ id: "u", who: "dan", side: "sell", price: 1n, lots: 1n, terms: "immediate" });
    expect(executions(market, one, must(place(bids, one))).at(-1)?.gets.amount).toBe(2n ** 255n);
  });

  test("R-BOOK-EXACT-AMOUNTS fills that together move exactly the largest uint256 are accepted", () => {
    const market: Market = { ...MARKET, baseLot: 1n, quoteTick: 1n };
    const bids = placeAll(must(openBook(market, LIMITS)), [
      { id: "b1", who: "bob", side: "buy", price: 2n ** 255n, lots: 1n },
      { id: "b2", who: "cat", side: "buy", price: 2n ** 255n - 1n, lots: 1n },
    ]);
    const seller = orderOf({ id: "t", who: "dan", side: "sell", price: 1n, lots: 2n, terms: "immediate" });
    expect(executions(market, seller, must(place(bids, seller))).at(-1)?.gets.amount).toBe(2n ** 256n - 1n);
  });
});

describe("market/book review: cancel", () => {
  test("R-BOOK-CANCEL-OWN only the exact owner cancels: a name that starts the same is not the owner", () => {
    const book = placeAll(newBook(), [{ id: "x", who: "bobby", side: "sell", price: 12n, lots: 1n }]);
    const taken = cancel(book, { id: orderId("x"), owner: owner("bob") });
    expect(taken).toEqual(err({ _tag: "not_owner", id: orderId("x") }));
    expect(cancel(book, { id: orderId("x"), owner: owner("bobby") }).ok).toBe(true);
  });
});
