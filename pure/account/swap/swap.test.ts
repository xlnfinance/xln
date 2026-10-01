// R-SWAP-*: a two-party swap inside an Account. Offer, partial fill, withdraw and lapse are txs like any other, judged
// by `applyTx`; what a dispute would do with the signed state is read by a small model of DeltaTransformer's own
// arithmetic (`applySwap`, WideMath.fill, `_applyTransformers`), decoded from the bytes the body carries.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { unwrapOr } from "../../kernel/core/result.ts";
import { clockParams } from "../clause/clock.ts";
import { draw, heightOf, holdOf, signing, tokenOf, viewOf } from "../fixtures.ts";
import { emptyLedger, MAX_AMOUNT, room } from "../ledger.ts";
import { holdId, other, type AccountFault, type AccountState, type Offer, type Side, type TokenId } from "../model.ts";
import { proofBodyOf, unsignable } from "../proof/body.ts";
import { emptyAccount, ledgerOf, withLedger } from "../state.ts";
import { applyTx, type AccountTx } from "../tx.ts";
import { FULL_FILL, fillOf } from "./swap.ts";

const clock = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));
const GOLD = tokenOf(1n);
const OIL = tokenOf(2n);
const RICH = { ...emptyLedger, collateral: 10_000n, ondelta: 5_000n, limit: { left: 6_000n, right: 6_000n } };
const start: AccountState = withLedger(withLedger(emptyAccount, GOLD, RICH), OIL, RICH);

const offerOf = (maker: Side, give: bigint, want: bigint, id = 1n, deadline = 105n, gt = GOLD, wt = OIL): Offer =>
  ({ id: holdId(id), maker, give: { token: gt, amount: give }, want: { token: wt, amount: want },
    deadline: heightOf(deadline) });
const tx = {
  offer: (o: Offer): AccountTx => ({ _tag: "offer", offer: o }),
  take: (id: bigint, ratio: number): AccountTx => ({ _tag: "fill", id: holdId(id), ratio }),
  retract: (id: bigint): AccountTx => ({ _tag: "retract", id: holdId(id) }),
  lapse: (id: bigint): AccountTx => ({ _tag: "lapse", id: holdId(id) }),
};
const apply = (s: AccountState, author: Side, t: AccountTx, view = 100n) =>
  applyTx(s, { clock, view: viewOf(view) }, author, t);
const must = (s: AccountState, author: Side, t: AccountTx, view = 100n): AccountState =>
  unwrapOr(apply(s, author, t, view), (e) => expect.unreachable(`refused: ${e._tag}`));
const refusal = (s: AccountState, author: Side, t: AccountTx, view = 100n): AccountFault | undefined => {
  const r = apply(s, author, t, view);
  return r.ok ? undefined : r.error;
};
const SIDES: readonly Side[] = ["left", "right"];
const offdelta = (s: AccountState, token: TokenId): bigint => ledgerOf(s, token).offdelta;

const open = must(start, "left", tx.offer(offerOf("left", 1000n, 333n)));

describe("account/swap R-SWAP-OFFER either side offers its funds for the other's and both legs are reserved", () => {
  test("a Left maker's give is reserved against Left in its token and its want against Right in the other", () => {
    expect(open.offers).toEqual([offerOf("left", 1000n, 333n)]);
    expect(ledgerOf(open, GOLD).reserved).toEqual({ left: 1000n, right: 0n });
    expect(ledgerOf(open, OIL).reserved).toEqual({ left: 0n, right: 333n });
    expect([room(ledgerOf(open, GOLD), "left"), room(ledgerOf(open, OIL), "right")])
      .toEqual([room(ledgerOf(start, GOLD), "left") - 1000n, room(ledgerOf(start, OIL), "right") - 333n]);
  });

  test("a Right maker is the mirror: its give against Right, its want against Left", () => {
    const s = must(start, "right", tx.offer(offerOf("right", 50n, 70n)));
    expect([ledgerOf(s, GOLD).reserved, ledgerOf(s, OIL).reserved])
      .toEqual([{ left: 0n, right: 50n }, { left: 70n, right: 0n }]);
  });

  test("the refusals, each its own fault: funds, tokens, amounts, slot, deadline", () => {
    const o = offerOf("left", 10n, 5n);
    const faults: readonly [string, AccountFault | undefined][] = [
      ["not the author's funds", refusal(start, "right", tx.offer(o))],
      ["one token for itself", refusal(start, "left", tx.offer(offerOf("left", 10n, 5n, 1n, 105n, GOLD, GOLD)))],
      ["a zero give", refusal(start, "left", tx.offer(offerOf("left", 0n, 5n)))],
      ["a zero want", refusal(start, "left", tx.offer(offerOf("left", 10n, 0n)))],
      ["a want past uint256", refusal(start, "left", tx.offer(offerOf("left", 10n, MAX_AMOUNT + 1n)))],
      ["a slot in use", refusal(open, "right", tx.offer(offerOf("right", 1n, 1n)))],
      ["a deadline gone", refusal(start, "left", tx.offer(offerOf("left", 10n, 5n, 1n, 100n)))],
      ["a deadline too far", refusal(start, "left", tx.offer(offerOf("left", 10n, 5n, 1n, 113n)))],
    ];
    expect(faults.map(([, f]) => f?._tag)).toEqual([
      "not_own_funds", "same_token", "bad_amount", "bad_amount", "bad_amount", "offer_exists", "deadline_past",
      "deadline_too_far",
    ]);
    expect(refusal(start, "left", tx.offer(offerOf("left", 10n, 5n, 1n, 112n)))).toBeUndefined();
  });

  test("a maker offers only what it has room to give, and a taker only what it could pay", () => {
    const room_ = room(ledgerOf(start, GOLD), "left");
    expect(refusal(start, "left", tx.offer(offerOf("left", room_ + 1n, 1n)))?._tag).toBe("insufficient_capacity");
    expect(refusal(start, "left", tx.offer(offerOf("left", room_, 1n)))).toBeUndefined();
    const takerRoom = room(ledgerOf(start, OIL), "right");
    expect(refusal(start, "left", tx.offer(offerOf("left", 1n, takerRoom + 1n)))?._tag).toBe("insufficient_capacity");
    expect(refusal(start, "left", tx.offer(offerOf("left", 1n, takerRoom)))).toBeUndefined();
  });

  test("an offer counts as one clause against R-HOLD-CAP with the holds, across tokens", () => {
    const lock = (n: bigint): AccountTx =>
      ({ _tag: "lock", token: n % 2n === 0n ? GOLD : OIL, hold: holdOf("left", 1n, n, 105n, Number(n)) });
    const holds = Array.from({ length: 16 }, (_, i) => BigInt(i + 1)).reduce((s, n) => must(s, "left", lock(n)), start);
    const full = Array.from({ length: 16 }, (_, i) => BigInt(i + 1))
      .reduce((s, n) => must(s, "left", tx.offer(offerOf("left", 1n, 1n, n))), holds);
    expect([full.offers.length, unsignable(signing.terms, full)]).toEqual([16, undefined]);
    expect(refusal(full, "left", tx.offer(offerOf("left", 1n, 1n, 17n)))).toEqual({ _tag: "too_many_holds", max: 32 });
    expect(refusal(full, "left", lock(17n))).toEqual({ _tag: "too_many_holds", max: 32 });
    expect(unsignable(signing.terms, { ...full, offers: [...full.offers, offerOf("left", 1n, 1n, 17n)] }))
      .toEqual({ _tag: "too_many_clauses", clauses: 33 });
  });
});

describe("account/swap R-SWAP-FILL the taker fills a ratio of what remains, each leg rounded down on its own", () => {
  const once = must(open, "right", tx.take(1n, 10_000));

  test("a partial fill moves both offdeltas by the chain's own arithmetic and leaves the remainder", () => {
    // floor(1000 * 10000 / 65535) = 152 and floor(333 * 10000 / 65535) = 50
    expect([offdelta(once, GOLD), offdelta(once, OIL)]).toEqual([-152n, 50n]);
    expect(once.offers).toEqual([offerOf("left", 848n, 283n)]);
    expect([ledgerOf(once, GOLD).reserved.left, ledgerOf(once, OIL).reserved.right]).toEqual([848n, 283n]);
  });

  test("a leg is the contract's WideMath.fill, (a / 65535) * r + ((a % 65535) * r) / 65535, at any size", () => {
    const wide = (a: bigint, r: bigint): bigint => (a / 65_535n) * r + ((a % 65_535n) * r) / 65_535n;
    const amounts = [1n, 3n, 333n, 1000n, 65_534n, 65_535n, 65_536n, 10n ** 18n + 7n, MAX_AMOUNT - 1n, MAX_AMOUNT];
    const ratios = [1, 2, 10_000, 32_768, 65_534, FULL_FILL];
    const apart = amounts.flatMap((a) => ratios.map((r) => fillOf(a, r) - wide(a, BigInt(r))));
    expect(apart.every((x) => x === 0n)).toBe(true);
    expect(amounts.map((a) => fillOf(a, FULL_FILL))).toEqual(amounts);
    expect([fillOf(1000n, 10_000), fillOf(3n, 10_000), fillOf(3n, 1), fillOf(65_534n, 1)]).toEqual([152n, 0n, 0n, 0n]);
  });

  test("a Right maker's fill moves the deltas the other way", () => {
    const s = must(start, "right", tx.offer(offerOf("right", 1000n, 333n)));
    const filled = must(s, "left", tx.take(1n, 10_000));
    expect([offdelta(filled, GOLD), offdelta(filled, OIL)]).toEqual([152n, -50n]);
  });

  test("a second fill is a ratio of the remainder, and what was filled plus what remains is always the offer", () => {
    const twice = must(once, "right", tx.take(1n, 40_000));
    const give = 848n - (848n * 40_000n) / 65_535n;
    expect(twice.offers[0]?.give.amount).toBe(give);
    expect(-offdelta(twice, GOLD) + give).toBe(1000n);
    expect(offdelta(twice, OIL) + (twice.offers[0]?.want.amount ?? 0n)).toBe(333n);
  });

  test("the whole fill (65535) takes everything left and drops the offer with its reservations", () => {
    const done = must(once, "right", tx.take(1n, 65_535));
    expect(done.offers).toEqual([]);
    expect([offdelta(done, GOLD), offdelta(done, OIL)]).toEqual([-1000n, 333n]);
    expect([ledgerOf(done, GOLD).reserved, ledgerOf(done, OIL).reserved])
      .toEqual([{ left: 0n, right: 0n }, { left: 0n, right: 0n }]);
  });

  test("only the other side fills, at a whole ratio from 1 to 65535, while the offer is live", () => {
    const faults = [
      refusal(open, "left", tx.take(1n, 100)), refusal(open, "right", tx.take(1n, 0)),
      refusal(open, "right", tx.take(1n, 65_536)), refusal(open, "right", tx.take(1n, 1.5)),
      refusal(open, "right", tx.take(1n, Number.NaN)), refusal(open, "right", tx.take(2n, 100)),
      refusal(open, "right", tx.take(1n, 10_000), 106n), refusal(open, "right", tx.take(1n, 10_000), 105n),
    ];
    expect(faults.map((f) => f?._tag)).toEqual([
      "not_taker", "bad_ratio", "bad_ratio", "bad_ratio", "bad_ratio", "no_such_offer", "past_deadline", undefined,
    ]);
  });

  test("a fill that takes nothing of a leg is refused: every fill is a trade", () => {
    const dust = must(start, "left", tx.offer(offerOf("left", 1000n, 3n)));
    // floor(3 * 10000 / 65535) = 0 while the give leg is 152
    expect(refusal(dust, "right", tx.take(1n, 10_000))).toEqual({ _tag: "fill_too_small", give: 152n, want: 0n });
    const tiny = must(start, "left", tx.offer(offerOf("left", 3n, 1000n)));
    expect(refusal(tiny, "right", tx.take(1n, 10_000))).toEqual({ _tag: "fill_too_small", give: 0n, want: 152n });
  });

  test("a fill needs no room of the maker's or taker's beyond what the offer already reserved", () => {
    const tight = must(start, "left", tx.offer(offerOf("left", room(ledgerOf(start, GOLD), "left"), 1n)));
    expect(refusal(tight, "right", tx.take(1n, 65_535))).toBeUndefined();
    expect(room(ledgerOf(must(tight, "right", tx.take(1n, 65_535)), GOLD), "left")).toBe(0n);
  });
});

// ---- what a dispute does with the signed state: DeltaTransformer.applySwap and Account._applyTransformers ----

const AMOUNT = "tuple(bool negative, uint256 magnitude)";
const PAYMENT = `tuple(uint256 deltaIndex, ${AMOUNT} amount, uint256 revealedUntilTimestamp, bytes32 hash)[] payment`;
const SWAP = "tuple(bool ownerIsLeft, uint256 addDeltaIndex, uint256 addAmount, uint256 subDeltaIndex,"
  + " uint256 subAmount)[] swap";
const PULL = `tuple(uint256 deltaIndex, ${AMOUNT} amount, uint16 claimedRatio, bytes32 fullHash, bytes32 partialRoot,`
  + " bool targetRole)[] pull";
const BATCH = `tuple(${PAYMENT}, ${SWAP}, ${PULL})`;
const swapsOf = (encodedBatch: string) =>
  (ethers.AbiCoder.defaultAbiCoder().decode([BATCH], encodedBatch)[0].swap as readonly {
    ownerIsLeft: boolean; addDeltaIndex: bigint; addAmount: bigint; subDeltaIndex: bigint; subAmount: bigint;
  }[]);
const shown = (e: unknown): string => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? `${v}` : v));
const bodyOf = (s: AccountState) => unwrapOr(proofBodyOf(signing.terms, s), (e) => expect.unreachable(shown(e)));

/** The deltas a dispute finalize leaves when the taker fills every clause in full (ratio 65535); a clause that moves a
 * delta it carries no allowance for reverts the whole finalize, and one that moves it past its allowance is clamped. */
const finalizedAtFullFill = (s: AccountState): readonly bigint[] | "reverted" => {
  const body = bodyOf(s);
  const changes = body.transformers.flatMap((clause) => swapsOf(clause.encodedBatch).flatMap((swap) => {
    const moves = swap.ownerIsLeft
      ? [[swap.addDeltaIndex, -swap.addAmount], [swap.subDeltaIndex, swap.subAmount]] as const
      : [[swap.addDeltaIndex, swap.addAmount], [swap.subDeltaIndex, -swap.subAmount]] as const;
    return moves.map(([index, change]) => ({
      index, change, allowance: clause.allowances.find((a) => a.deltaIndex === index),
    }));
  }));
  const clamped = (change: bigint, cap: bigint): bigint => {
    const moved = change < 0n ? -change : change;
    return change < 0n ? -(moved < cap ? moved : cap) : (moved < cap ? moved : cap);
  };
  const capOf = (change: bigint, a: { rightAllowance: bigint; leftAllowance: bigint } | undefined): bigint =>
    (change < 0n ? a?.rightAllowance : a?.leftAllowance) ?? 0n;
  if (changes.some((c) => c.allowance === undefined)) return "reverted";
  const total = (i: number): bigint => changes.filter((c) => c.index === BigInt(i))
    .reduce((sum, c) => sum + clamped(c.change, capOf(c.change, c.allowance)), 0n);
  return body.offdeltas.map((o, i) => o + ledgerOf(s, body.tokenIds[i] as TokenId).ondelta + total(i));
};
const totalAfterDispute = (s: AccountState, token: TokenId): bigint => {
  const deltas = finalizedAtFullFill(s);
  const index = bodyOf(s).tokenIds.indexOf(token);
  return deltas === "reverted" ? expect.unreachable("a clause without an allowance") : (deltas[index] ?? 0n);
};
const startDelta = (token: TokenId): bigint => ledgerOf(start, token).ondelta + ledgerOf(start, token).offdelta;

describe("account/swap R-SWAP-CLAUSE-WITH-FILL a state that holds a fill carries a clause for what is left", () => {
  const once = must(open, "right", tx.take(1n, 10_000));

  test("the body after a fill carries the remainder: the clause shrinks in the step that moves the deltas", () => {
    expect(swapsOf(bodyOf(once).transformers[0]?.encodedBatch ?? "").map((x) => [x.addAmount, x.subAmount]))
      .toEqual([[848n, 283n]]);
  });

  test("a dispute from it, the taker filling in full, gives exactly the offer and never more", () => {
    // the maker gives 1000 in all: 152 already in the offdelta and 848 left in the clause; it gets 333 in all
    expect(totalAfterDispute(once, GOLD) - startDelta(GOLD)).toBe(-1000n);
    expect(totalAfterDispute(once, OIL) - startDelta(OIL)).toBe(333n);
    const again = must(once, "right", tx.take(1n, 30_000));
    expect(totalAfterDispute(again, GOLD) - startDelta(GOLD)).toBe(-1000n);
    expect(totalAfterDispute(again, OIL) - startDelta(OIL)).toBe(333n);
  });

  test("a whole fill leaves no clause at all, and a Right maker's offer is the mirror", () => {
    const done = must(once, "right", tx.take(1n, 65_535));
    expect(bodyOf(done).transformers).toEqual([]);
    const s = must(must(start, "right", tx.offer(offerOf("right", 1000n, 333n))), "left", tx.take(1n, 10_000));
    expect(totalAfterDispute(s, GOLD) - startDelta(GOLD)).toBe(1000n);
    expect(totalAfterDispute(s, OIL) - startDelta(OIL)).toBe(-333n);
  });

  // each side's reservation in a token is what the open offers could still take of it
  const reservedOf = (s: AccountState, token: TokenId, side: Side): bigint =>
    s.offers.reduce((sum, o) => sum + (o.give.token === token && o.maker === side ? o.give.amount : 0n)
      + (o.want.token === token && other(o.maker) === side ? o.want.amount : 0n), 0n);

  /** A fill moves each leg's offdelta by what the offer lost of it: the move plus the remainder is the offer. */
  const conserved = (before: AccountState, after: AccountState, id: bigint): readonly bigint[] => {
    const o = before.offers.find((x) => x.id === id) ?? expect.unreachable("a fill of no offer");
    const left = after.offers.find((x) => x.id === id);
    const sign = o.maker === "left" ? -1n : 1n;
    const gave = sign * (offdelta(after, o.give.token) - offdelta(before, o.give.token));
    const took = -sign * (offdelta(after, o.want.token) - offdelta(before, o.want.token));
    return [gave + (left?.give.amount ?? 0n) - o.give.amount, took + (left?.want.amount ?? 0n) - o.want.amount];
  };

  type Walk = Readonly<{ s: AccountState; fills: number }>;

  /** One random move at `step` of run `run`: refused ones change nothing, and every state it reaches is checked. */
  const move = (run: number) => (walk: Walk, step: number): Walk => {
    const d = (k: number, n: number) => draw(1, run, step, k, n);
    const id = BigInt(1 + d(0, 4));
    const [gt, wt] = d(4, 2) === 0 ? [GOLD, OIL] : [OIL, GOLD];
    const side: Side = d(1, 2) === 0 ? "left" : "right";
    const offered = offerOf(side, BigInt(1 + d(2, 2000)), BigInt(1 + d(3, 2000)), id, 105n, gt, wt);
    const ratio = 1 + d(5, 65_535);
    const maker = walk.s.offers.find((x) => x.id === id)?.maker ?? offered.maker;
    const taker = other(maker);
    const moves: readonly (readonly [AccountTx, Side])[] = [
      [tx.offer(offered), side], [tx.offer(offered), side], [tx.take(id, ratio), taker],
      [tx.take(id, ratio), taker], [tx.take(id, ratio), taker],
      [tx.take(id, 65_535), taker], [tx.retract(id), maker], [tx.lapse(id), maker],
    ];
    const [t, author] = moves[d(6, 8)] ?? [tx.lapse(id), maker];
    const next = apply(walk.s, author, t, d(7, 3) === 0 ? 109n : 100n);
    if (!next.ok) return walk;
    const cells = [GOLD, OIL].flatMap((token) => SIDES.map((who) => [token, who] as const));
    expect(cells.map(([token, who]) => ledgerOf(next.value, token).reserved[who]))
      .toEqual(cells.map(([token, who]) => reservedOf(next.value, token, who)));
    expect(unsignable(signing.terms, next.value)).toBeUndefined();
    expect(finalizedAtFullFill(next.value)).not.toBe("reverted");
    if (t._tag !== "fill") return { ...walk, s: next.value };
    expect(conserved(walk.s, next.value, id)).toEqual([0n, 0n]);
    return { s: next.value, fills: walk.fills + 1 };
  };

  test("in any order of offers, fills, withdrawals and lapses a fill never leaves a clause that fills again", () => {
    const steps = Array.from({ length: 14 }, (_, step) => step);
    const fills = Array.from({ length: 300 }, (_, run) => steps.reduce(move(run), { s: start, fills: 0 }).fills);
    expect(fills.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(200);
  });
});

describe("account/swap R-SWAP-ALLOWANCES the clause carries an allowance for both tokens, sized to the rest", () => {
  const allowancesOf = (s: AccountState) => bodyOf(s).transformers.map((t) => t.allowances);
  const amounts = (s: AccountState) => bodyOf(s).transformers.flatMap((t) => swapsOf(t.encodedBatch))
    .map((x) => [x.ownerIsLeft, x.addDeltaIndex, x.addAmount, x.subDeltaIndex, x.subAmount]);

  test("a Left maker's give is the Right side's to take from, its want the Left side's to gain", () => {
    expect(allowancesOf(open)).toEqual([[
      { deltaIndex: 0n, rightAllowance: 1000n, leftAllowance: 0n },
      { deltaIndex: 1n, rightAllowance: 0n, leftAllowance: 333n },
    ]]);
    expect(amounts(open)).toEqual([[true, 0n, 1000n, 1n, 333n]]);
  });

  test("a Right maker's is the mirror, and the indices follow the tokens in ascending order", () => {
    const s = must(start, "right", tx.offer(offerOf("right", 70n, 50n, 1n, 105n, OIL, GOLD)));
    expect(allowancesOf(s)).toEqual([[
      { deltaIndex: 1n, rightAllowance: 0n, leftAllowance: 70n },
      { deltaIndex: 0n, rightAllowance: 50n, leftAllowance: 0n },
    ]]);
    expect(amounts(s)).toEqual([[false, 1n, 70n, 0n, 50n]]);
  });

  test("after a fill both allowances are the remainder: the clause and its allowances shrink together", () => {
    const once = must(open, "right", tx.take(1n, 10_000));
    expect(allowancesOf(once)).toEqual([[
      { deltaIndex: 0n, rightAllowance: 848n, leftAllowance: 0n },
      { deltaIndex: 1n, rightAllowance: 0n, leftAllowance: 283n },
    ]]);
  });

  test("swap clauses follow the payment clauses, each group in slot order", () => {
    const lock: AccountTx = { _tag: "lock", token: GOLD, hold: holdOf("left", 5n, 9n, 105n, 9) };
    const offers = [7n, 3n].reduce((s, id) => must(s, "left", tx.offer(offerOf("left", 10n, 5n, id))), start);
    const s = must(offers, "left", lock);
    const kinds = bodyOf(s).transformers.map((t) => swapsOf(t.encodedBatch).length);
    expect(kinds).toEqual([0, 1, 1]);
    expect(bodyOf(s).transformers.slice(1).map((t) => swapsOf(t.encodedBatch)[0]?.addAmount)).toEqual([10n, 10n]);
    expect(bodyOf(must(s, "left", tx.retract(3n))).transformers).toHaveLength(2);
  });
});

describe("account/swap R-SWAP-WITHDRAW the maker takes back what is left, and what was filled stays", () => {
  const once = must(open, "right", tx.take(1n, 10_000));

  test("only the maker withdraws; the remainder and its reservations go, the offdeltas stay", () => {
    const gone = must(once, "left", tx.retract(1n));
    expect(gone.offers).toEqual([]);
    expect([offdelta(gone, GOLD), offdelta(gone, OIL)]).toEqual([-152n, 50n]);
    expect([ledgerOf(gone, GOLD).reserved, ledgerOf(gone, OIL).reserved])
      .toEqual([{ left: 0n, right: 0n }, { left: 0n, right: 0n }]);
    expect(bodyOf(gone).transformers).toEqual([]);
    expect([refusal(once, "right", tx.retract(1n))?._tag, refusal(gone, "left", tx.retract(1n))?._tag])
      .toEqual(["not_maker", "no_such_offer"]);
  });

  test("it can withdraw at any time, a deadline long past included, and a fill after it is refused", () => {
    expect(refusal(once, "left", tx.retract(1n), 500n)).toBeUndefined();
    expect(refusal(must(once, "left", tx.retract(1n)), "right", tx.take(1n, 10_000))?._tag).toBe("no_such_offer");
  });
});

describe("account/swap R-SWAP-EXPIRE an offer expires off-chain: a frame lapses it once the view is past due", () => {
  test("not while it can still be filled or while the other side's view may lag, then by anyone", () => {
    // deadline 105, reserve 2: a view of 107 is not past it, 108 is
    const faults = [105n, 106n, 107n].map((view) => refusal(open, "right", tx.lapse(1n), view)?._tag);
    expect(faults).toEqual(["not_expired", "not_expired", "not_expired"]);
    expect(refusal(open, "right", tx.lapse(1n), 108n)).toBeUndefined();
    expect(refusal(open, "left", tx.lapse(1n), 108n)).toBeUndefined();
  });

  test("a lapse removes the offer and its reservations and keeps what was filled; no fill follows it", () => {
    const once = must(open, "right", tx.take(1n, 10_000));
    const lapsed = must(once, "left", tx.lapse(1n), 108n);
    expect([lapsed.offers, offdelta(lapsed, GOLD), offdelta(lapsed, OIL)]).toEqual([[], -152n, 50n]);
    expect(ledgerOf(lapsed, GOLD).reserved).toEqual({ left: 0n, right: 0n });
    expect(refusal(lapsed, "right", tx.take(1n, 10_000), 100n)?._tag).toBe("no_such_offer");
    expect(refusal(open, "right", tx.lapse(2n), 108n)?._tag).toBe("no_such_offer");
  });

  test("a lapse the view finds early says when it is not early: the retryable fault of the clock rules", () => {
    expect(refusal(open, "left", tx.lapse(1n), 107n)).toEqual({ _tag: "not_expired", deadline: 105n, earliest: 108n });
  });
});
