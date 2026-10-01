import { describe, expect, test } from "bun:test";
import { err, unwrapOr, type Result } from "../kernel/core/result.ts";
import { clockParams } from "./clause/clock.ts";
import { holdOf, secretOf, tokenOf, viewOf } from "./fixtures.ts";
import { allocation, emptyLedger, MAX_HOLDS } from "./ledger.ts";
import {
  holdId, MAX_TOKEN, other, tokenId, type AccountFault, type AccountState, type Hold, type Ledger, type Side,
  type TokenId,
} from "./model.ts";
import { emptyAccount, ledgerOf, openHolds, withLedger } from "./state.ts";
import { applyTx, type AccountTx, type Judge } from "./tx.ts";

const refused = (fault: AccountFault): Result<never, AccountFault> => err(fault);

const value = (r: Result<AccountState, AccountFault>): AccountState =>
  unwrapOr(r, (fault) => expect.unreachable(`refused: ${fault._tag}`));

const judge: Judge = {
  clock: unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params")),
  view: viewOf(100n),
};
const DEADLINE = 105n;

const GOLD = tokenOf(1n);
const OIL = tokenOf(2n);

const applyAll = (s: AccountState, author: Side, ...txs: readonly AccountTx[]): AccountState =>
  txs.reduce((acc, tx) => value(applyTx(acc, judge, author, tx)), s);

/** Right extends `credit` to Left in `token`, so Left can lock and pay up to it. */
const creditedTo = (token: TokenId, credit = 1000n): AccountTx => ({ _tag: "set_credit", token, limit: credit });
const lockOn = (token: TokenId, hold: Hold): AccountTx => ({ _tag: "lock", token, hold });
const cancelOn = (token: TokenId, id: bigint): AccountTx => ({ _tag: "cancel", token, id: holdId(id) });

/** Left may lock in both tokens: Right extends credit in each. */
const bothTokens: AccountState = applyAll(emptyAccount, "right", creditedTo(GOLD), creditedTo(OIL));

/** `n` holds of 1 in `token`, slots and secrets numbered from `from`. */
const holds = (token: TokenId, n: number, from: number): readonly AccountTx[] =>
  Array.from({ length: n }, (_, i) => lockOn(token, holdOf("left", 1n, BigInt(from + i), DEADLINE, from + i)));

describe("account/tx", () => {
  test("a token with no entry is the empty ledger, and a refused tx leaves the state as it was", () => {
    expect(ledgerOf(emptyAccount, GOLD).holds).toEqual([]);
    expect(applyTx(emptyAccount, judge, "left", { _tag: "pay", token: GOLD, amount: 1n })).toEqual(
      refused({ _tag: "insufficient_capacity", available: 0n, requested: 1n }));
  });

  test("each token has its own ledger: a payment in one leaves the other alone", () => {
    const after = applyAll(bothTokens, "left", { _tag: "pay", token: GOLD, amount: 7n });
    expect(ledgerOf(after, GOLD).offdelta).toBe(-7n);
    expect(ledgerOf(after, OIL)).toEqual(ledgerOf(bothTokens, OIL));
  });

  test("the author of a tx is the side that pays, extends credit, locks, or is the payee", () => {
    const s = applyAll(bothTokens, "left", lockOn(GOLD, holdOf("left", 5n, 1n, DEADLINE)));
    expect(applyTx(s, judge, "left", cancelOn(GOLD, 1n))).toEqual(refused({ _tag: "not_payee" }));
    expect(ledgerOf(applyAll(s, "right", cancelOn(GOLD, 1n)), GOLD).holds).toEqual([]);
    const theirs = lockOn(GOLD, holdOf("left", 1n, 2n));
    expect(applyTx(s, judge, "right", theirs)).toEqual(refused({ _tag: "not_own_funds" }));
  });

  test("a slot is per token: the same slot number is free in another token", () => {
    const s = applyAll(bothTokens, "left", lockOn(GOLD, holdOf("left", 1n, 1n, DEADLINE, 1)));
    const both = applyAll(s, "left", lockOn(OIL, holdOf("left", 1n, 1n, DEADLINE, 2)));
    expect(openHolds(both).map((h) => h.id)).toEqual([holdId(1n), holdId(1n)]);
    const resolved = applyAll(both, "right", { _tag: "resolve", token: OIL, id: holdId(1n), secret: secretOf(2) });
    expect(ledgerOf(resolved, GOLD).holds).toHaveLength(1);
    expect(ledgerOf(resolved, OIL).holds).toEqual([]);
  });
});

describe("account/tx caps that span tokens", () => {
  test("R-HOLD-CAP two tokens with 16 holds each: a 33rd lock in either token is refused", () => {
    const full = applyAll(bothTokens, "left", ...holds(GOLD, 16, 1), ...holds(OIL, 16, 101));
    expect(openHolds(full)).toHaveLength(MAX_HOLDS);
    [GOLD, OIL].forEach((token) => {
      expect(applyTx(full, judge, "left", lockOn(token, holdOf("left", 1n, 500n, DEADLINE, 500)))).toEqual(
        refused({ _tag: "too_many_holds", max: MAX_HOLDS }));
    });
  });

  test("R-HOLD-CAP a token that holds 32 alone refuses its own 33rd, and the other token is refused too", () => {
    const gold = applyAll(bothTokens, "left", ...holds(GOLD, MAX_HOLDS, 1));
    [GOLD, OIL].forEach((token) => {
      expect(applyTx(gold, judge, "left", lockOn(token, holdOf("left", 1n, 500n, DEADLINE, 500)))).toEqual(
        refused({ _tag: "too_many_holds", max: MAX_HOLDS }));
    });
  });

  test("R-HOLD-CAP a hold that resolves, cancels or expires frees its place in the count, in any token", () => {
    const full = applyAll(bothTokens, "left", ...holds(GOLD, 16, 1), ...holds(OIL, 16, 101));
    const freed = applyAll(full, "right", cancelOn(GOLD, 3n));
    expect(openHolds(freed)).toHaveLength(MAX_HOLDS - 1);
    expect(applyTx(freed, judge, "left", lockOn(OIL, holdOf("left", 1n, 500n, DEADLINE, 500))).ok).toBe(true);
    const late: Judge = { ...judge, view: viewOf(DEADLINE + 3n) };
    const expired = value(applyTx(full, late, "right", { _tag: "expire", token: OIL, id: holdId(101n) }));
    expect(openHolds(expired)).toHaveLength(MAX_HOLDS - 1);
  });

  test("R-ONE-LOCK-PER-HASH an open hashlock is refused in every token and opens again when it is gone", () => {
    const s = applyAll(bothTokens, "left", lockOn(GOLD, holdOf("left", 1n, 1n, DEADLINE, 7)));
    const again = lockOn(OIL, holdOf("left", 1n, 9n, DEADLINE, 7));
    expect(applyTx(s, judge, "left", again)).toEqual(refused({ _tag: "lock_exists", id: holdId(1n) }));
    const gone = applyAll(s, "right", { _tag: "resolve", token: GOLD, id: holdId(1n), secret: secretOf(7) });
    expect(ledgerOf(value(applyTx(gone, judge, "left", again)), OIL).holds).toHaveLength(1);
  });

  test("a refused lock changes nothing in any token", () => {
    const full = applyAll(bothTokens, "left", ...holds(GOLD, 16, 1), ...holds(OIL, 16, 101));
    const tried = applyTx(full, judge, "left", lockOn(OIL, holdOf("left", 1n, 500n, DEADLINE, 500)));
    expect(tried.ok).toBe(false);
    expect(openHolds(full)).toHaveLength(MAX_HOLDS);
  });
});

/** What `side` has of its own to pay: its share of the collateral, less what it has held (credit is not its own). */
const freeFunds = (l: Ledger, side: Side): bigint => {
  const held = l.holds.filter((h) => h.payer === side).reduce((sum, h) => sum + h.amount, 0n);
  return side === "left" ? allocation(l) - held : l.collateral - allocation(l) - held;
};

/** A deterministic pick in 0 .. n-1 for step `i` and slot `k`, so a failing run names its step. */
const pick = (i: number, k: number, n: number): number =>
  ((Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 1597334677)) >>> 0) % n;

const TOKENS: readonly TokenId[] = [GOLD, OIL];

/** Both tokens hold collateral and credit, so the random txs are admitted often enough to matter. */
const shared: Ledger = { ...emptyLedger, collateral: 100n, ondelta: 40n, limit: { left: 30n, right: 30n } };
const funded: AccountState = TOKENS.reduce((s, token) => withLedger(s, token, shared), emptyAccount);

const randomTx = (i: number): AccountTx => {
  const token = TOKENS[pick(i, 1, 2)] ?? GOLD;
  const slot = BigInt(1 + pick(i, 2, 5));
  const n = 1 + pick(i, 3, 5);
  const payer: Side = pick(i, 6, 2) === 0 ? "left" : "right";
  const kinds: readonly AccountTx[] = [
    { _tag: "pay", token, amount: BigInt(1 + pick(i, 4, 25)) },
    { _tag: "set_credit", token, limit: BigInt(pick(i, 5, 60)) },
    { _tag: "lock", token, hold: holdOf(payer, BigInt(1 + pick(i, 7, 12)), slot, 104n, n) },
    { _tag: "resolve", token, id: holdId(slot), secret: secretOf(n) },
    { _tag: "cancel", token, id: holdId(slot) },
    { _tag: "expire", token, id: holdId(slot) },
  ];
  return kinds[pick(i, 8, kinds.length)] ?? expect.unreachable("a kind");
};

describe("account/tx authority", () => {
  test("R-AUTH a committed tx never lowers the other side's own funds or changes its author's credit", () => {
    const steps = Array.from({ length: 4000 }, (_, i) => i);
    const final = steps.reduce<{ s: AccountState; applied: number }>(({ s, applied }, i) => {
      const author: Side = pick(i, 0, 2) === 0 ? "left" : "right";
      const late: Judge = { ...judge, view: viewOf(BigInt(100 + pick(i, 9, 12))) };
      const next = applyTx(s, late, author, randomTx(i));
      if (!next.ok) return { s, applied };
      TOKENS.forEach((token) => {
        const [before, after] = [ledgerOf(s, token), ledgerOf(next.value, token)];
        expect(freeFunds(after, other(author))).toBeGreaterThanOrEqual(freeFunds(before, other(author)));
        expect(after.limit[author]).toBe(before.limit[author]);
      });
      return { s: next.value, applied: applied + 1 };
    }, { s: funded, applied: 0 });
    expect(final.applied).toBeGreaterThan(300);
  });
});

describe("account/tx a hashlock open in another token", () => {
  // Reviewer A of A3: the refusal names the clause that holds the hashlock, whichever token's ledger came first.
  const secondFirst: AccountState = applyAll(bothTokens, "left", lockOn(OIL, holdOf("left", 1n, 3n, DEADLINE, 7)));
  const goldFirst: AccountState = applyAll(bothTokens, "left", lockOn(GOLD, holdOf("left", 1n, 3n, DEADLINE, 7)));

  test("R-ONE-LOCK-PER-HASH the fault names the open slot, never the new lock's own, in either token order", () => {
    expect(applyTx(secondFirst, judge, "left", lockOn(GOLD, holdOf("left", 1n, 9n, DEADLINE, 7)))).toEqual(
      refused({ _tag: "lock_exists", id: holdId(3n) }));
    expect(applyTx(goldFirst, judge, "left", lockOn(OIL, holdOf("left", 1n, 9n, DEADLINE, 7)))).toEqual(
      refused({ _tag: "lock_exists", id: holdId(3n) }));
  });

  test("a slot is per token: resolve, cancel and expire in the other token find nothing", () => {
    const late: Judge = { ...judge, view: viewOf(DEADLINE + 3n) };
    const resolve: AccountTx = { _tag: "resolve", token: OIL, id: holdId(3n), secret: secretOf(7) };
    const gold = applyAll(bothTokens, "left", lockOn(GOLD, holdOf("left", 1n, 3n, DEADLINE, 7)));
    expect(applyTx(gold, judge, "right", resolve)).toEqual(refused({ _tag: "no_such_lock" }));
    expect(applyTx(gold, judge, "right", cancelOn(OIL, 3n))).toEqual(refused({ _tag: "no_such_lock" }));
    expect(applyTx(gold, late, "right", { _tag: "expire", token: OIL, id: holdId(3n) })).toEqual(
      refused({ _tag: "no_such_lock" }));
  });
});

describe("account/state a token and an unused ledger", () => {
  test("a token id is 0 .. 2^256-1: each edge is admitted and the step past it is refused", () => {
    expect(MAX_TOKEN).toBe(2n ** 256n - 1n);
    expect(tokenId(0n).ok).toBe(true);
    expect(tokenId(MAX_TOKEN).ok).toBe(true);
    expect(tokenId(-1n)).toEqual(err({ _tag: "bad_token", token: -1n }));
    expect(tokenId(MAX_TOKEN + 1n)).toEqual(err({ _tag: "bad_token", token: MAX_TOKEN + 1n }));
  });

  test("a token nobody has used holds the empty ledger: nothing collateral, no credit, no holds", () => {
    expect(ledgerOf(emptyAccount, GOLD)).toEqual(emptyLedger);
    expect(ledgerOf(withLedger(emptyAccount, OIL, emptyLedger), GOLD)).toEqual(emptyLedger);
  });
});
