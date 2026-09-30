import { describe, expect, test } from "bun:test";
import { err, unwrapOr } from "../../kernel/core/result.ts";
import {
  clockParams, expirableAt, latestDeadline, liveAt, ownView, revealOnChainDue, type ClockParams,
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

  test("R-CLOCK the view a party acts on is the later of the host's finalized height and the context's", () => {
    expect(ownView(7n, 5n)).toBe(7n);
    expect(ownView(5n, 7n)).toBe(7n);
    expect(ownView(6n, 6n)).toBe(6n);
  });

  test("R-HTLC-CLOCK a clause is live through its deadline, expirable strictly past deadline plus reserve", () => {
    const p = params(1n, 2n);
    expect([liveAt(5n, 4n), liveAt(5n, 5n), liveAt(5n, 6n)]).toEqual([true, true, false]);
    expect([expirableAt(p, 5n, 6n), expirableAt(p, 5n, 7n), expirableAt(p, 5n, 8n)]).toEqual([false, false, true]);
  });

  test("R-HTLC-CLOCK and R-DRIFT views within the lag never see a clause both live and expirable", () => {
    const grid = range(6).flatMap((lag) => range(4).flatMap((extra) => range(8).flatMap((deadline) =>
      range(14).flatMap((viewA) => range(14)
        .filter((viewB) => (viewA > viewB ? viewA - viewB : viewB - viewA) <= lag)
        .map((viewB) => ({ p: params(lag, lag + extra), deadline, viewA, viewB }))))));
    expect(grid.length).toBeGreaterThan(10_000);
    grid.forEach(({ p, deadline, viewA, viewB }) => {
      if (expirableAt(p, deadline, viewA)) expect(liveAt(deadline, viewB)).toBe(false);
      if (expirableAt(p, deadline, viewA)) expect(viewB > deadline).toBe(true);
    });
  });

  test("R-HTLC-CLOCK a payee reveals on chain once its view reaches the deadline minus the lag", () => {
    const p = params(2n, 2n);
    expect([revealOnChainDue(p, 10n, 7n), revealOnChainDue(p, 10n, 8n), revealOnChainDue(p, 10n, 9n)])
      .toEqual([false, true, true]);
  });

  test("R-HORIZON-RESERVE the latest admitted deadline is the view plus the horizon plus the reserve", () => {
    expect(latestDeadline(params(1n, 3n, 10n), 100n)).toBe(113n);
  });
});
