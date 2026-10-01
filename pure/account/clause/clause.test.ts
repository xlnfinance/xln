import { describe, expect, test } from "bun:test";
import { err, unwrapOr, type Result } from "../../kernel/core/result.ts";
import { hashlockOf, heightOf, holdOf, secretOf, viewOf } from "../fixtures.ts";
import { allocation, deposit, emptyLedger, setCredit } from "../ledger.ts";
import { holdId, type AccountFault, type Hold, type Ledger } from "../model.ts";
import { cancelClause, expireClause, lockClause, resolveClause } from "./clause.ts";
import { clockParams, type ClockParams } from "./clock.ts";

const refused = (fault: AccountFault): Result<never, AccountFault> => err(fault);

const value = (r: Result<Ledger, AccountFault>): Ledger =>
  unwrapOr(r, (fault) => expect.unreachable(`refused: ${fault._tag}`));

const params: ClockParams = unwrapOr(clockParams(1n, 2n, 10n), () => expect.unreachable("params"));

/** Left holds 10 in the collateral. */
const funded: Ledger = value(deposit(emptyLedger, "left", 10n));
const VIEW = viewOf(100n);
/** Left's clause on secret 1, due at J height 105. */
const DEADLINE = 105n;
const leftClause = holdOf("left", 4n, 1n, DEADLINE);
const locked: Ledger = value(lockClause(funded, params, VIEW, "left", leftClause));

const lockAtDeadline = (deadline: bigint) =>
  lockClause(funded, params, VIEW, "left", { ...leftClause, deadline: heightOf(deadline) });

describe("account/clause lock", () => {
  test("a payer opens a clause for its own funds and the money rules count it", () => {
    expect(locked.holds).toEqual([leftClause]);
    expect(allocation(locked)).toBe(10n);
  });

  test("a payer opens a clause only for its own funds", () => {
    expect(lockClause(funded, params, VIEW, "right", leftClause)).toEqual(refused({ _tag: "not_own_funds" }));
  });

  test("a hashlock is 0x and 64 lowercase hex digits", () => {
    const bad = (hashlock: string) => lockClause(funded, params, VIEW, "left", { ...leftClause, hashlock });
    expect(bad("0x1234")).toEqual(refused({ _tag: "bad_hashlock" }));
    expect(bad(hashlockOf(secretOf(1)).toUpperCase().replace("0X", "0x"))).toEqual(refused({ _tag: "bad_hashlock" }));
    const good = hashlockOf(secretOf(1));
    [`${good}00`, `${good}zz`, `zz${good}`, ` ${good}`, `${good}\n`, good.slice(2), ""].forEach((hashlock) =>
      expect(bad(hashlock)).toEqual(refused({ _tag: "bad_hashlock" })));
  });

  test("R-ONE-LOCK-PER-HASH a second lock on an open hashlock is refused, whichever slot or side it names", () => {
    const again = (hold: Hold) => lockClause(locked, params, VIEW, "left", hold);
    expect(again({ ...leftClause, id: holdId(2n), amount: 1n }))
      .toEqual(refused({ _tag: "lock_exists", id: holdId(1n) }));
    expect(lockClause(locked, params, VIEW, "right", { ...leftClause, id: holdId(3n), payer: "right" }))
      .toEqual(refused({ _tag: "lock_exists", id: holdId(1n) }));
  });

  test("R-ONE-LOCK-PER-HASH a hashlock opens again once its clause is gone", () => {
    const freed = value(expireClause(locked, params, viewOf(DEADLINE + 3n), leftClause.id));
    expect(lockClause(freed, params, VIEW, "left", { ...leftClause, id: holdId(2n) }).ok).toBe(true);
  });

  test("R-HORIZON-RESERVE and N2 a deadline is refused past the view plus the horizon plus the reserve", () => {
    expect(lockAtDeadline(112n).ok).toBe(true);
    expect(lockAtDeadline(113n)).toEqual(refused({ _tag: "deadline_too_far", deadline: 113n, latest: 112n }));
  });

  test("a deadline at or before the view is refused, one after it is admitted", () => {
    expect(lockAtDeadline(100n)).toEqual(refused({ _tag: "deadline_past", deadline: 100n, view: 100n }));
    expect(lockAtDeadline(101n).ok).toBe(true);
  });

  test("R-A6 a clause beyond the payer's room is refused by the money rules", () => {
    const tooBig = { ...leftClause, amount: 11n };
    expect(lockClause(funded, params, VIEW, "left", tooBig))
      .toEqual(refused({ _tag: "insufficient_capacity", available: 10n, requested: 11n }));
    const credit = value(setCredit(funded, "right", 1n));
    expect(lockClause(credit, params, VIEW, "left", tooBig).ok).toBe(true);
  });
});

describe("account/clause resolve", () => {
  test("the payee shows the preimage and the payer's allocation falls by the amount", () => {
    const after = value(resolveClause(locked, VIEW, "right", leftClause.id, secretOf(1)));
    expect([allocation(after), after.holds]).toEqual([6n, []]);
  });

  test("R-HTLC-CLOCK a clause is live through its deadline height and refused one height later", () => {
    const at = (view: bigint) => resolveClause(locked, viewOf(view), "right", leftClause.id, secretOf(1));
    expect(at(DEADLINE).ok).toBe(true);
    expect(at(DEADLINE + 1n)).toEqual(refused({ _tag: "past_deadline", deadline: DEADLINE, view: DEADLINE + 1n }));
  });

  test("R-CANCEL only the payee resolves", () => {
    const byPayer = resolveClause(locked, VIEW, "left", leftClause.id, secretOf(1));
    expect(byPayer).toEqual(refused({ _tag: "not_payee" }));
  });

  test("a wrong preimage, or one that is not 32 bytes, pays nothing", () => {
    const wrong = resolveClause(locked, VIEW, "right", leftClause.id, secretOf(2));
    expect(wrong).toEqual(refused({ _tag: "wrong_secret" }));
    expect(resolveClause(locked, VIEW, "right", leftClause.id, secretOf(1, 31)))
      .toEqual(refused({ _tag: "bad_secret" }));
    [0, 33, 64].forEach((length) => expect(resolveClause(locked, VIEW, "right", leftClause.id, secretOf(1, length)))
      .toEqual(refused({ _tag: "bad_secret" })));
  });

  test("a clause that is not open cannot be resolved, cancelled or expired", () => {
    const none = holdId(9n);
    expect(resolveClause(locked, VIEW, "right", none, secretOf(9))).toEqual(refused({ _tag: "no_such_lock" }));
    expect(cancelClause(locked, "right", none)).toEqual(refused({ _tag: "no_such_lock" }));
    expect(expireClause(locked, params, viewOf(1_000n), none)).toEqual(refused({ _tag: "no_such_lock" }));
  });

  test("a resolved clause is gone, and another clause stays open", () => {
    const second = holdOf("left", 3n, 2n, DEADLINE);
    const both = value(lockClause(locked, params, VIEW, "left", second));
    const after = value(resolveClause(both, VIEW, "right", second.id, secretOf(2)));
    expect(after.holds).toEqual([leftClause]);
    expect(allocation(after)).toBe(7n);
  });
});

describe("account/clause cancel and expire", () => {
  test("R-CANCEL the payee cancels and the allocation stays; the payer cannot", () => {
    const after = value(cancelClause(locked, "right", leftClause.id));
    expect([allocation(after), after.holds]).toEqual([10n, []]);
    expect(cancelClause(locked, "left", leftClause.id)).toEqual(refused({ _tag: "not_payee" }));
  });

  test("R-HTLC-CLOCK an expiry needs the view strictly past the deadline plus the reserve", () => {
    const at = (view: bigint) => expireClause(locked, params, viewOf(view), leftClause.id);
    expect(at(DEADLINE).ok).toBe(false);
    expect(at(DEADLINE + 2n)).toEqual(refused({ _tag: "not_expired", deadline: DEADLINE, earliest: DEADLINE + 3n }));
    const after = value(at(DEADLINE + 3n));
    expect([allocation(after), after.holds]).toEqual([10n, []]);
  });
});
