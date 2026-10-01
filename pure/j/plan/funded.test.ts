// R-FUNDED: the planner signs a reserve payment only if the reserve, net of debt, covers it.
import { describe, expect, test } from "bun:test";
import { covers, fundedFirst, movementsOf, spendable } from "./funded.ts";
import {
  ME, LEFT_PEER, RIGHT_PEER, TOKEN, counter, deposit, finalize, fund, holdings, reserveToExternal, reserveToReserve,
  settle, start, withdraw,
} from "../fixtures.ts";

const TWO = TOKEN + 1n;

describe("R-FUNDED the spendable reserve nets every outstanding debt", () => {
  test("reserve less debt, never below zero, per token", () => {
    const t = holdings([TOKEN, 10n, 7n], [TWO, 5n, 9n]);
    expect(spendable(t, TOKEN)).toBe(3n);
    expect(spendable(t, TWO)).toBe(0n);
    expect(spendable(t, 99n)).toBe(0n);
  });
  test("a payment above the net waits, and one at the net goes (debt 7 of reserve 10)", () => {
    const t = holdings([TOKEN, 10n, 7n]);
    expect(covers(ME, t, [reserveToReserve(4n)])).toBe(false);
    expect(covers(ME, t, [reserveToReserve(3n)])).toBe(true);
  });
  test("a debt above the reserve leaves nothing to spend, and a deposit afterwards does not hide it", () => {
    const t = holdings([TOKEN, 5n, 9n]);
    expect(covers(ME, t, [reserveToReserve(1n)])).toBe(false);
    expect(covers(ME, t, [deposit(3n), reserveToReserve(1n)])).toBe(false);
    expect(covers(ME, t, [deposit(5n), reserveToReserve(1n)])).toBe(true);
  });
});

describe("R-FUNDED oldest first, and one that does not fit waits while a younger one that fits goes", () => {
  const t = holdings([TOKEN, 10n, 0n]);
  test("the first payment takes the reserve and the second waits", () => {
    const [first, second] = [reserveToReserve(6n), reserveToReserve(6n)];
    expect(fundedFirst(ME, t, [first, second])).toEqual({ funded: [first], waiting: [second] });
  });
  test("a payment that does not fit is skipped and a later one that does is sent", () => {
    const [big, mid, small] = [reserveToReserve(8n), reserveToReserve(3n), reserveToReserve(2n)];
    expect(fundedFirst(ME, t, [big, mid, small])).toEqual({ funded: [big, small], waiting: [mid] });
  });
  test("a payment larger than the whole reserve never goes, whatever is behind it", () => {
    const [huge, ok] = [reserveToReserve(11n), reserveToReserve(10n)];
    expect(fundedFirst(ME, t, [huge, ok])).toEqual({ funded: [ok], waiting: [huge] });
  });
  test("an empty plan has nothing to send", () => expect(fundedFirst(ME, t, [])).toEqual({ funded: [], waiting: [] }));
});

describe("R-FUNDED every reserve outflow is judged, not only a payment to another entity", () => {
  const t = holdings([TOKEN, 5n, 0n]);
  test("a funding of an Account sums its pairs", () => {
    expect(covers(ME, t, [fund(LEFT_PEER, 3n, 3n)])).toBe(false);
    expect(covers(ME, t, [fund(LEFT_PEER, 3n, 2n)])).toBe(true);
  });
  test("a withdrawal to an external token and a reserve transfer share one reserve", () => {
    expect(covers(ME, t, [reserveToExternal(3n), reserveToReserve(3n)])).toBe(false);
    expect(covers(ME, t, [reserveToExternal(3n), reserveToReserve(2n)])).toBe(true);
  });
  test("a settlement spends only its own side's change: mine is the left diff when I am Left", () => {
    expect(covers(ME, t, [settle(RIGHT_PEER, -6n)])).toBe(false);
    expect(covers(ME, t, [settle(RIGHT_PEER, -5n)])).toBe(true);
    expect(covers(ME, t, [settle(LEFT_PEER, -6n)])).toBe(false);
    expect(covers(ME, t, [settle(LEFT_PEER, -5n)])).toBe(true);
    expect(covers(ME, t, [settle(LEFT_PEER, 9n)])).toBe(true);
  });
  test("another token's reserve does not pay for this one", () => {
    expect(covers(ME, holdings([TWO, 100n, 0n]), [reserveToReserve(1n)])).toBe(false);
  });
});

describe("R-FUNDED the reserve is judged in the order the contract applies the ops", () => {
  const t = holdings([TOKEN, 8n, 0n]);
  test("a withdrawal from collateral lands before a funding, so it pays for it (C2R then R2C)", () => {
    expect(covers(ME, t, [fund(LEFT_PEER, 12n), withdraw(RIGHT_PEER, 5n)])).toBe(true);
  });
  test("a funding does not pay for a payment: reserve transfers run first", () => {
    expect(covers(ME, t, [fund(LEFT_PEER, 8n), reserveToReserve(1n)])).toBe(false);
  });
  test("a deposit runs before every payment of the batch", () => {
    expect(covers(ME, t, [reserveToReserve(10n), deposit(2n)])).toBe(true);
  });
});

describe("what a plan cannot count on", () => {
  test("a dispute op moves no reserve in the plan", () => {
    const disputes = [start(LEFT_PEER), counter(LEFT_PEER), finalize(LEFT_PEER)];
    disputes.forEach((op) => expect(movementsOf(ME, op)).toEqual([]));
  });
});
