import { describe, expect, test } from "bun:test";
import { err, unwrapOr, type Result } from "../kernel/core/result.ts";
import { clockParams } from "./clause/clock.ts";
import { holdOf, secretOf } from "./fixtures.ts";
import { MAX_HOLDS } from "./ledger.ts";
import { holdId, tokenId, type AccountFault, type AccountState, type Hold, type Side, type TokenId } from "./model.ts";
import { emptyAccount, ledgerOf, openHolds } from "./state.ts";
import { applyTx, type AccountTx, type Judge } from "./tx.ts";

const refused = (fault: AccountFault): Result<never, AccountFault> => err(fault);

const value = (r: Result<AccountState, AccountFault>): AccountState =>
  unwrapOr(r, (fault) => expect.unreachable(`refused: ${fault._tag}`));

const judge: Judge = {
  clock: unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params")),
  view: 100n,
};
const DEADLINE = 105n;

const GOLD = tokenId(1n);
const OIL = tokenId(2n);

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
    const late: Judge = { ...judge, view: DEADLINE + 3n };
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
