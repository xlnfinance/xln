// The registry hides nothing: what it expects is matched by area, seed and the whole line, once; anything else stays red; an expectation that goes unmet is red.
import { describe, expect, test } from "bun:test";
import { judge } from "./judge.ts";
import type { KnownFinding } from "./known.ts";
import { duplicates, emptyEntries, ratchet, siteIds, unknownRules } from "./ratchet.ts";

const BREACH = "WALK_SEED=0x30de2 frame 107 chat: P2 0xa→0xb token 1 after its signed settlement (collateral -1): room left -5 right 9";
const OTHER = "WALK_SEED=0x30de2 the walk ended with x still owed: its lifecycle never closed";
const FINDING: KnownFinding = {
  id: "F",
  basis: { _tag: "rule", id: "R-X" },
  owner: "someone",
  summary: "s",
  sites: [{ area: "disputes", seed: 0x30de2, expects: [{ property: "P2", line: BREACH }] }],
};
const RULES = ["R-X"];

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
  test("a line of the same shape but other numbers, or with text after it, is another breach and red", () => {
    const otherNumbers = BREACH.replace("room left -5", "room left -6");
    const judged = judge([FINDING], "disputes", 0x30de2, [otherNumbers, `${BREACH} and more`]);
    expect(judged.unknown).toEqual([otherNumbers, `${BREACH} and more`]);
    expect(judged.stale).toHaveLength(1);
  });
  test("the registered line twice is one known line and one red line: an expectation covers one line", () => {
    const judged = judge([FINDING], "disputes", 0x30de2, [BREACH, BREACH]);
    expect(judged.known).toHaveLength(1);
    expect(judged.unknown).toEqual([BREACH]);
  });
});

describe("the registry may only shrink", () => {
  const baseline = Object.fromEntries(siteIds([FINDING]).map((id) => [id, 1]));
  test("a table inside the baseline is clean", () => {
    expect(ratchet([FINDING], RULES, baseline, baseline)).toEqual([]);
    expect(ratchet([FINDING], RULES, baseline, undefined)).toEqual([]);
  });
  test("a site the baseline lacks is red", () => {
    expect(ratchet([FINDING], RULES, {}, undefined).map((p) => p._tag)).toEqual(["SiteNotInBaseline"]);
  });
  test("a renamed entry is a new site: red, and editing the baseline to match is red against the base", () => {
    const renamed = { ...FINDING, id: "F2" };
    expect(ratchet([renamed], RULES, baseline, baseline).map((p) => p._tag)).toEqual(["SiteNotInBaseline"]);
    expect(ratchet([renamed], RULES, { "F2@disputes:0x30de2": 1 }, baseline).map((p) => p._tag)).toEqual(["BaselineGrew"]);
  });
  test("an extra expected line at an existing site is red, and raising the baseline for it is red against the base", () => {
    const wider = { ...FINDING, sites: [{ ...FINDING.sites[0]!, expects: [...FINDING.sites[0]!.expects, { property: "any", line: OTHER }] }] };
    expect(ratchet([wider], RULES, baseline, baseline).map((p) => p._tag)).toEqual(["SiteGrew"]);
    expect(ratchet([wider], RULES, { "F@disputes:0x30de2": 2 }, baseline).map((p) => p._tag)).toEqual(["BaselineGrew"]);
  });
  test("a baseline that holds a site the base commit's baseline lacked is red", () => {
    expect(ratchet([FINDING], RULES, baseline, {}).map((p) => p._tag)).toEqual(["BaselineGrew"]);
  });
  test("an entry written twice is red: the second copy would add expectations the baseline never counted", () => {
    expect(duplicates([FINDING, FINDING]).map((p) => p._tag)).toEqual(["DuplicateSite"]);
    expect(ratchet([FINDING, FINDING], RULES, baseline, baseline).map((p) => p._tag)).toContain("DuplicateSite");
  });
  test("a rule id that is not a live row of the register is red", () => {
    expect(unknownRules([FINDING], ["R-OTHER"]).map((p) => p._tag)).toEqual(["UnknownRule"]);
    expect(unknownRules([{ ...FINDING, basis: { _tag: "og-bug", why: "og halts" } }], [])).toEqual([]);
  });
  test("an entry with no owner, no basis or nothing to expect is red", () => {
    expect(emptyEntries([{ ...FINDING, owner: " " }])).toHaveLength(1);
    expect(emptyEntries([{ ...FINDING, basis: { _tag: "rule", id: "" } }])).toHaveLength(1);
    expect(emptyEntries([{ ...FINDING, sites: [{ area: "core", seed: 1, expects: [] }] }])).toHaveLength(1);
    expect(emptyEntries([{ ...FINDING, sites: [{ area: "core", seed: 1, expects: [{ property: "P2", line: " " }] }] }])).toHaveLength(1);
  });
});
