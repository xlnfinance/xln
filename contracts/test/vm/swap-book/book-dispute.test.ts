// R-BOOK-DISPUTE-HONORS: a dispute pays out what both sides believed, for the executions the hub's order book asks of an
// Account. The engine (pure/market) drives a seeded stream of orders; the Account of one owner is rebuilt from the
// Executions it received (moved offdeltas, the clause that remains), and from every state it passed through a dispute is
// run on the real Depository stack in BrowserVM. The hub supplies the taker's fill ratio live as the non-starter.
//   ratio 0      -> the owner is paid exactly what it already moved (the signed offdeltas)
//   ratio 65535  -> the owner is paid the moved amounts plus every open clause in full, at the owners' own prices
// "Believed" is computed from the book's resting offers, not from the clauses the engine produced.
// Run one file per process: `bun test contracts/test/vm/swap-book/book-dispute.test.ts` (SEEDX=n moves the stream).
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, type Party } from "../rig.ts";
import { BATCH_ABI } from "../../../../core/protocol/dispute/proof-body.ts";
import { lcg31, seedOf, seedTag } from "../../../../pure/diff/seed.ts";
import { cancel, openBook, place } from "../../../../pure/market/book.ts";
import { unwrapOr } from "../../../../pure/kernel/core/result.ts";
import { orderId, owner, type Book, type Market, type Order, type Resting } from "../../../../pure/market/model.ts";
import { executions, type Clause } from "../../../../pure/market/settlement.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const ARGS = "tuple(uint16[] fillRatios, bytes32[] secrets)";
const ratiosOf = (rs: readonly number[]): string => coder.encode(["bytes[]"], [[coder.encode([ARGS], [[rs, []]])]]);

const BASE = 1, QUOTE = 2; // token ids the rig registers (USDC, WETH)
const MARKET: Market = { base: BigInt(BASE) as never, quote: BigInt(QUOTE) as never, baseLot: 1000n, quoteTick: 7n };
const OWNERS = ["o0", "o1", "o2"] as const;
const COLLATERAL = 1_000_000_000n;
const STEPS = 28;

// ---- the owner's Account as the hub keeps it: moved amounts by token and the open clauses by order ----
type Moves = Readonly<Record<number, bigint>>;
type Clauses = ReadonlyMap<string, Clause>;
type State = Readonly<{ moves: Moves; clauses: Clauses; believedExtra: Moves }>;

const add = (m: Moves, token: number, amount: bigint): Moves => ({ ...m, [token]: (m[token] ?? 0n) + amount });

/** What the book itself says an owner's open offers would move if every one were filled at its own price. */
const believedExtra = (book: Book, who: string): Moves =>
  [...book.buys, ...book.sells].filter((r) => r.owner === who).reduce<Moves>((acc, r: Resting) => {
    const base = r.lots * MARKET.baseLot, quote = r.lots * r.price * MARKET.quoteTick;
    return r.side === "sell" ? add(add(acc, BASE, -base), QUOTE, quote) : add(add(acc, BASE, base), QUOTE, -quote);
  }, {});

type Snapshot = Readonly<{ who: string; label: string; state: State }>;

const lcgStream = (seed: number, n: number): readonly number[] => {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) { s = lcg31(s); out.push(s >>> 11); }
  return out;
};

/** Runs the book and returns every state each owner's Account passed through. */
const history = (seed: number): readonly Snapshot[] => {
  let book = unwrapOr(openBook(MARKET, { maxOrders: 12, maxPerOwner: 4 }), () => { throw new Error("open"); });
  const states = new Map<string, State>(OWNERS.map((o) => [o, { moves: {}, clauses: new Map(), believedExtra: {} }]));
  const snaps: Snapshot[] = [];
  const draws = lcgStream(seed, STEPS * 6);
  const snap = (who: string, label: string) => {
    const s = states.get(who)!;
    snaps.push({ who, label, state: { ...s, believedExtra: believedExtra(book, who) } });
  };
  for (let i = 0; i < STEPS; i++) {
    const r = draws.slice(i * 6, i * 6 + 6);
    const who = OWNERS[r[0]! % OWNERS.length]!;
    if (r[1]! % 100 >= 88) {
      const mine = [...book.buys, ...book.sells].filter((o) => o.owner === who);
      const target = mine[r[2]! % Math.max(mine.length, 1)];
      if (target === undefined) continue;
      book = unwrapOr(cancel(book, { id: target.id, owner: owner(who) }), () => { throw new Error("cancel"); }).book;
      const s = states.get(who)!;
      const clauses = new Map(s.clauses);
      clauses.delete(String(target.id));
      states.set(who, { ...s, clauses });
      snap(who, `cancel ${target.id}`);
      continue;
    }
    const roll = r[3]! % 100;
    const order: Order = {
      id: orderId(`n${i}`), owner: owner(who), side: r[2]! % 2 === 0 ? "buy" : "sell",
      price: BigInt(8 + (r[4]! % 5)), lots: BigInt(1 + (r[5]! % 6)),
      terms: roll < 60 ? "rest" : roll < 85 ? "immediate" : "all_or_nothing",
    };
    const placed = place(book, order);
    if (!placed.ok) continue;
    book = placed.value.book;
    for (const x of executions(MARKET, order, placed.value)) {
      const s = states.get(String(x.owner))!;
      const moves = add(add(s.moves, Number(x.gives.token), -x.gives.amount), Number(x.gets.token), x.gets.amount);
      const clauses = new Map(s.clauses);
      if (x.after._tag === "open") clauses.set(String(x.order), x.after.clause);
      else clauses.delete(String(x.order));
      states.set(String(x.owner), { ...s, moves, clauses });
    }
    for (const who2 of new Set(executions(MARKET, order, placed.value).map((x) => String(x.owner)))) snap(who2, `place ${order.id}`);
  }
  return snaps;
};

// ---- one dispute on the real stack ----
type Rig = Awaited<ReturnType<typeof boot>>;
const hub = party("swap-book-hub");

type Outcome = Readonly<{ maker: Moves; hub: Moves; started: string; finalized: string }>;

const dispute = async (w: Rig, tag: string, wantLeft: boolean, state: State, ratio: number | "none"): Promise<Outcome> => {
  // a fresh maker whose id puts it on the wanted side of the hub
  const maker = ((): Party => { for (let k = 0; ; k++) { const p = party(`${tag}-m${k}`); if ((BigInt(p.id) < BigInt(hub.id)) === wantLeft) return p; } })();
  const acct = w.accountOf(maker, hub, tag);
  for (const p of [maker, hub]) for (const t of [BASE, QUOTE]) await w.chain.debugFundReserves(p.id, t, 10_000_000_000n);
  for (const t of [BASE, QUOTE]) {
    const r = await w.submit(acct.L, { reserveToCollateral: [{ tokenId: t, receivingEntity: acct.L.id, pairs: [{ entity: acct.R.id, amount: COLLATERAL }] }] });
    expect(r).toBe("ok");
  }
  const makerIsLeft = acct.L.id === maker.id;
  const sign = makerIsLeft ? 1n : -1n; // delta is Left's allocation
  const idx = (t: bigint): number => (Number(t) === BASE ? 0 : 1);
  const clauses = [...state.clauses.values()];
  const swaps = clauses.map((c) => ({
    ownerIsLeft: makerIsLeft, addDeltaIndex: idx(c.gives.token), addAmount: c.gives.amount,
    subDeltaIndex: idx(c.wants.token), subAmount: c.wants.amount,
  }));
  const allow = (i: number): bigint => clauses.reduce((s, c) => s + (idx(c.gives.token) === i ? c.gives.amount : 0n) + (idx(c.wants.token) === i ? c.wants.amount : 0n), 0n);
  const batch = coder.encode([ethers.ParamType.from(BATCH_ABI as never)], [{ payment: [], swap: swaps, pull: [] }]);
  const body = {
    ...acct.body(0n, 60), tokenIds: [BASE, QUOTE],
    offdeltas: [sign * (state.moves[BASE] ?? 0n), sign * (state.moves[QUOTE] ?? 0n)],
    transformers: clauses.length === 0 ? [] : [{
      transformerAddress: w.chain.addresses.deltaTransformer, encodedBatch: batch,
      allowances: [0, 1].map((i) => ({ deltaIndex: i, rightAllowance: allow(i), leftAllowance: allow(i) })),
    }],
  };
  const epoch = await acct.epochOf();
  const sig = acct.proofSig(hub, epoch, 1, makerIsLeft, body);
  const read = async (p: Party): Promise<readonly bigint[]> => [await w.chain.getReserves(p.id, BASE), await w.chain.getReserves(p.id, QUOTE)];
  const [mb, hb] = [await read(maker), await read(hub)];
  w.at(100);
  const started = await w.start(maker, hub, 1, makerIsLeft, body, sig);
  w.at(300);
  const args = ratio === "none" ? {} : { other: ratiosOf(clauses.map(() => ratio)) };
  const finalized = await w.finalize(hub, maker, { nonce: 1, body, startedByLeft: makerIsLeft }, { nonce: 1, proposerIsLeft: makerIsLeft, body, sig: "0x" }, args);
  const [ma, ha] = [await read(maker), await read(hub)];
  // the Left side's collateral comes back inside its reserve change; the other side's is whatever the split gives it
  const pos = (after: readonly bigint[], before: readonly bigint[], left: boolean): Moves =>
    ({ [BASE]: after[0]! - before[0]! - (left ? COLLATERAL : 0n), [QUOTE]: after[1]! - before[1]! - (left ? COLLATERAL : 0n) });
  return { maker: pos(ma, mb, makerIsLeft), hub: pos(ha, hb, !makerIsLeft), started, finalized };
};

describe(seedTag("swap-book on the real contracts"), () => {
  test("R-BOOK-DISPUTE-HONORS a dispute from any state the book put an Account in pays what both believed", async () => {
    const w = await boot("swap-book");
    const snaps = history(seedOf(0x5a91));
    expect(snaps.length).toBeGreaterThan(8);
    let sides = { left: 0, right: 0 };
    let withClause = 0;
    for (const [i, s] of snaps.entries()) {
      const wantLeft = i % 2 === 0;
      sides = wantLeft ? { ...sides, left: sides.left + 1 } : { ...sides, right: sides.right + 1 };
      const noFill = await dispute(w, `sb${i}a`, wantLeft, s.state, 0);
      expect(noFill.started).toBe("ok");
      expect(noFill.finalized).toBe("ok");
      // ratio 0: exactly what was moved, and the hub holds the mirror image
      expect(noFill.maker[BASE] ?? 0n).toBe(s.state.moves[BASE] ?? 0n);
      expect(noFill.maker[QUOTE] ?? 0n).toBe(s.state.moves[QUOTE] ?? 0n);
      expect(noFill.hub[BASE]).toBe(-noFill.maker[BASE]!);
      expect(noFill.hub[QUOTE]).toBe(-noFill.maker[QUOTE]!);
      if (s.state.clauses.size === 0) continue;
      withClause++;
      const full = await dispute(w, `sb${i}b`, wantLeft, s.state, 65535);
      expect(full.finalized).toBe("ok");
      expect(full.maker[BASE]).toBe((s.state.moves[BASE] ?? 0n) + (s.state.believedExtra[BASE] ?? 0n));
      expect(full.maker[QUOTE]).toBe((s.state.moves[QUOTE] ?? 0n) + (s.state.believedExtra[QUOTE] ?? 0n));
      expect(full.hub[BASE]).toBe(-full.maker[BASE]!);
      expect(full.hub[QUOTE]).toBe(-full.maker[QUOTE]!);
    }
    expect(withClause).toBeGreaterThan(4);
    expect(sides.left).toBeGreaterThan(0);
    expect(sides.right).toBeGreaterThan(0);
  }, 600_000);
});

// The contract's fill rule (math/WideMath.sol fill): floor(a * r / 65535), per leg.
const fill = (a: bigint, r: bigint): bigint => (a / 65535n) * r + ((a % 65535n) * r) / 65535n;

describe("swap-book partial ratios on the real contracts", () => {
  test("R-BOOK-DISPUTE-HONORS a taker's partial ratio rounds each leg down, and the engine's remainder clause never needs one", async () => {
    const w = await boot("swap-book-ratio");
    // ann sells 5 lots at 12: gives 5000 base, wants 5 * 12 * 7 = 420 quote
    const book = unwrapOr(openBook(MARKET, { maxOrders: 12, maxPerOwner: 4 }), () => { throw new Error("open"); });
    const order: Order = { id: orderId("a"), owner: owner("ann"), side: "sell", price: 12n, lots: 5n, terms: "rest" };
    const placed = unwrapOr(place(book, order), () => { throw new Error("place"); });
    const x = executions(MARKET, order, placed)[0]!;
    expect(x.after._tag).toBe("open");
    const clause = (x.after as { clause: Clause }).clause;
    const state: State = { moves: {}, clauses: new Map([["a", clause]]), believedExtra: {} };
    // the largest ratio at which the want leg still floors to 0: the hub takes base for free
    const freeRatio = Number((65535n - 1n) / clause.wants.amount);
    for (const [i, r] of [1, freeRatio, freeRatio + 1, 13107, 32768, 65534, 65535].entries()) {
      const got = await dispute(w, `r${i}`, i % 2 === 0, state, r);
      expect(got.finalized).toBe("ok");
      expect(got.maker[BASE]).toBe(-fill(clause.gives.amount, BigInt(r)));
      expect(got.maker[QUOTE]).toBe(fill(clause.wants.amount, BigInt(r)));
    }
    // the free dust of the contract's own rule: base for no quote at all, worth less than one quote unit
    const dust = await dispute(w, "dust", true, state, freeRatio);
    expect(dust.maker[QUOTE]).toBe(0n);
    expect(-dust.maker[BASE]!).toBe(fill(clause.gives.amount, BigInt(freeRatio)));
    expect(-dust.maker[BASE]!).toBeGreaterThan(0n);
  }, 300_000);

  test("R-BOOK-DISPUTE-HONORS fills as ratios would leave dust in most remainders; the engine lots leave none", () => {
    // a maker with L open lots at price p is filled for f lots by ratio ceil(f * 65535 / L), each leg floored
    let cases = 0, dusty = 0, worst = 0n;
    const lot = 1_000_000n; // one whole 6-decimal token per lot
    for (let L = 2n; L <= 24n; L++) for (let f = 1n; f < L; f++) {
      const g = L * lot, want = L * 12n * MARKET.quoteTick * lot;
      const r = (f * 65535n + L - 1n) / L;
      const exactGive = f * lot, exactWant = f * 12n * MARKET.quoteTick * lot;
      const dg = fill(g, r) - exactGive, dw = fill(want, r) - exactWant;
      cases++;
      if (dg !== 0n || dw !== 0n) { dusty++; worst = [worst, dg < 0n ? -dg : dg, dw < 0n ? -dw : dw].reduce((a, b) => (a > b ? a : b)); }
    }
    expect(dusty).toBeGreaterThan(0);
  });
});
