/**
 * MDL collapse optimizer — behavioral + correctness proof (formally-correct
 * grammar model). Beyond "decisions look right," these pin the properties the
 * design's optimality claim rests on, and regression-guard the def/ref
 * double-count bug present in the first prototype.
 */
import { describe, expect, it } from "vitest";

import { collapseMDL } from "../analysis/mdl-collapse.js";
import type { CandidateBox } from "../analysis/trace-to-forest.js";

const box = (over: Partial<CandidateBox> & Pick<CandidateBox, "id" | "type" | "n" | "localBits">): CandidateBox => ({
  children: [],
  ...over,
});

/** gepa shape: ×K loop whose body contains a ×N persona fan-out. */
const gepaForest = (loopN: number, fanoutN: number, fanoutShapes = 1): CandidateBox[] => [
  box({
    id: "loop",
    type: "loop",
    n: loopN,
    localBits: 6,
    children: [box({ id: "react", type: "unfold", n: fanoutN, localBits: 4, distinctShapes: fanoutShapes })],
  }),
];

describe("collapseMDL — correctness", () => {
  it("REGRESSION: a shared child's definition is paid ONCE, not per inlined parent copy", () => {
    // The bug: parent expands, child collapses; naive `n×body` re-charged the
    // 200-bit child inside all 4 parent copies (~830 bits). The def/ref split
    // pays the child body once. Force the parent to expand with high shape
    // variance so we exercise the "collapsed box under an expanded box" path.
    const forest = [
      box({
        id: "parent",
        type: "loop",
        n: 4,
        localBits: 1,
        distinctShapes: 256, // huge structural variance ⇒ parent must expand
        children: [box({ id: "child", type: "unfold", n: 2, localBits: 200 })],
      }),
    ];
    const { decisions, totalBits } = collapseMDL(forest);
    expect(decisions.get("parent")).toBe("expanded");
    expect(decisions.get("child")).toBe("collapsed");
    // The 200-bit child body must appear ~once. Naive double-count would be
    // ≥ 4×200=800; correct optimum pays it once (~200 + small overhead).
    expect(totalBits).toBeLessThan(400);
  });

  it("ANCHOR: an all-expanded forest costs exactly rawBits (admissibility floor)", () => {
    // Every box single-occurrence (n=1) ⇒ a reference always costs more than
    // inlining ⇒ everything expands ⇒ total must equal the raw cost.
    const forest = [
      box({
        id: "a",
        type: "loop",
        n: 1,
        localBits: 30,
        children: [box({ id: "b", type: "unfold", n: 1, localBits: 20 })],
      }),
    ];
    const { decisions, totalBits, rawBits } = collapseMDL(forest);
    expect([...decisions.values()].every((d) => d === "expanded")).toBe(true);
    expect(totalBits).toBeCloseTo(rawBits, 6);
  });

  it("totalBits never exceeds rawBits (a grouping is only admitted if it beats raw)", () => {
    for (const f of [gepaForest(50, 3), gepaForest(1, 1), gepaForest(50, 3, 256)]) {
      const { totalBits, rawBits } = collapseMDL(f);
      expect(totalBits).toBeLessThanOrEqual(rawBits + 1e-9);
    }
  });

  it("THRESHOLD: single-box decision matches the closed-form inequality (tests logic, not constants)", () => {
    // For a lone top-level box (ancestorMult=1, no children, uniform): collapse
    // iff refCost < (n-1)·localBits. Replicate the cost and assert agreement
    // across a grid — so the test pins the DERIVED rule, not a magic number.
    const refBits = 1; // countScopes=1 → log2(1)=0 → fallback 1
    const univ = (n: number) => (n <= 1 ? 0 : Math.log2(n)) + Math.log2(2.865);
    for (const n of [1, 2, 3, 5, 10, 50]) {
      for (const localBits of [1, 2, 4, 8, 16, 64]) {
        const refCost = refBits + univ(n); // λ=1, ports=0
        const expected = refCost < (n - 1) * localBits ? "collapsed" : "expanded";
        const { decisions } = collapseMDL([box({ id: "x", type: "unfold", n, localBits })]);
        expect(decisions.get("x"), `n=${n} localBits=${localBits}`).toBe(expected);
      }
    }
  });
});

describe("collapseMDL — behavior", () => {
  it("collapses a real loop and its inner fan-out (gepa)", () => {
    const { decisions } = collapseMDL(gepaForest(50, 3));
    expect(decisions.get("loop")).toBe("collapsed");
    expect(decisions.get("react")).toBe("collapsed");
  });

  it("the big loop stays collapsed across a wide λ sweep (high-n is robust, not knife-edge)", () => {
    // The loop (n=50) is far from any flip threshold; assert it's robust where
    // the small fan-out (n=3) is not. (Review finding 3: don't pin a knife-edge.)
    for (const lambda of [0.25, 0.5, 1, 2, 4]) {
      expect(collapseMDL(gepaForest(50, 3), { lambda }).decisions.get("loop")).toBe("collapsed");
    }
  });

  it("does NOT box a single-iteration loop (parsimony is derived from ref overhead, no ε knob)", () => {
    expect(collapseMDL([box({ id: "once", type: "loop", n: 1, localBits: 6 })]).decisions.get("once")).toBe("expanded");
  });

  it("STRUCTURAL residual: many distinct instance SHAPES keep a box expanded (value-independent)", () => {
    expect(collapseMDL(gepaForest(50, 3, 1)).decisions.get("react")).toBe("collapsed");
    expect(collapseMDL(gepaForest(50, 3, 256)).decisions.get("react")).toBe("expanded");
  });

  it("λ is the zoom knob: #collapsed monotone non-increasing as λ rises", () => {
    const countCollapsed = (lambda: number): number => {
      const forest = [3, 4, 5, 6].map((n, i) => box({ id: `b${i}`, type: "unfold", n, localBits: 4 }));
      return [...collapseMDL(forest, { lambda }).decisions.values()].filter((d) => d === "collapsed").length;
    };
    const counts = [0.1, 0.5, 1, 2, 4, 8, 16, 64].map(countCollapsed);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    expect(counts[0]).toBeGreaterThan(counts.at(-1)!);
  });

  it("nesting composes: inner fan-out expands (high shape variance) while outer loop collapses", () => {
    const { decisions } = collapseMDL([
      box({
        id: "outer",
        type: "loop",
        n: 40,
        localBits: 5,
        children: [box({ id: "inner", type: "unfold", n: 2, localBits: 2, distinctShapes: 64 })],
      }),
    ]);
    expect(decisions.get("inner")).toBe("expanded");
    expect(decisions.get("outer")).toBe("collapsed");
  });

  it("is deterministic and order-independent (id-sorted internally)", () => {
    const a = gepaForest(50, 3);
    const shuffled: CandidateBox[] = [
      box({
        id: "loop",
        type: "loop",
        n: 50,
        localBits: 6,
        children: [box({ id: "react", type: "unfold", n: 3, localBits: 4 })],
      }),
    ];
    const r1 = collapseMDL(a);
    const r2 = collapseMDL(shuffled);
    expect(r1.totalBits).toBeCloseTo(r2.totalBits, 9);
    expect([...r1.decisions.entries()].sort()).toEqual([...r2.decisions.entries()].sort());
  });
});

describe("collapseMDL — force override (suggested vs forced / §5.4 marks)", () => {
  it('FORCED: a "forced" box collapses even when MDL would expand it (single occurrence)', () => {
    // n=1 ⇒ MDL expands (ref overhead > 0 saving). force:"collapsed" overrides.
    const plain = collapseMDL([box({ id: "x", type: "leaf", n: 1, localBits: 6 })]);
    expect(plain.decisions.get("x")).toBe("expanded");
    const forced = collapseMDL([box({ id: "x", type: "leaf", n: 1, localBits: 6, force: "collapsed" })]);
    expect(forced.decisions.get("x")).toBe("collapsed");
  });

  it("FORCE-EXPAND: flattens a box the MDL wanted to collapse (a deliberate human override)", () => {
    // The gepa loop MDL-collapses; force:"expanded" flattens it.
    const forest = gepaForest(50, 3);
    forest[0]!.force = "expanded";
    expect(collapseMDL(forest).decisions.get("loop")).toBe("expanded");
  });

  it("SUGGESTED (no force) defers to the optimizer — unchanged behavior", () => {
    expect(collapseMDL(gepaForest(50, 3)).decisions.get("loop")).toBe("collapsed");
  });
});
