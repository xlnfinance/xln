// Reviewer A of #69: a registered line that is missing is stale even when other lines are there; the ratchet itself carries the empty-entry rule.
import { expect, test } from "bun:test";
import { judge } from "./judge.ts";
import type { KnownFinding } from "./known.ts";
import { ratchet, siteLines } from "./ratchet.ts";

const BREACH = "WALK_SEED=0x1 frame 3 chat: P2 breach on token 1";
const UNCLOSED = "WALK_SEED=0x1 the walk ended with disputes:deadline still owed";
const FINDING: KnownFinding = {
  id: "F", basis: { _tag: "rule", id: "R-X" }, owner: "someone", summary: "s",
  sites: [{ area: "disputes", seed: 1, expects: [{ property: "P2", line: BREACH }, { property: "walk", line: UNCLOSED }] }],
};
const RULES = ["R-X"];
const BASELINE = Object.fromEntries(siteLines([FINDING]));

test("an expectation that did not appear is stale although another registered line did", () => {
  const judged = judge([FINDING], "disputes", 1, [BREACH]);
  expect(judged.known).toHaveLength(1);
  expect(judged.stale).toHaveLength(1);
  expect(judged.stale[0]).toContain("still owed");
});

test("an unrelated line does not satisfy an expectation either", () => {
  const judged = judge([FINDING], "disputes", 1, ["WALK something else"]);
  expect(judged.stale).toHaveLength(2);
  expect(judged.unknown).toEqual(["WALK something else"]);
});

test("ratchet itself reports an entry with no owner, no sites or nothing to expect, not only emptyEntries does", () => {
  expect(ratchet([{ ...FINDING, owner: "" }], RULES, BASELINE, undefined).map((p) => p._tag)).toEqual(["EmptyEntry"]);
  expect(ratchet([{ ...FINDING, sites: [] }], RULES, {}, undefined).map((p) => p._tag)).toEqual(["EmptyEntry"]);
});
