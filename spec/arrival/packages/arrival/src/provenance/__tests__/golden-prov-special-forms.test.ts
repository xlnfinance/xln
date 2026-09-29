/**
 * GOLDEN CAPTURE (gate G2 oracle) — special-form provenance: if / let / cond.
 *
 * WAVE R / RED-SPEC. These snapshots pin the CURRENT (eager) engine's provenance
 * for the three special forms the static lineage classifier currently
 * MISCLASSIFIES as plain applications (lineage.ts §SCOPE; lineage-assumptions
 * A4-classifier is `it.todo`). The `--ir-lineage` flag does not exist yet, so the
 * eager behavior captured here IS the golden oracle: when `classify()` learns
 * special forms, `provenance(static, flag-on)` must reproduce these exact sets
 * (gate G2 — equivalence on macro-expanded REAL programs incl. if/let/cond),
 * and `flag-off` must stay byte-identical to what is snapshotted below.
 *
 * Shared provenance helpers (sNum, run) are imported from the test-helper module
 * (run wraps the canonical provOf); the file-SPECIFIC static classifier `C` and the
 * `staticCone` driver stay local.
 *
 * THE LOAD-BEARING DISCOVERY these goldens lock (and where the spike's stated
 * assumption diverges from observed reality):
 *
 *   The spike claims "a pure predicate mints nothing" (lineage-spike.test.ts:44)
 *   and its `classify()` would DROP an `if`/`cond` predicate entirely. The eager
 *   engine does NOT: the predicate's provenance is consumed by the test and
 *   PROPAGATES into the result — even when the taken arm is a bare literal that
 *   carries nothing of its own (see `if — predicate provenance taints a literal
 *   arm`). So the result's cone today is (matched-predicate ∪ taken-arm), not
 *   just the taken arm. A subtlety the cond cases pin precisely: only the
 *   MATCHED clause's predicate contributes — a FAILED clause's predicate does
 *   NOT leak into a later arm (`cond — else arm: a failed predicate does not
 *   leak`). This is exactly the gap the `A4-classifier` todo must resolve: the
 *   classifier needs a `mux` node whose cone unions the selector-on-the-taken-
 *   path with the taken arm, NOT a node that discards the predicate.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { classify, fullCone, type Classifier } from "../../provenance/lineage.js";
import { sNum, run } from "../../__tests__/_lineage-test-helpers.js";

/** STATIC classifier for the gate checks below — the control forms here use only
 *  arithmetic/comparison pures (no Rosetta-in, no fans). */
const C: Classifier = {
  roleOf: (op) => (["map", "filter"].includes(op) ? "fan" : undefined),
};

/** fullCone of the STATIC lineage tree for `src` under leaf bindings `b` (no eval). */
async function staticCone(src: string, b: Record<string, readonly number[]>): Promise<number[]> {
  const [ast] = await parse(src);
  return fullCone(classify(ast, C), b);
}

// ── if ──────────────────────────────────────────────────────────────────────
describe("GOLDEN — `if` provenance (gate G2 oracle)", () => {
  it("positive arm taken: (if (< 0 v) v -1) carries the chosen value's provenance", async () => {
    // v=10 (id 5): predicate true, returns v. Both predicate and arm reference v,
    // so the cone is just {5} — no fan-out to distinguish here.
    expect(await run(`(if (< 0 v) v -1)`, { v: sNum(10, 5) })).toMatchInlineSnapshot(`
      [
        5,
      ]
    `);
  });

  it("predicate provenance TAINTS a literal arm: (if (< 0 v) v -1), v negative → still carries v", async () => {
    // v=-3 (id 5): predicate FALSE, so the engine returns the literal -1, which
    // carries nothing of its own. Yet the result is {5}: the predicate `(< 0 v)`
    // consumed v's provenance and it propagated to the chosen arm. THIS is the
    // fact the spike's "pure predicate mints nothing" assumption misses — the
    // predicate is NOT pure control in the eager engine; its lineage flows out.
    expect(await run(`(if (< 0 v) v -1)`, { v: sNum(-3, 5) })).toMatchInlineSnapshot(`
      [
        5,
      ]
    `);
  });

  it("predicate-only source, pure-literal arms: (if (< 0 (* x x)) 99 -1) carries the predicate's source", async () => {
    // x=3 (id 7): both arms are bare literals (no provenance). The result is {7}
    // SOLELY because the predicate `(* x x)` carried x. A classifier that drops
    // the predicate would wrongly compute {} here — the equivalence gate G2 fails.
    expect(await run(`(if (< 0 (* x x)) 99 -1)`, { x: sNum(3, 7) })).toMatchInlineSnapshot(`
      [
        7,
      ]
    `);
  });

  it("predicate source UNION arm source: (if (< 0 x) v -1) merges both cones", async () => {
    // x=3 (id 7) drives the predicate; v=10 (id 5) is the taken arm. The result
    // carries BOTH — the cone is the predicate's source ∪ the taken arm's source.
    expect(await run(`(if (< 0 x) v -1)`, { x: sNum(3, 7), v: sNum(10, 5) })).toMatchInlineSnapshot(`
      [
        5,
        7,
      ]
    `);
  });

  it("two-armed merge in the taken branch: (if (< 0 x) (* v1 v2) -1)", async () => {
    // Predicate x=id7; taken arm is an arithmetic merge of v1=id100, v2=id200.
    // Cone = predicate ∪ both arm operands → {7,100,200}.
    expect(await run(`(if (< 0 x) (* v1 v2) -1)`, { x: sNum(3, 7), v1: sNum(5, 100), v2: sNum(7, 200) }))
      .toMatchInlineSnapshot(`
      [
        7,
        100,
        200,
      ]
    `);
  });
});

// ── let (transparency — must equal the inlined form) ──────────────────────────
describe("GOLDEN — `let` transparency (gate G2 oracle)", () => {
  it("(let ((foo (+ 1 v2))) (* v1 foo)) has the SAME cone as the inlined (* v1 (+ 1 v2))", async () => {
    // The binding is pure substitution: the graph is the object, not the syntax.
    // A classifier that treats `let` as an application would read `let` as the
    // operator and mis-shape the tree; G2 requires these two cones identical.
    const inlined = await run(`(* v1 (+ 1 v2))`, { v1: sNum(5, 100), v2: sNum(7, 200) });
    const letform = await run(`(let ((foo (+ 1 v2))) (* v1 foo))`, { v1: sNum(5, 100), v2: sNum(7, 200) });
    expect({ inlined, letform }).toMatchInlineSnapshot(`
      {
        "inlined": [
          100,
          200,
        ],
        "letform": [
          100,
          200,
        ],
      }
    `);
  });

  it("nested let threads provenance through both bindings: (let ((a v1)) (let ((b v2)) (+ a b)))", async () => {
    expect(await run(`(let ((a v1)) (let ((b v2)) (+ a b)))`, { v1: sNum(5, 100), v2: sNum(7, 200) }))
      .toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("let* sequential binding is equally transparent: (let* ((a v1) (b (+ a v2))) b)", async () => {
    expect(await run(`(let* ((a v1) (b (+ a v2))) b)`, { v1: sNum(5, 100), v2: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });

  it("a let body that returns a pure literal carries NOTHING: (let ((foo v1)) 42)", async () => {
    // foo is bound but unused; the body is a bare literal. No source reaches the
    // result, so the cone is empty — the binding's provenance does not leak in.
    expect(await run(`(let ((foo v1)) 42)`, { v1: sNum(5, 100) })).toMatchInlineSnapshot(`[]`);
  });
});

// ── cond (matched-predicate ∪ matched-arm; failed predicates do not leak) ──────
describe("GOLDEN — `cond` provenance (gate G2 oracle)", () => {
  it("matched clause: predicate provenance UNIONs the arm — (cond ((< v 0) a) (else b)) → {pred, a}", async () => {
    // v=-1 (id 5): clause 1 matches. predicate `(< v 0)` carries v=id5, arm `a`
    // carries id11 → result {5,11}. Same predicate-taint as `if`.
    expect(await run(`(cond ((< v 0) a) (else b))`, { v: sNum(-1, 5), a: sNum(11, 11), b: sNum(22, 22) }))
      .toMatchInlineSnapshot(`
      [
        5,
        11,
      ]
    `);
  });

  it("else arm: a FAILED predicate does NOT leak into the else branch — only {b}", async () => {
    // v=9 (id 5): clause 1's predicate is tested and FAILS; the else arm `b`
    // (id 22) is returned. Crucially the result is {22}, NOT {5,22} — the failed
    // predicate's provenance is discarded. Contrast the matched case above: ONLY
    // the matched clause's selector contributes. This asymmetry is exactly what a
    // `mux` lineage node must model (selector-on-the-taken-path ∪ taken-arm).
    expect(await run(`(cond ((< v 0) a) (else b))`, { v: sNum(9, 5), a: sNum(11, 11), b: sNum(22, 22) }))
      .toMatchInlineSnapshot(`
      [
        22,
      ]
    `);
  });

  it("matched clause with a merge arm: (cond ((< v 0) (* p q)) (else 0)) → {pred, p, q}", async () => {
    // v=-1 (id 5) matches; arm `(* p q)` merges p=id9, q=id13. Cone = {5,9,13}.
    expect(await run(`(cond ((< v 0) (* p q)) (else 0))`, { v: sNum(-1, 5), p: sNum(4, 9), q: sNum(2, 13) }))
      .toMatchInlineSnapshot(`
      [
        5,
        9,
        13,
      ]
    `);
  });

  it("second clause matches: the FIRST clause's failed predicate does not contribute", async () => {
    // v=5 (id 5): clause 1 `(< v 0)` fails, clause 2 `(> v 0)` matches → arm `a`
    // (id 11). Both predicates reference the SAME v=id5; the result is {5,11}.
    // (Here the matched predicate happens to share v's id with the failed one, so
    // the snapshot alone can't separate them — `else arm` above is the clean
    // discriminator. This case pins the multi-clause shape.)
    expect(
      await run(`(cond ((< v 0) z) ((> v 0) a) (else b))`, {
        v: sNum(5, 5),
        z: sNum(99, 99),
        a: sNum(11, 11),
        b: sNum(22, 22),
      }),
    ).toMatchInlineSnapshot(`
      [
        5,
        11,
      ]
    `);
  });

  it("multi-clause with DISTINCT selector source: only the matched selector's id appears", async () => {
    // Predicates test different sources: clause 1 on `w` (id 50, fails), clause 2
    // on `v` (id 5, matches) → arm `a` (id 11). The result must be {5,11} and must
    // NOT contain 50 — proving the failed clause's distinct selector is dropped.
    // This is the sharpest G2 oracle for the cond mux: a classifier that unions
    // ALL selectors would wrongly include 50.
    expect(
      await run(`(cond ((< w 0) z) ((> v 0) a) (else b))`, {
        w: sNum(7, 50),
        v: sNum(5, 5),
        z: sNum(99, 99),
        a: sNum(11, 11),
        b: sNum(22, 22),
      }),
    ).toMatchInlineSnapshot(`
      [
        5,
        11,
      ]
    `);
  });
});

// ── GATE — the static classifier reproduces these goldens (W1) ────────────────
// classify() now handles the special forms by shape (lineage.ts header): `if`/
// `cond` → a `mux`, `let` family → transparent substitution. These assert the
// static cone against the EAGER goldens captured above, on the cases the static
// tree CAN reproduce — and name precisely the one it cannot (the control-flow
// `why` that DR3 keeps eager-sourced).
describe("GATE G2 (static lineage == eager golden on special forms) — W1", () => {
  // A4-mux: the `if` mux keeps the predicate (it does NOT drop it) — selector ∪
  // arms. Every captured `if` golden has literal non-taken arms, so the
  // conservative static cone coincides exactly with the eager taken-arm cone.
  it("A4-mux: `if` classifies to a `mux` whose cone = predicate ∪ arms (predicate NOT dropped)", async () => {
    const [ast] = await parse(`(if (< 0 (* x x)) 99 -1)`);
    const node = classify(ast, C);
    expect(node.kind).toBe("mux"); // not an application, not a dropped-predicate node
    // Both arms are literals; the cone is the predicate's source ALONE — exactly
    // the eager `predicate-only source` golden ({7}), NOT the empty set the old
    // pure-control sketch would have produced.
    expect(fullCone(node, { x: [7] })).toEqual([7]);
  });

  // A4-classifier (if): every captured `if` golden reproduces byte-identically.
  it("A4-classifier(if): static fullCone == eager golden for all captured `if` cases", async () => {
    expect(await staticCone(`(if (< 0 v) v -1)`, { v: [5] })).toEqual([5]);
    expect(await staticCone(`(if (< 0 (* x x)) 99 -1)`, { x: [7] })).toEqual([7]);
    expect(await staticCone(`(if (< 0 x) v -1)`, { x: [7], v: [5] })).toEqual([5, 7]);
    expect(await staticCone(`(if (< 0 x) (* v1 v2) -1)`, { x: [7], v1: [100], v2: [200] })).toEqual([7, 100, 200]);
  });

  // A4-classifier (let): the let family is genuinely transparent — byte-identical
  // to the inlined form, the load-bearing 121-163 goldens.
  it("A4-classifier(let): transparent — static fullCone == eager golden (== inlined)", async () => {
    const b = { v1: [100], v2: [200] };
    expect(await staticCone(`(let ((foo (+ 1 v2))) (* v1 foo))`, b)).toEqual([100, 200]);
    expect(await staticCone(`(let ((a v1)) (let ((b v2)) (+ a b)))`, b)).toEqual([100, 200]);
    expect(await staticCone(`(let* ((a v1) (b (+ a v2))) b)`, b)).toEqual([100, 200]);
    expect(await staticCone(`(let ((foo v1)) 42)`, { v1: [100] })).toEqual([]);
  });

  // A4-classifier (cond, reproducible cases): a single matched clause with a
  // literal else reproduces the eager matched-clause golden exactly.
  it("A4-classifier(cond): static fullCone == eager golden for a single-matched-clause cond", async () => {
    expect(await staticCone(`(cond ((< v 0) (* p q)) (else 0))`, { v: [5], p: [9], q: [13] })).toEqual([5, 9, 13]);
  });

  // THE DR3 BOUNDARY (NOT my unit to close): where the eager engine drops a FAILED
  // clause's selector or an un-taken arm, the STATIC tree's cone is a conservative
  // SUPERSET — it cannot know the taken branch. Byte-identical control-flow `why`
  // is stamped by the evaluator's control-flow wrappers (Wave S), not the static
  // classifier. This documents the gap with a runnable witness.
  it("DR3: the static cond cone is a conservative SUPERSET of the eager cone (control-flow why stays eager)", async () => {
    // Eager `else arm` golden is {22} (failed predicate + un-taken arms dropped);
    // the static tree unions the selector and EVERY arm.
    const got = await staticCone(`(cond ((< v 0) a) (else b))`, { v: [5], a: [11], b: [22] });
    expect(got).toEqual([5, 11, 22]); // ⊋ eager {22}
    expect(got).toEqual(expect.arrayContaining([22])); // superset: the eager answer is contained
  });
  it.todo(
    "A4-mux-eager: byte-identical control-flow why (failed-clause non-leak, un-taken-arm exclusion) — Wave S evaluator wrappers, not the static classifier (DR3)",
  );

  // A21 is MOOT for this engine: classify() runs on the SURFACE reader output
  // because the evaluator dispatches if/let/cond DIRECTLY from SPECIAL_FORMS —
  // they are never macro-expanded to applications. The "macro-expanded" premise
  // does not apply; the surface-form handling above IS the resolution.
  it("A21: classify() handles SURFACE special forms directly (this engine does NOT macro-expand them)", async () => {
    // `let` is a SPECIAL_FORMS entry, so the parsed AST head is still the literal
    // `let` symbol (no lambda-application desugaring) — and classify() handles it.
    const [ast] = await parse(`(let ((foo v1)) (* v1 foo))`);
    expect(classify(ast, C).kind).not.toBe("literal"); // recognised + transparent, not mis-read
    expect(await staticCone(`(let ((foo v1)) (* v1 foo))`, { v1: [100] })).toEqual([100]);
  });
});
