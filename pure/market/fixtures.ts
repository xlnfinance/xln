// What the market tests share: one market (USDC against USDT, as the rig's order book draws use), a book that holds it,
// and orders written by their names. Only tests import this.
import { expect } from "bun:test";
import { tokenOf } from "../account/fixtures.ts";
import { unwrapOr, type Result } from "../kernel/core/result.ts";
import { openBook, place } from "./book.ts";
import { orderId, owner, type Book, type Limits, type Market, type Order } from "./model.ts";

export const BASE = tokenOf(1n);
export const QUOTE = tokenOf(3n);

/** A lot is 1000 base units and a tick is 1 quote unit per lot, so a fill of 5 lots at price 12 moves 5000 and 60. */
export const MARKET: Market = { base: BASE, quote: QUOTE, baseLot: 1000n, quoteTick: 1n };
export const LIMITS: Limits = { maxOrders: 64, maxPerOwner: 8 };

/** Unwraps a result a test expects to be ok, and names the refusal when it is not. */
export const must = <T, E extends { readonly _tag: string }>(r: Result<T, E>): T =>
  unwrapOr(r, (fault) => expect.unreachable(`refused: ${fault._tag}`));

export const newBook = (limits: Limits = LIMITS): Book => must(openBook(MARKET, limits));

export type Draft = Readonly<{
  id: string; who: string; side: Order["side"]; price: bigint; lots: bigint; terms?: Order["terms"];
}>;

export const orderOf = (draft: Draft): Order => ({
  id: orderId(draft.id), owner: owner(draft.who), side: draft.side, price: draft.price, lots: draft.lots,
  terms: draft.terms ?? "rest",
});

export const placeAll = (book: Book, drafts: readonly Draft[]): Book =>
  drafts.reduce((b, d) => must(place(b, orderOf(d))).book, book);
