import { describe, expect, test } from "bun:test";
import { err, ok, type Result, unwrapOr } from "../kernel/core/result.ts";
import {
  allocation, deposit, emptyLedger, expire, lock, MAX_AMOUNT, pay, resolve, room, setCredit, withdraw,
} from "./ledger.ts";
import type { AccountFault, Ledger } from "./model.ts";

const refused = (fault: AccountFault): Result<never, AccountFault> => err(fault);

const value = (r: Result<Ledger, AccountFault>): Ledger =>
  unwrapOr(r, (fault) => expect.unreachable(`refused: ${fault._tag}`));

/** Left holds `n` of the collateral (none when `n` is 0), with `credit` extended to Left. */
const leftHolds = (n: bigint, credit = 0n): Ledger =>
  value(setCredit(n === 0n ? emptyLedger : value(deposit(emptyLedger, "left", n)), "right", credit));

describe("account/ledger", () => {
  test("R-A6 a payment moves the payer's allocation and stops at the payer's room", () => {
    const l = leftHolds(10n, 5n);
    expect(allocation(value(pay(l, "left", 12n)))).toBe(-2n);
    expect(pay(l, "left", 15n).ok).toBe(true);
    expect(pay(l, "left", 16n)).toEqual(refused({ _tag: "insufficient_capacity", available: 15n, requested: 16n }));
    expect(pay(l, "right", 1n)).toEqual(refused({ _tag: "insufficient_capacity", available: 0n, requested: 1n }));
  });

  test("R-A6 Right's room is the collateral and credit above the allocation, less Right's own holds", () => {
    const l = value(lock(value(deposit(emptyLedger, "right", 10n)), "right", 4n));
    expect(room(l, "right")).toBe(6n);
    expect(pay(l, "right", 7n)).toEqual(refused({ _tag: "insufficient_capacity", available: 6n, requested: 7n }));
    expect(room(value(setCredit(l, "left", 3n)), "right")).toBe(9n);
  });

  test("R-A6 a ledger already outside its credit has no room, never negative room", () => {
    const over: Ledger = { ...emptyLedger, collateral: 5n, offdelta: 8n };
    expect([room(over, "right"), room(over, "left")]).toEqual([0n, 8n]);
    expect(pay(over, "right", 1n)).toEqual(refused({ _tag: "insufficient_capacity", available: 0n, requested: 1n }));
    const under: Ledger = { ...emptyLedger, offdelta: -3n };
    expect(room(under, "left")).toBe(0n);
  });

  test("R-A6 an amount outside 1 .. 2^256-1 is refused for every transition that takes one", () => {
    const l = leftHolds(10n);
    [0n, -1n, MAX_AMOUNT + 1n].forEach((amount) => {
      const badAmount = refused({ _tag: "bad_amount", amount });
      expect(pay(l, "left", amount)).toEqual(badAmount);
      expect(lock(l, "left", amount)).toEqual(badAmount);
      expect(deposit(l, "left", amount)).toEqual(badAmount);
      expect(withdraw(l, "left", amount)).toEqual(badAmount);
    });
  });

  test("R-A6 a hold counts against its payer's room before it pays, and lapsing gives the room back", () => {
    const held = value(lock(leftHolds(10n), "left", 4n));
    expect(allocation(held)).toBe(10n);
    expect(room(held, "left")).toBe(6n);
    expect(pay(held, "left", 7n)).toEqual(refused({ _tag: "insufficient_capacity", available: 6n, requested: 7n }));
    expect(lock(held, "left", 7n).ok).toBe(false);
    expect(room(value(expire(held, 0)), "left")).toBe(10n);
  });

  test("R-A6 resolving a hold moves the payer's allocation by its amount and needs no new room", () => {
    const held = value(lock(value(lock(leftHolds(10n), "left", 4n)), "left", 6n));
    const after = value(resolve(held, 0));
    expect(allocation(after)).toBe(6n);
    expect(after.holds).toEqual([{ payer: "left", amount: 6n }]);
    const second = value(resolve(held, 1));
    expect([allocation(second), second.holds]).toEqual([4n, [{ payer: "left", amount: 4n }]]);
    expect(resolve(held, 2)).toEqual(refused({ _tag: "no_such_hold", index: 2 }));
    expect(expire(held, -1)).toEqual(refused({ _tag: "no_such_hold", index: -1 }));
  });

  test("R-A6 and R-CREDIT-REVOKE-FLOOR a credit limit cannot fall below what the other side is using", () => {
    const debt = value(pay(leftHolds(0n, 5n), "left", 5n));
    expect(setCredit(debt, "right", 4n)).toEqual(refused({ _tag: "credit_below_usage" }));
    expect(setCredit(debt, "right", 0n)).toEqual(refused({ _tag: "credit_below_usage" }));
    expect(setCredit(debt, "right", 5n).ok).toBe(true);
    expect(setCredit(debt, "right", 9n).ok).toBe(true);
  });

  test("R-CREDIT-REVOKE-FLOOR an open hold is used credit too, and Right's side has its own floor", () => {
    const held = value(lock(leftHolds(0n, 5n), "left", 3n));
    expect(setCredit(held, "right", 2n)).toEqual(refused({ _tag: "credit_below_usage" }));
    expect(setCredit(held, "right", 3n).ok).toBe(true);
    const owed = value(pay(value(setCredit(leftHolds(10n), "left", 4n)), "right", 4n));
    expect(setCredit(owed, "left", 3n)).toEqual(refused({ _tag: "credit_below_usage" }));
    expect(setCredit(owed, "left", 4n).ok).toBe(true);
  });

  test("R-A6 a credit limit outside 0 .. 2^256-1 is refused", () => {
    const l = leftHolds(10n);
    expect(setCredit(l, "right", -1n)).toEqual(refused({ _tag: "bad_credit", limit: -1n }));
    expect(setCredit(l, "right", MAX_AMOUNT + 1n)).toEqual(refused({ _tag: "bad_credit", limit: MAX_AMOUNT + 1n }));
    expect(setCredit(l, "right", MAX_AMOUNT).ok).toBe(true);
  });

  test("R-SETTLE-CREDIT a withdrawal that leaves the allocation above the collateral is refused", () => {
    const l = value(pay(value(deposit(emptyLedger, "right", 10n)), "right", 4n));
    expect(withdraw(l, "right", 7n)).toEqual(refused({ _tag: "settlement_breaks_credit" }));
    expect(withdraw(l, "right", 6n)).toEqual(ok({ ...l, collateral: 4n }));
  });

  test("R-SETTLE-CREDIT a Left withdrawal that leaves Left past its credit is refused", () => {
    const l = value(pay(leftHolds(10n, 5n), "left", 12n));
    expect(withdraw(l, "left", 8n)).toEqual(refused({ _tag: "settlement_breaks_credit" }));
    expect(allocation(value(withdraw(l, "left", 3n)))).toBe(-5n);
  });

  test("R-SETTLE-CREDIT a withdrawal counts the open holds as paid", () => {
    const held = value(lock(value(deposit(emptyLedger, "right", 10n)), "right", 4n));
    expect(withdraw(held, "right", 7n)).toEqual(refused({ _tag: "settlement_breaks_credit" }));
    expect(withdraw(held, "right", 6n).ok).toBe(true);
  });

  test("R-A2 a withdrawal cannot take more than the collateral, on either side", () => {
    const l = leftHolds(10n);
    const beyond = refused({ _tag: "withdrawal_beyond_collateral", collateral: 10n, requested: 11n });
    expect(withdraw(l, "left", 11n)).toEqual(beyond);
    expect(withdraw(l, "left", 10n).ok).toBe(true);
    const right = value(deposit(emptyLedger, "right", 10n));
    expect(withdraw(right, "right", 11n)).toEqual(beyond);
    expect(withdraw(right, "right", 10n).ok).toBe(true);
  });

  test("a Left deposit is Left's allocation and a Right deposit is Right's", () => {
    const left = value(deposit(emptyLedger, "left", 7n));
    const right = value(deposit(emptyLedger, "right", 7n));
    expect([allocation(left), left.collateral]).toEqual([7n, 7n]);
    expect([allocation(right), right.collateral]).toEqual([0n, 7n]);
  });
});
