// R-HOP-SLACK: a deadline is a J height and the contract compares seconds, so a hub reads each deadline through the
// chain's seconds: the blocks that fit between the head block's second and the deadline's, less the slots the chain may
// miss. It forwards a lock only if every claim it may have to land fits between the two deadlines it holds.
import { describe, expect, test } from "bun:test";
import { err, unwrapOr } from "../../kernel/core/result.ts";
import { draw, heightOf, viewOf } from "../fixtures.ts";
import {
  blocksLeft, clockParams, effectiveDeadline, floorDiv, forwardable, reactOf, type ClockParams, type Pace, type Reading,
} from "./clock.ts";

const PACE: Pace = { slot: 12n, missed: 1n, pollDelay: 2n };
const UNKNOWN = undefined;

const paced = (lag: bigint, reserve: bigint, depth: bigint, pace: Pace = PACE): ClockParams =>
  unwrapOr(clockParams(lag, reserve, 100n, depth, pace), (fault) => expect.unreachable(`refused: ${fault._tag}`));

/** The line through block 100 at second 2200, a block every `blockSeconds`, as the deployment's map has it. */
const line = (blockSeconds: bigint, headSeconds: bigint | undefined): Reading =>
  ({ headSeconds, secondsOf: (deadline) => 2200n + blockSeconds * (deadline - 100n) });

describe("account/clause/pace the chain's seconds in a clock", () => {
  test("R-HOP-SLACK a pace is a positive slot, no negative missed or delay, and a reserve over the reaction", () => {
    expect(clockParams(2n, 5n, 100n, 1n, { slot: 0n, missed: 1n, pollDelay: 2n }))
      .toEqual(err({ _tag: "slot_not_positive", slot: 0n }));
    expect(clockParams(2n, 5n, 100n, 1n, { slot: 12n, missed: -1n, pollDelay: 2n }))
      .toEqual(err({ _tag: "missed_negative", missed: -1n }));
    expect(clockParams(2n, 5n, 100n, 1n, { slot: 12n, missed: 0n, pollDelay: -1n }))
      .toEqual(err({ _tag: "poll_delay_negative", pollDelay: -1n }));
    expect(clockParams(2n, 4n, 100n, 1n, PACE)).toEqual(err({ _tag: "reserve_below_react", reserve: 4n, least: 5n }));
    expect(clockParams(2n, 5n, 100n, 1n, PACE).ok).toBe(true);
    expect(clockParams(2n, 0n, 100n).ok).toBe(false);
  });

  test("R-LAG-ONE the reaction is the depth, the poll delay and the one lag: no second lag is counted", () => {
    expect(reactOf(paced(2n, 5n, 1n))).toBe(1n + 2n + 2n);
    expect(reactOf(paced(3n, 5n, 0n, { ...PACE, pollDelay: 0n }))).toBe(3n);
    expect(reactOf(unwrapOr(clockParams(2n, 4n, 10n), () => expect.unreachable("params")))).toBe(2n);
  });

  test("R-HOP-SLACK blocks are floored toward minus infinity, and missed slots come off the blocks that fit", () => {
    expect([floorDiv(25n, 12n), floorDiv(24n, 12n), floorDiv(-1n, 12n), floorDiv(-12n, 12n), floorDiv(-13n, 12n)])
      .toEqual([2n, 2n, -1n, -1n, -2n]);
    expect(blocksLeft(PACE, 2200n, 2200n + 12n * 5n)).toBe(4n);
    expect(blocksLeft(PACE, 2200n, 2200n + 12n * 5n - 1n)).toBe(3n);
    expect(blocksLeft(PACE, 2300n, 2200n)).toBe(-9n - 1n);
  });

  test("R-HOP-SLACK a deadline is read as sooner, never later: a head second ahead of the line shortens it", () => {
    const clock = paced(2n, 5n, 1n);
    const deadline = heightOf(110n);
    expect(effectiveDeadline(clock, line(12n, 2200n), viewOf(100n), deadline)).toBe(109n);
    expect(effectiveDeadline(clock, line(12n, 2200n + 24n), viewOf(100n), deadline)).toBe(107n);
    expect(effectiveDeadline(clock, line(12n, 2200n - 600n), viewOf(100n), deadline)).toBe(110n);
    expect(effectiveDeadline(clock, line(12n, UNKNOWN), viewOf(100n), deadline)).toBe(100n);
    const bare = unwrapOr(clockParams(2n, 5n, 100n), () => expect.unreachable("params"));
    expect(effectiveDeadline(bare, line(12n, 9999n), viewOf(100n), deadline)).toBe(110n);
  });

  test("R-HOP-SLACK a head second ahead of wall time, or behind it, never lengthens any deadline", () => {
    const clock = paced(2n, 5n, 1n);
    const lengthened = Array.from({ length: 400 }, (_, i) => {
      const view = 90n + BigInt(draw(7, 0, i, 0, 20));
      const deadline = view + BigInt(draw(7, 0, i, 1, 90));
      const ahead = BigInt(draw(7, 0, i, 2, 200)) - 100n;
      const reading = line(BigInt(8 + draw(7, 0, i, 3, 8)), 2200n + 12n * (view - 100n) + ahead * 12n);
      return effectiveDeadline(clock, reading, viewOf(view), heightOf(deadline)) > deadline;
    });
    expect(lengthened.filter(Boolean)).toEqual([]);
  });

  test("R-HOP-SLACK a hub forwards only if both deadlines are live and every claim fits between them", () => {
    const clock = paced(2n, 5n, 1n);
    const hop = clock.reserve + clock.lag;
    const fits = (headSeconds: bigint | undefined, inbound: bigint, missed = 1n): boolean =>
      forwardable({ ...clock, pace: { ...PACE, missed } }, line(12n, headSeconds), viewOf(100n),
        heightOf(inbound), heightOf(inbound - hop));
    expect(fits(2200n, 110n)).toBe(true);
    expect(fits(2200n, 110n, 2n)).toBe(false);
    expect(fits(UNKNOWN, 110n)).toBe(false);
    expect(fits(2200n, 100n + hop + 1n)).toBe(false);
    expect(fits(2200n, 100n + hop + 2n)).toBe(true);
  });

  test("R-HOP-SLACK the blocks the deadlines are apart bind as well as the seconds they are apart", () => {
    const slow = { ...paced(2n, 5n, 1n), reserve: 3n };
    const fits = (clock: ClockParams): boolean =>
      forwardable(clock, line(24n, 2200n), viewOf(100n), heightOf(120n), heightOf(120n - clock.reserve - clock.lag));
    expect(fits(paced(2n, 5n, 1n))).toBe(true);
    expect(fits(slow)).toBe(false);
  });

  test("R-HOP-SLACK a missed slot shortens the blocks that fit, and a forward that no longer fits is refused", () => {
    const clock = paced(2n, 5n, 1n);
    const hop = clock.reserve + clock.lag;
    const at = (slots: bigint): boolean =>
      forwardable(clock, line(12n, 2200n + 12n * slots), viewOf(100n), heightOf(110n), heightOf(110n - hop));
    expect([0n, 1n, 2n, 3n].map(at)).toEqual([true, true, false, false]);
  });

  test("R-HOP-SLACK whenever a forward fits, its two effective deadlines are a reaction and a block apart", () => {
    const apart = Array.from({ length: 30000 }, (_, i) => {
      const lag = BigInt(1 + draw(11, 0, i, 0, 3));
      const depth = BigInt(draw(11, 0, i, 1, 3));
      const pace: Pace = { slot: BigInt(6 + draw(11, 0, i, 2, 10)), missed: BigInt(draw(11, 0, i, 3, 3)),
        pollDelay: BigInt(draw(11, 0, i, 4, 4)) };
      const least = depth + pace.pollDelay + pace.missed + 1n;
      const reserve = (least > lag ? least : lag) + BigInt(draw(11, 0, i, 5, 3));
      const clock = paced(lag, reserve, depth, pace);
      const view = 100n + BigInt(draw(11, 0, i, 6, 50));
      const reading = line(BigInt(6 + draw(11, 0, i, 7, 10)), 2200n + BigInt(draw(11, 0, i, 8, 3000)) - 800n);
      const inbound = view + BigInt(draw(11, 0, i, 9, 80));
      const outbound = inbound - (reserve + lag);
      if (!forwardable(clock, reading, viewOf(view), heightOf(inbound), heightOf(outbound))) return undefined;
      const [early, late] = [effectiveDeadline(clock, reading, viewOf(view), heightOf(outbound)),
        effectiveDeadline(clock, reading, viewOf(view), heightOf(inbound))];
      const capped = (early < outbound ? 1 : 0) + (late < inbound ? 1 : 0);
      return { slack: late - early - reactOf(clock), capped };
    }).filter((x): x is { slack: bigint; capped: number } => x !== undefined);
    expect(apart.filter(({ slack }) => slack < 1n)).toEqual([]);
    const cases = [0, 1, 2].map((n) => apart.filter(({ capped }) => capped === n).length);
    expect(Math.min(...cases)).toBeGreaterThan(20);
  });
});
