/**
 * SPIKE proof for the static lineage classifier (design note §5, build-step 1).
 * Parses real source, classifies it STATICALLY (no eval), and shows:
 *  - pipe vs merge falls out of operand-arity, from the parsed AST;
 *  - provenance is born only at Rosetta crossings; pure control adds nothing;
 *  - ONE tree answers both the full-cone (teleological seal) and the count-cone
 *    (minimal demand) — the reconciliation the probe conflict demanded.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { classify, fullCone, countCone, type Classifier, type LineageNode } from "../../provenance/lineage.js";

const C: Classifier = {
  roleOf: (op) =>
    ["infer", "fetch", "db-read"].includes(op)
      ? "source"
      : ["map", "filter"].includes(op)
        ? "fan"
        : ["ext-call"].includes(op)
          ? "opaque"
          : undefined, // +, -, *, /, <, >, =, car, cdr, cons, list, length, not — no declared role, pure fallthrough
};

async function skeleton(src: string): Promise<LineageNode> {
  const [ast] = await parse(src);
  return classify(ast, C); // STATIC — no execution
}

describe("lineage spike — static skeleton + pipe/merge/fan from the parsed AST", () => {
  it("(* val1 (+ 1 val2)) → Merge(*) over Leaf(val1) and Pipe(+) → Leaf(val2)", async () => {
    const n = await skeleton(`(* val1 (+ 1 val2))`);
    expect(n.kind).toBe("merge");
    if (n.kind !== "merge") return;
    expect(n.op).toBe("*");
    expect(n.children[0]).toEqual({ kind: "leaf", slot: "val1" });
    // the literal 1 contributes nothing, so (+ 1 val2) is a PIPE, not a merge
    expect(n.children[1]).toEqual({ kind: "pipe", op: "+", child: { kind: "leaf", slot: "val2" } });
  });

  it("full-cone aggregates every leaf (teleological 'provenance everything')", async () => {
    const n = await skeleton(`(* val1 (+ 1 val2))`);
    expect(fullCone(n, { val1: [100], val2: [200] })).toEqual([100, 200]);
  });

  it("a pure predicate mints nothing: (if (< 0 (* x x)) x -1) — the comparison is not a source", async () => {
    // classify the predicate alone: (< 0 (* x x)) — 0 literal, (* x x) over one
    // variable → pipe; the whole thing carries only x's lineage, no new mint.
    const pred = await skeleton(`(< 0 (* x x))`);
    expect(pred.kind).toBe("pipe"); // one prov-bearing operand (the (* x x) subtree)
    expect(fullCone(pred, { x: [7] })).toEqual([7]); // just x; `<` and `*` added nothing
  });
});

describe("lineage spike — one tree, two cone queries (the reconciliation)", () => {
  it("(map infer xs): full-cone includes the fan's mint, count-cone prunes it", async () => {
    const n = await skeleton(`(map infer xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.introduces).toBe(true); // infer is Rosetta-in → the per-element transform mints
    // value depends on what each element BECAME (xs + the infer mint)…
    expect(fullCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
    // …but the COUNT depends only on the source cardinality — the map is length-
    // preserving, so the infer mint is pruned. Same tree, different query.
    expect(countCone(n, { xs: [10], infer: [20] })).toEqual([10]);
  });
});

describe("lineage spike — Rosetta-in mints, opaque is holistic", () => {
  it("(infer p) is a source mint", async () => {
    const n = await skeleton(`(infer p)`);
    expect(n.kind).toBe("source");
    if (n.kind !== "source") return;
    expect(n.op).toBe("infer");
    expect(fullCone(n, { infer: [42] })).toEqual([42]);
  });

  it("(ext-call a b) is an opaque (black-box) holistic merge of its inputs", async () => {
    const n = await skeleton(`(ext-call a b)`);
    expect(n.kind).toBe("opaque");
    expect(fullCone(n, { a: [1], b: [2] })).toEqual([1, 2]);
  });
});

// ── W1 — FILTER-FAN countCone (the §5 confluent-IR fix) ───────────────────────
// The original spike pruned EVERY fan under a count-query. That is wrong for
// `filter`: a filter is length-CHANGING, so a count depends on the predicate AND
// the inspected elements. Only a LENGTH-PRESERVING fan (map) may be pruned. The
// `fan.lengthPreserving` flag carries the distinction; walk() prunes on it.
describe("lineage spike — count-cone prunes a MAP fan but NOT a FILTER fan (§5)", () => {
  it("(map infer xs): count prunes the length-preserving fan; full keeps the mint", async () => {
    const n = await skeleton(`(map infer xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.lengthPreserving).toBe(true);
    expect(fullCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
    expect(countCone(n, { xs: [10], infer: [20] })).toEqual([10]);
  });

  it("(filter infer xs): count does NOT prune — the predicate's mint stays in the count cone", async () => {
    const n = await skeleton(`(filter infer xs)`);
    expect(n.kind).toBe("fan");
    if (n.kind !== "fan") return;
    expect(n.lengthPreserving).toBe(false);
    // A filter's output cardinality depends on what the predicate decided per
    // element — so the count cone is the SAME as the full cone (no prune).
    expect(fullCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
    expect(countCone(n, { xs: [10], infer: [20] })).toEqual([10, 20]);
  });

  it("(length (filter pred xs)): a pure filter's count keeps the source — the fan is not pruned", async () => {
    const n = await skeleton(`(length (filter pred xs))`);
    // length over a filter: the filter's source must survive the count prune.
    expect(countCone(n, { xs: [10], pred: [] })).toEqual([10]);
    expect(fullCone(n, { xs: [10], pred: [] })).toEqual([10]);
  });

  it("(length (map f xs)): the map fan still prunes under count, byte-identical to before", async () => {
    const n = await skeleton(`(length (map f xs))`);
    // f is a plain (non-Rosetta) leaf here, so map introduces nothing; the point
    // is the SHAPE — a length-preserving fan under a count adds only the source.
    expect(countCone(n, { xs: [10], f: [] })).toEqual([10]);
  });
});

// ── W1 — SPECIAL FORMS (the engine dispatches these as surface Pairs) ─────────
// classify() now handles if/cond/let-family/begin/and/or/lambda by shape (they
// are NOT macro-expanded by this engine). Closes lineage-assumptions A4-classifier.
describe("lineage spike — `if` / `cond` classify to a `mux` (selector ∪ arms)", () => {
  it("(if (< 0 x) v -1) → mux(selector=test, arms=[v, -1]); cone = predicate ∪ taken-arm", async () => {
    const n = await skeleton(`(if (< 0 x) v -1)`);
    expect(n.kind).toBe("mux");
    if (n.kind !== "mux") return;
    expect(n.op).toBe("if");
    // selector carries the predicate's source x; the literal -1 arm carries nothing.
    expect(n.selector).toEqual({ kind: "pipe", op: "<", child: { kind: "leaf", slot: "x" } });
    expect(n.arms).toEqual([{ kind: "leaf", slot: "v" }, { kind: "literal" }]);
    // Static cone unions the selector with EVERY arm (the taken arm is a runtime
    // fact the tree cannot know — DR3 conservative over-approximation).
    expect(fullCone(n, { x: [7], v: [5] })).toEqual([5, 7]);
  });

  it("(if (< 0 (* x x)) 99 -1) → cone is the predicate's source ALONE (both arms literal)", async () => {
    // The spike's old `classify` would DROP the predicate and wrongly yield [].
    // The mux keeps it: the eager engine taints the result with the predicate too.
    const n = await skeleton(`(if (< 0 (* x x)) 99 -1)`);
    expect(fullCone(n, { x: [7] })).toEqual([7]);
  });

  it("(cond ((< v 0) (* p q)) (else 0)) → mux; cone = matched-selector ∪ merge-arm", async () => {
    const n = await skeleton(`(cond ((< v 0) (* p q)) (else 0))`);
    expect(n.kind).toBe("mux");
    if (n.kind !== "mux") return;
    expect(n.op).toBe("cond");
    expect(n.arms[0]).toEqual({
      kind: "merge",
      op: "*",
      children: [
        { kind: "leaf", slot: "p" },
        { kind: "leaf", slot: "q" },
      ],
    });
    expect(fullCone(n, { v: [5], p: [9], q: [13] })).toEqual([5, 9, 13]);
  });

  it("cond `=>` threads the test cone into the arm: (cond ((car al) => f) (else 0))", async () => {
    const n = await skeleton(`(cond ((car al) => f) (else 0))`);
    expect(n.kind).toBe("mux");
    if (n.kind !== "mux") return;
    // The arm value is (f testResult), so the cone includes BOTH f and the test's
    // source (al, via the `car` selector) — the `=>` arm threads the test cone.
    expect(fullCone(n, { al: [3], f: [] })).toEqual([3]);
  });

  it("CONSERVATIVE cone — a multi-clause cond unions ALL selectors (not just the matched one)", async () => {
    // The eager engine drops a FAILED clause's selector (golden-prov-special-forms
    // `else arm`); the STATIC tree cannot, so its cone is a superset. This is the
    // documented DR3 boundary: byte-identical control-flow `why` stays eager.
    const n = await skeleton(`(cond ((< w 0) z) ((> v 0) a) (else b))`);
    // Both selectors (w, v) and every arm (z, a, b) appear — the conservative union.
    expect(fullCone(n, { w: [50], v: [5], z: [99], a: [11], b: [22] })).toEqual([5, 11, 22, 50, 99]);
  });
});

describe("lineage spike — `let` family is TRANSPARENT (body == inlined form)", () => {
  it("(let ((foo (+ 1 v2))) (* v1 foo)) classifies IDENTICALLY to the inlined (* v1 (+ 1 v2))", async () => {
    const letform = await skeleton(`(let ((foo (+ 1 v2))) (* v1 foo))`);
    const inlined = await skeleton(`(* v1 (+ 1 v2))`);
    expect(letform).toEqual(inlined);
    const b = { v1: [100], v2: [200] };
    expect(fullCone(letform, b)).toEqual(fullCone(inlined, b));
  });

  it("let* threads bindings left-to-right: (let* ((a v1) (b (+ a v2))) b) ≡ inlined", async () => {
    const n = await skeleton(`(let* ((a v1) (b (+ a v2))) b)`);
    const inlined = await skeleton(`(+ v1 v2)`);
    expect(fullCone(n, { v1: [100], v2: [200] })).toEqual(fullCone(inlined, { v1: [100], v2: [200] }));
  });

  it("a let body returning a pure literal carries NOTHING: (let ((foo v1)) 42) → []", async () => {
    const n = await skeleton(`(let ((foo v1)) 42)`);
    expect(n).toEqual({ kind: "literal" });
    expect(fullCone(n, { v1: [100] })).toEqual([]);
  });
});

describe("lineage spike — begin / and / or / lambda", () => {
  it("(begin a b c) is a pass-through of the LAST expression — cone = {c}", async () => {
    const n = await skeleton(`(begin a b c)`);
    expect(n).toEqual({ kind: "leaf", slot: "c" });
    expect(fullCone(n, { a: [1], b: [2], c: [3] })).toEqual([3]);
  });

  it("(and x y z) is a selector-free value-select — cone = union of operands, NO predicate-taint", async () => {
    const n = await skeleton(`(and x y z)`);
    expect(n.kind).toBe("merge");
    expect(fullCone(n, { x: [1], y: [2], z: [3] })).toEqual([1, 2, 3]);
  });

  it("(or x y) likewise unions its operands — the result is one of them", async () => {
    const n = await skeleton(`(or x y)`);
    expect(fullCone(n, { x: [1], y: [2] })).toEqual([1, 2]);
  });

  it("a `lambda` literal contributes NO provenance at its definition site", async () => {
    const n = await skeleton(`(lambda (x) (* x x))`);
    expect(n).toEqual({ kind: "literal" });
    expect(fullCone(n, {})).toEqual([]);
  });
});

// ── W1 — the remaining CLASSIFIED_SPECIAL_FORMS (totality) ────────────────────
// quote / when / unless / letrec / letrec* are in CLASSIFIED_SPECIAL_FORMS but were
// untested by the spike. when/unless go through the DISTINCT classifyGuardedBody
// path (a one-armed `if`-mux), letrec/letrec* through the TRANSPARENT let path.
// quote is a literal. (named-let → opaque is the sibling describe below.)
describe("lineage spike — quote / when / unless / letrec(*) classify correctly", () => {
  it("(quote (a b c)) is a self-evaluating constant — literal, cone = {}", async () => {
    const n = await skeleton(`(quote (a b c))`);
    expect(n).toEqual({ kind: "literal" });
    expect(fullCone(n, {})).toEqual([]);
  });

  it("(when (< 0 x) v) → mux(selector=test, arms=[body]); cone = predicate ∪ body", async () => {
    const n = await skeleton(`(when (< 0 x) v)`);
    expect(n.kind).toBe("mux");
    if (n.kind !== "mux") return;
    expect(n.op).toBe("when");
    // selector carries the predicate's source x; the single arm is the body `v`.
    expect(n.selector).toEqual({ kind: "pipe", op: "<", child: { kind: "leaf", slot: "x" } });
    expect(n.arms).toEqual([{ kind: "leaf", slot: "v" }]);
    expect(fullCone(n, { x: [7], v: [5] })).toEqual([5, 7]);
  });

  it("(unless (< 0 x) v) → mux likewise (one-armed if over the body); cone = predicate ∪ body", async () => {
    const n = await skeleton(`(unless (< 0 x) v)`);
    expect(n.kind).toBe("mux");
    if (n.kind !== "mux") return;
    expect(n.op).toBe("unless");
    expect(n.arms).toEqual([{ kind: "leaf", slot: "v" }]);
    expect(fullCone(n, { x: [7], v: [5] })).toEqual([5, 7]);
  });

  it("(letrec ((a v1)) (* a v2)) is TRANSPARENT like let* — classifies as the inlined merge", async () => {
    const n = await skeleton(`(letrec ((a v1)) (* a v2))`);
    const inlined = await skeleton(`(* v1 v2)`);
    expect(n).toEqual(inlined);
    expect(fullCone(n, { v1: [100], v2: [200] })).toEqual([100, 200]);
  });

  it("(letrec* ((a v1) (b (+ a v2))) b) threads bindings left-to-right like let*", async () => {
    const n = await skeleton(`(letrec* ((a v1) (b (+ a v2))) b)`);
    const inlined = await skeleton(`(+ v1 v2)`);
    expect(fullCone(n, { v1: [100], v2: [200] })).toEqual(fullCone(inlined, { v1: [100], v2: [200] }));
  });
});

describe("lineage spike — a NAMED let is recursive ⇒ a cyclic binder, not opaque (Q3)", () => {
  it("(let loop ((a v1)) a) → binder{cycles:true} over its RHSs + body (the named-let branch)", async () => {
    // Pre-Q3 this classified as `opaque`; docs/PROVENANCE.md
    // §2's `loop` role reclassifies named-let as a recognized cyclic-binder STRUCTURE,
    // not a black box — see `laws/provenance-roles.law.test.ts`'s V2 row.
    const n = await skeleton(`(let loop ((a v1)) a)`);
    expect(n.kind).toBe("binder");
    if (n.kind !== "binder") return;
    expect(n.op).toBe("named-let");
    expect(n.cycles).toBe(true);
  });
});
