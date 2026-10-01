import { describe, expect, test } from "bun:test";
import { err, ok, type Result, unwrapOr } from "../kernel/core/result.ts";
import { admitted, holdOf } from "./fixtures.ts";
import {
  allocation, deposit, emptyLedger, expire, lock as openHold, MAX_AMOUNT, MAX_HOLDS, pay, resolve, room, setCredit,
  withdraw,
} from "./ledger.ts";
import { holdId, type AccountFault, type Hold, type Ledger } from "./model.ts";

/** The money rules' own tests open holds directly, through the test seam: clause rules are tested in clause/. */
const lock = (l: Ledger, hold: Hold): Result<Ledger, AccountFault> => openHold(l, admitted(hold));

const refused = (fault: AccountFault): Result<never, AccountFault> => err(fault);

const value = (r: Result<Ledger, AccountFault>): Ledger =>
  unwrapOr(r, (fault) => expect.unreachable(`refused: ${fault._tag}`));

/** Opens the holds in order; every one must be admitted. */
const lockAll = (l: Ledger, ...holds: readonly Hold[]): Ledger =>
  holds.reduce((acc, hold) => value(lock(acc, hold)), l);

/** Left holds `n` of the collateral (none when `n` is 0), with `credit` extended to Left. */
const leftHolds = (n: bigint, credit = 0n): Ledger =>
  value(setCredit(n === 0n ? emptyLedger : value(deposit(emptyLedger, "left", n)), "right", credit));

describe("account/ledger", () => {
  test("the largest amount is the literal 2^256 - 1, the contract's uint256 ceiling", () => {
    expect(MAX_AMOUNT).toBe(2n ** 256n - 1n);
    expect(MAX_AMOUNT).toBe(115792089237316195423570985008687907853269984665640564039457584007913129639935n);
  });

  test("R-A6 a payment moves the payer's allocation and stops at the payer's room", () => {
    const l = leftHolds(10n, 5n);
    expect(allocation(value(pay(l, "left", 12n)))).toBe(-2n);
    expect(pay(l, "left", 15n).ok).toBe(true);
    expect(pay(l, "left", 16n)).toEqual(refused({ _tag: "insufficient_capacity", available: 15n, requested: 16n }));
    expect(pay(l, "right", 1n)).toEqual(refused({ _tag: "insufficient_capacity", available: 0n, requested: 1n }));
  });

  test("R-A6 Right's room is the collateral and credit above the allocation, less Right's own holds", () => {
    const l = lockAll(value(deposit(emptyLedger, "right", 10n)), holdOf("right", 4n));
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
      expect(lock(l, holdOf("left", amount))).toEqual(badAmount);
      expect(deposit(l, "left", amount)).toEqual(badAmount);
      expect(withdraw(l, "left", amount)).toEqual(badAmount);
    });
  });

  test("R-A6 a hold counts against its payer's room before it pays, and lapsing gives the room back", () => {
    const held = lockAll(leftHolds(10n), holdOf("left", 4n));
    expect(allocation(held)).toBe(10n);
    expect(room(held, "left")).toBe(6n);
    expect(pay(held, "left", 7n)).toEqual(refused({ _tag: "insufficient_capacity", available: 6n, requested: 7n }));
    expect(lock(held, holdOf("left", 7n, 2n)).ok).toBe(false);
    expect(room(value(expire(held, holdId(1n))), "left")).toBe(10n);
  });

  test("R-A6 resolving a hold moves the payer's allocation by its amount and needs no new room", () => {
    const held = lockAll(leftHolds(10n), holdOf("left", 4n, 1n), holdOf("left", 6n, 2n));
    const after = value(resolve(held, holdId(1n)));
    expect(allocation(after)).toBe(6n);
    expect(after.holds).toEqual([holdOf("left", 6n, 2n)]);
    const second = value(resolve(held, holdId(2n)));
    expect([allocation(second), second.holds]).toEqual([4n, [holdOf("left", 4n, 1n)]]);
    expect(resolve(held, holdId(3n))).toEqual(refused({ _tag: "no_such_hold", id: holdId(3n) }));
    expect(expire(held, holdId(0n))).toEqual(refused({ _tag: "no_such_hold", id: holdId(0n) }));
  });

  test("R-A6 and R-CREDIT-REVOKE-FLOOR a credit limit cannot fall below what the other side is using", () => {
    const debt = value(pay(leftHolds(0n, 5n), "left", 5n));
    expect(setCredit(debt, "right", 4n)).toEqual(refused({ _tag: "credit_below_usage" }));
    expect(setCredit(debt, "right", 0n)).toEqual(refused({ _tag: "credit_below_usage" }));
    expect(setCredit(debt, "right", 5n).ok).toBe(true);
    expect(setCredit(debt, "right", 9n).ok).toBe(true);
  });

  test("R-CREDIT-REVOKE-FLOOR an open hold is used credit too, and Right's side has its own floor", () => {
    const held = lockAll(leftHolds(0n, 5n), holdOf("left", 3n));
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
    const held = lockAll(value(deposit(emptyLedger, "right", 10n)), holdOf("right", 4n));
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

  test("R-A6 the largest amount, 2^256-1, is taken by every transition that takes one", () => {
    const funded = value(setCredit(value(deposit(emptyLedger, "left", MAX_AMOUNT)), "right", MAX_AMOUNT));
    expect(pay(funded, "left", MAX_AMOUNT).ok).toBe(true);
    expect(lock(funded, holdOf("left", MAX_AMOUNT)).ok).toBe(true);
    expect(withdraw(funded, "left", MAX_AMOUNT).ok).toBe(true);
    expect(deposit(emptyLedger, "right", MAX_AMOUNT).ok).toBe(true);
  });

  test("R-A6 one side's holds cannot add up past 2^256-1, even with credit to cover them", () => {
    const funded = value(setCredit(value(deposit(emptyLedger, "left", MAX_AMOUNT)), "right", MAX_AMOUNT));
    const nearly = lockAll(funded, holdOf("left", MAX_AMOUNT - 1n, 1n));
    const overflow = refused({ _tag: "hold_overflow", held: MAX_AMOUNT - 1n, requested: 2n });
    expect(lock(nearly, holdOf("left", 2n, 2n))).toEqual(overflow);
    expect(lock(nearly, holdOf("left", 1n, 2n)).ok).toBe(true);
    expect(lock(lockAll(funded, holdOf("left", 1n)), holdOf("right", MAX_AMOUNT, 2n)).ok).toBe(false);
  });

  test("R-A6 payments and resolved holds move offdelta, which both sides sign, never ondelta", () => {
    const l = leftHolds(10n, 5n);
    const paidOut = value(pay(l, "left", 12n));
    expect([paidOut.offdelta, paidOut.ondelta]).toEqual([-12n, 10n]);
    const resolved = value(resolve(lockAll(l, holdOf("left", 4n)), holdId(1n)));
    expect([resolved.offdelta, resolved.ondelta]).toEqual([-4n, 10n]);
    const rightPays = value(pay(value(deposit(emptyLedger, "right", 10n)), "right", 3n));
    expect([rightPays.offdelta, rightPays.ondelta]).toEqual([3n, 0n]);
  });

  test("R-HOLD-SLOT expiring a hold removes the one it names and keeps the others in order", () => {
    const held = lockAll(leftHolds(10n), holdOf("left", 4n, 1n), holdOf("left", 6n, 2n));
    expect(value(expire(held, holdId(1n))).holds).toEqual([holdOf("left", 6n, 2n)]);
    expect(value(expire(held, holdId(2n))).holds).toEqual([holdOf("left", 4n, 1n)]);
  });

  test("R-HOLD-SLOT a hold keeps its slot while others come and go", () => {
    const held = lockAll(leftHolds(10n), holdOf("left", 1n, 1n), holdOf("left", 2n, 2n), holdOf("left", 3n, 3n));
    const afterFirst = value(resolve(held, holdId(1n)));
    const afterSecond = value(resolve(afterFirst, holdId(2n)));
    expect(afterSecond.holds).toEqual([holdOf("left", 3n, 3n)]);
    expect(allocation(afterSecond)).toBe(7n);
  });

  test("R-LOCK-EXISTS a slot that is open is refused, and a freed slot opens again", () => {
    const held = lockAll(leftHolds(10n), holdOf("left", 4n, 1n));
    expect(lock(held, holdOf("right", 1n, 1n))).toEqual(refused({ _tag: "lock_exists", id: holdId(1n) }));
    expect(lock(value(expire(held, holdId(1n))), holdOf("left", 1n, 1n)).ok).toBe(true);
  });

  test("R-HOLD-CAP at most 32 holds are open, matching the contract's proof bound", () => {
    const slots = Array.from({ length: MAX_HOLDS }, (_, i) => holdOf("left", 1n, BigInt(i)));
    const full = lockAll(leftHolds(100n), ...slots);
    expect(full.holds.length).toBe(32);
    expect(lock(full, holdOf("left", 1n, 32n))).toEqual(refused({ _tag: "too_many_holds", max: 32 }));
    expect(lock(value(expire(full, holdId(7n))), holdOf("left", 1n, 32n)).ok).toBe(true);
  });

  test("a Left deposit is Left's allocation and a Right deposit is Right's", () => {
    const left = value(deposit(emptyLedger, "left", 7n));
    const right = value(deposit(emptyLedger, "right", 7n));
    expect([allocation(left), left.collateral]).toEqual([7n, 7n]);
    expect([allocation(right), right.collateral]).toEqual([0n, 7n]);
  });
});
