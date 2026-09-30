// The registry hides nothing: what it expects is matched by area, seed and text; anything else stays red; an expectation that goes unmet is red.
import { describe, expect, test } from "bun:test";
import { judge } from "./judge.ts";
import type { KnownFinding } from "./known.ts";
import { emptyEntries, ratchet, siteIds } from "./ratchet.ts";

const FINDING: KnownFinding = {
  id: "F",
  basis: { _tag: "rule", id: "R-X" },
  owner: "someone",
  summary: "s",
  sites: [{ area: "disputes", seed: 0x30de2, expects: [{ property: "P2", signature: /P2 \S+→\S+ token \d+ after its signed settlement/ }] }],
};
const BREACH = "WALK_SEED=0x30de2 frame 107 chat: P2 0xa→0xb token 1 after its signed settlement (collateral -1): room left -5";
const OTHER = "WALK_SEED=0x30de2 the walk ended with x still owed: its lifecycle never closed";

describe("the known-findings registry judges a walk's lines", () => {
  test("a registered line on its area and seed is known, not red", () => {
    const judged = judge([FINDING], "disputes", 0x30de2, [BREACH]);
    expect(judged.unknown).toEqual([]);
    expect(judged.known).toHaveLength(1);
    expect(judged.stale).toEqual([]);
  });
  test("the same text on another seed is red", () => {
    expect(judge([FINDING], "disputes", 0x30de3, [BREACH]).unknown).toEqual([BREACH]);
  });
  test("the same text in another area is red", () => {
    expect(judge([FINDING], "settlement", 0x30de2, [BREACH]).unknown).toEqual([BREACH]);
  });
  test("another property or text on the registered seed is red beside the known line", () => {
    const judged = judge([FINDING], "disputes", 0x30de2, [BREACH, OTHER]);
    expect(judged.unknown).toEqual([OTHER]);
    expect(judged.known).toHaveLength(1);
  });
  test("an expected line that no longer appears is red: the finding stopped reproducing, so its entry has to go", () => {
    const judged = judge([FINDING], "disputes", 0x30de2, []);
    expect(judged.stale).toHaveLength(1);
    expect(judged.stale[0]).toContain("KNOWN_FINDING_STALE F on disputes 0x30de2");
  });
  test("a walk with nothing registered and nothing wrong is clean", () => {
    expect(judge([FINDING], "core", 0x30de1, [])).toEqual({ unknown: [], known: [], stale: [] });
  });
});

describe("the registry may only shrink", () => {
  const baseline = siteIds([FINDING]);
  test("a table inside the baseline is clean", () => {
    expect(ratchet([FINDING], baseline, baseline)).toEqual([]);
    expect(ratchet([FINDING], baseline, undefined)).toEqual([]);
  });
  test("a site the baseline lacks is red", () => {
    expect(ratchet([FINDING], [], undefined).map((p) => p._tag)).toEqual(["SiteNotInBaseline"]);
  });
  test("a baseline that holds a site the base commit's baseline lacked is red", () => {
    expect(ratchet([FINDING], baseline, []).map((p) => p._tag)).toEqual(["BaselineGrew"]);
  });
  test("an entry with no owner, no basis or nothing to expect is red", () => {
    expect(emptyEntries([{ ...FINDING, owner: " " }])).toHaveLength(1);
    expect(emptyEntries([{ ...FINDING, basis: { _tag: "rule", id: "" } }])).toHaveLength(1);
    expect(emptyEntries([{ ...FINDING, sites: [{ area: "core", seed: 1, expects: [] }] }])).toHaveLength(1);
  });
});
