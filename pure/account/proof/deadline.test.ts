import { describe, expect, test } from "bun:test";
import { unwrapOr } from "../../kernel/core/result.ts";
import { heightOf, holdOf, tokenOf } from "../fixtures.ts";
import { emptyLedger } from "../ledger.ts";
import { emptyAccount, withLedger } from "../state.ts";
import { proofBodyOf, type ProofTerms } from "./body.ts";
import { deadlineSeconds, timeMapOf, type TimeMap } from "./deadline.ts";

const MAP: TimeMap = { anchorHeight: 100n, anchorSeconds: 5_000n, blockSeconds: 12n, slackSeconds: 30n };
const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T =>
  unwrapOr(r, (e) => expect.unreachable(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? `${v}n` : v))));

describe("account/proof R-DEADLINE-TIMESTAMP a deadline in J height is one function of the time map", () => {
  const seconds = deadlineSeconds(must(timeMapOf(MAP)));

  test("it is the anchor's second, a block time per block after the anchor, and the slack on top", () => {
    expect(seconds(heightOf(100n))).toBe(5_030n);
    expect(seconds(heightOf(110n))).toBe(5_150n);
    expect(seconds(heightOf(110n)) - seconds(heightOf(100n))).toBe(120n);
  });

  test("a later deadline is a later second, strictly, whatever the slack: the order of the hops is kept", () => {
    const slacks = [0n, 1n, 600n].map((slackSeconds) => deadlineSeconds({ ...MAP, slackSeconds }));
    slacks.forEach((at) => expect([at(heightOf(101n)) < at(heightOf(102n)), at(heightOf(102n)) < at(heightOf(103n))])
      .toEqual([true, true]));
  });

  test("the slack moves every deadline by the same amount, and only the slack", () => {
    const more = deadlineSeconds({ ...MAP, slackSeconds: MAP.slackSeconds + 7n });
    [100n, 105n, 140n].forEach((h) => expect(more(heightOf(h)) - seconds(heightOf(h))).toBe(7n));
  });

  test("a map that could run backwards, or start before time, is refused", () => {
    const fault = (m: Partial<TimeMap>) => {
      const r = timeMapOf({ ...MAP, ...m });
      return r.ok ? "ok" : r.error._tag;
    };
    expect([fault({}), fault({ blockSeconds: 0n }), fault({ blockSeconds: -12n }), fault({ slackSeconds: -1n }),
      fault({ anchorHeight: -1n }), fault({ anchorSeconds: -1n })])
      .toEqual(["ok", "block_time_not_positive", "block_time_not_positive", "slack_negative", "anchor_negative",
        "anchor_negative"]);
  });

  test("the proof body signs the second the map gives, and refuses a deadline too far before the anchor", () => {
    const termsFor = (m: TimeMap): ProofTerms => ({
      watchSeed: `0x${"9b".repeat(32)}`, leftResponseSeconds: 60n, rightResponseSeconds: 60n,
      transformer: `0x${"bd".repeat(20)}`, secondsOf: deadlineSeconds(m),
    });
    const held = (deadline: bigint) =>
      withLedger(emptyAccount, tokenOf(1n), { ...emptyLedger, holds: [holdOf("left", 2n, 1n, deadline)] });
    expect(must(proofBodyOf(termsFor(MAP), held(104n))).transformers).toHaveLength(1);
    const young = { ...MAP, anchorSeconds: 600n, slackSeconds: 0n };
    expect(proofBodyOf(termsFor(young), held(0n))).toEqual({
      ok: false, error: { _tag: "deadline_not_positive", seconds: -600n },
    });
  });
});
