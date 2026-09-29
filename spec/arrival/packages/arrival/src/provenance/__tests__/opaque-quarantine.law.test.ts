/**
 * LAW (staged) — V3 opaque quarantine drift alarm (docs/PROVENANCE.md §2: "`opaque`
 * as a citizen — it is a quarantined escape hatch; corpus count is a shrink-only
 * drift alarm baselined AFTER W0"; Q1's scoping (docs/PROVENANCE.md §2 declaration
 * vocabulary): MACHINERY only, the baseline NUMBER is a post-Q6 artifact, never
 * pinned here).
 *
 * This file lands the MACHINERY Q1 owes: a counted walk over a `classify()` corpus,
 * exposed as a testable function (`countOpaqueNodes`, `provenance/lineage.ts`), plus this
 * staged `it.todo` alarm row. It intentionally does NOT pin a baseline number — W0
 * (span propagation through syntax-rules, Q6) changes what the classifier sees as
 * opaque (hygiene-expanded forms it currently cannot model), so any number pinned
 * before Q6 lands would be stale on arrival.
 *
 * PRE-LANDING NOTE for future Sonnets: this is a narrow slice of what
 * Q5 (docs/PROVENANCE.md §7 law table) will build (`src/__tests__/laws/provenance-roles.law.test.ts`,
 * housing the full V1/V2/V3/V4 role-vocabulary rows). Q5 has NOT landed — this file
 * covers only V3's counted-walk machinery, scoped to Q1. Q5 may fold this row into
 * its stub file directly rather than duplicating it; do not read this file's
 * existence as Q5 having landed.
 */
import { describe, expect, it } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { classify, countOpaqueNodes, type Classifier } from "../../provenance/lineage.js";

// Mirrors lineage-spike.test.ts's spike classifier — a minimal, deterministic
// Classifier sufficient to exercise the corpus below (not the real env-backed one).
// Q3 landed declaration-driven classification: `roleOf` is the
// one read `classify()` consults now (docs/PROVENANCE.md §2's lowering table).
const C: Classifier = {
  roleOf: (op) =>
    ["infer", "fetch", "db-read"].includes(op)
      ? "source"
      : ["map", "filter"].includes(op)
        ? "fan"
        : ["ext-call"].includes(op)
          ? "opaque"
          : undefined, // +, -, *, /, <, >, =, car, cdr, cons, list, length, not — pure fallthrough
};

/** A tiny corpus mixing zero-opaque, single-opaque, and nested-opaque forms — enough
 *  to exercise the counted walk's recursion (mux/fan/merge descent) without needing
 *  the full §7 generator corpus (that's Q9's job, over the extended class list). */
const CORPUS: readonly string[] = [
  `(+ 1 2)`, // no opaque
  `(infer p)`, // a source mint, no opaque
  `(ext-call a b)`, // one opaque, holistic over two leaves
  `(if (ext-call a) (+ 1 2) (ext-call b c))`, // two opaque nodes, one per mux arm
  `(let loop ((a v1)) a)`, // named-let — NO LONGER opaque as of Q3 (binder{cycles:true}; V2 row)
];

/** classify() every corpus member and sum `countOpaqueNodes` — the machinery a future
 *  baseline assertion (post-Q6) will call directly. Exposed as its own function (not
 *  inlined into the `it`) so Q6+ can import and assert against it without re-deriving
 *  the corpus-walk shape. */
async function countOpaqueOverCorpus(corpus: readonly string[]): Promise<number> {
  let total = 0;
  for (const src of corpus) {
    const [ast] = await parse(src);
    total += countOpaqueNodes(classify(ast, C));
  }
  return total;
}

describe("V3 opaque quarantine — counted-walk machinery (Q1)", () => {
  it("countOpaqueNodes walks a classified tree without throwing, over a mixed corpus", async () => {
    // Sanity, not a baseline: proves the machinery is wired end-to-end (parse →
    // classify → count) and returns a plain non-negative integer. The exact number
    // is NOT asserted here — see the it.todo below for why.
    const total = await countOpaqueOverCorpus(CORPUS);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
  });

  // @ledger: opaque quarantine baseline PINNED (Q3, post-Q6 spans + declaration-driven
  // classification — the exact point docs/PROVENANCE.md §2 names: "baselined AFTER
  // W0" (Q6 landed spans) and now also post-Q3 (named-let no longer inflates the
  // count). SHRINK-ONLY from here: a future landing may only lower this ceiling
  // (more classifier coverage retiring opaque escape hatches); a rise is the drift
  // alarm firing. Composition under test: corpus → classify → countOpaqueNodes.
  it("the corpus opaque count is a SHRINK-ONLY drift alarm, baselined post-Q6+Q3", async () => {
    const total = await countOpaqueOverCorpus(CORPUS);
    // Baseline 3, pinned 2026-07-09: only the three `ext-call` occurrences remain
    // opaque (one in row 3, two in row 4's mux arms) — row 5's named-let no longer
    // contributes (Q3 reclassifies it as `binder{cycles:true}`, not opaque).
    expect(total).toBeLessThanOrEqual(3);
  });
});
