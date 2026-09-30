import { describe, expect, test } from "bun:test";
import { err, ok, unwrapOr } from "../../kernel/core/result.ts";
import { heightOf, viewOf } from "../fixtures.ts";
import {
  clockParams, expirableAt, jHeight, latestDeadline, liveAt, MAX_HEIGHT, ownView, revealOnChainDue, type ClockParams,
} from "./clock.ts";

const params = (lag: bigint, reserve: bigint, horizon = 10n): ClockParams =>
  unwrapOr(clockParams(lag, reserve, horizon), (fault) => expect.unreachable(`refused: ${fault._tag}`));

const range = (n: number): readonly bigint[] => Array.from({ length: n }, (_, i) => BigInt(i));

describe("account/clause/clock", () => {
  test("R-HTLC-CLOCK the reserve is at least the lag, and the horizon is positive", () => {
    expect(clockParams(2n, 1n, 10n)).toEqual(err({ _tag: "reserve_below_lag", lag: 2n, reserve: 1n }));
    expect(clockParams(2n, 2n, 10n).ok).toBe(true);
    expect(clockParams(0n, 0n, 0n)).toEqual(err({ _tag: "horizon_not_positive", maxLockHorizon: 0n }));
  });

  test("R-HTLC-CLOCK a negative lag is refused, so no clause is ever live and expirable at once", () => {
    expect(clockParams(-1n, -1n, 10n)).toEqual(err({ _tag: "lag_negative", lag: -1n }));
    expect(clockParams(-5n, 0n, 10n)).toEqual(err({ _tag: "lag_negative", lag: -5n }));
    expect(clockParams(0n, 0n, 10n).ok).toBe(true);
  });

  test("a height is 0 .. 2^256-1: each edge is admitted and the step past it is refused", () => {
    expect(jHeight(0n)).toEqual(ok(heightOf(0n)));
    expect(jHeight(MAX_HEIGHT)).toEqual(ok(heightOf(MAX_HEIGHT)));
    expect(jHeight(-1n)).toEqual(err({ _tag: "bad_height", height: -1n }));
    expect(jHeight(MAX_HEIGHT + 1n)).toEqual(err({ _tag: "bad_height", height: MAX_HEIGHT + 1n }));
  });

  test("R-CLOCK the view a party acts on is the later of the host's finalized height and the context's", () => {
    expect(ownView(heightOf(7n), heightOf(5n))).toBe(viewOf(7n));
    expect(ownView(heightOf(5n), heightOf(7n))).toBe(viewOf(7n));
    expect(ownView(heightOf(6n), heightOf(6n))).toBe(viewOf(6n));
    expect(ownView(heightOf(MAX_HEIGHT), heightOf(0n))).toBe(viewOf(MAX_HEIGHT));
  });

  test("R-CLOCK a frame stamp is a bigint, and a view or a deadline has to be made: the types refuse the stamp", () => {
    const stamp = 12n;
    // @ts-expect-error a bigint stamp is not a JView
    expect(liveAt(heightOf(5n), stamp)).toBe(false);
    // @ts-expect-error a bigint stamp is not a JHeight
    expect(liveAt(stamp, viewOf(5n))).toBe(true);
    // @ts-expect-error the view door takes heights, not stamps
    expect(ownView(stamp, stamp)).toBe(viewOf(stamp));
  });

  test("R-HTLC-CLOCK a clause is live through its deadline, expirable strictly past deadline plus reserve", () => {
    const p = params(1n, 2n);
    const live = [4n, 5n, 6n].map((view) => liveAt(heightOf(5n), viewOf(view)));
    expect(live).toEqual([true, true, false]);
    const expirable = [6n, 7n, 8n].map((view) => expirableAt(p, heightOf(5n), viewOf(view)));
    expect(expirable).toEqual([false, false, true]);
  });

  test("R-HTLC-CLOCK and R-DRIFT views within the lag never see a clause both live and expirable", () => {
    const grid = range(6).flatMap((lag) => range(4).flatMap((extra) => range(8).flatMap((deadline) =>
      range(14).flatMap((viewA) => range(14)
        .filter((viewB) => (viewA > viewB ? viewA - viewB : viewB - viewA) <= lag)
        .map((viewB) => ({ p: params(lag, lag + extra), deadline: heightOf(deadline), viewA, viewB }))))));
    expect(grid.length).toBeGreaterThan(10_000);
    grid.forEach(({ p, deadline, viewA, viewB }) => {
      if (expirableAt(p, deadline, viewOf(viewA))) expect(liveAt(deadline, viewOf(viewB))).toBe(false);
      if (expirableAt(p, deadline, viewOf(viewA))) expect(viewB > deadline).toBe(true);
    });
  });

  test("R-HTLC-CLOCK a payee reveals on chain once its view reaches the deadline minus the lag", () => {
    const p = params(2n, 2n);
    const due = [7n, 8n, 9n].map((view) => revealOnChainDue(p, heightOf(10n), viewOf(view)));
    expect(due).toEqual([false, true, true]);
  });

  test("R-HTLC-CLOCK the reveal is due a lag before the deadline, not a reserve before it", () => {
    const p = params(2n, 5n);
    const due = [7n, 8n, 5n].map((view) => revealOnChainDue(p, heightOf(10n), viewOf(view)));
    expect(due).toEqual([false, true, false]);
  });

  test("R-HORIZON-RESERVE the latest admitted deadline is the view plus the horizon plus the reserve", () => {
    expect(latestDeadline(params(1n, 3n, 10n), viewOf(100n))).toBe(113n);
  });
});
