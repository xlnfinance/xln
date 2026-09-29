/**
 * ASSUMPTIONS LEDGER for the dataflow-IR design (confluent-dataflow-graph-ir).
 * The test names ARE the assumptions; green = verified against the real
 * interpreter, `it.fails` = a documented gap/target, `it.todo` = a next-step
 * assumption whose check is designed but not yet buildable (waits on a slice).
 *
 * Measured first, then locked — snapshots record observed reality.
 */
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { execStateOverFrame as execState, parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { AValue } from "../../values/primitives/AValue.js";
import type { SchemeValue } from "../../values/types.js";
import { classify, fullCone, type Classifier, provOf } from "../../provenance/lineage.js";
import { sStr, sNum, run, runRaw } from "../../__tests__/_lineage-test-helpers.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";

// this helper/execState needs the eager oracle ON
requireEagerOracle();

// `seq` numbers the BESPOKE per-`it` envs below (each builds its own env to install
// a rosetta fixture); the shared run/runRaw own a separate counter.
let seq = 0;

describe("ASSUMPTION — provenance is minted only at Rosetta crossings (§5)", () => {
  it("A11a: pure op over literals mints NOTHING — (+ 1 2) has empty provenance", async () => {
    expect(await run(`(+ 1 2)`)).toEqual([]);
  });

  it("A11b: pure op PROPAGATES, never mints — (* x x) over one source carries just it", async () => {
    expect(await run(`(* x x)`, { x: sNum(3, 200) })).toMatchInlineSnapshot(`
      [
        200,
      ]
    `);
  });

  it("A12: arithmetic merge propagates both sources — (* val1 (+ 1 val2))", async () => {
    expect(await run(`(* val1 (+ 1 val2))`, { val1: sNum(5, 100), val2: sNum(7, 200) })).toMatchInlineSnapshot(`
      [
        100,
        200,
      ]
    `);
  });
});

describe("ASSUMPTION — let is transparent (the graph is the object, not syntax) (§2)", () => {
  it("A4: (let ((foo (+ 1 val2))) (* val1 foo)) has the SAME provenance as the inlined form", async () => {
    const inlined = await run(`(* val1 (+ 1 val2))`, { val1: sNum(5, 100), val2: sNum(7, 200) });
    const letform = await run(`(let ((foo (+ 1 val2))) (* val1 foo))`, { val1: sNum(5, 100), val2: sNum(7, 200) });
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
});

// ── EAGER PIPELINE VALUES — the forcing ops produce the documented results ──
// Laziness is now implicit; there is no `(lazy-seq …)` carrier to contrast against. These
// pin the eager value of each map/filter/reduce pipeline directly. The reduce-direction
// probe is the load-bearing one: the base `reduce` is a RIGHT fold, and subtraction makes
// the direction observable — the regression guard that a fold never silently flips. Numbers
// are provenance-stamped (id 0) so the path exercises real AValue arithmetic, not a bare-JS shortcut.
describe("CAPABILITY — eager map/filter/reduce pipelines yield the documented values", () => {
  // sNum returns AValue (the base class), but fromArray's generic constraint demands
  // `T extends SchemeValue`. The runtime value IS a SchemeValue (an AExact); the mismatch
  // is purely in the declared return type. We cast through unknown at the boundary.
  const nums = () =>
    APair.fromArray(
      CONSTANT_CTX,
      [1, 2, 3, 4, 5].map((x) => sNum(x, 0)) as unknown as SchemeValue[],
      false,
    ) as unknown as AValue;
  const jsVal = (r: unknown): unknown => (r instanceof AValue ? r["arrival/toJS"]() : r);
  const eval1 = async (chain: string): Promise<unknown> => jsVal(await runRaw(chain, { xs: nums() }));

  it("map → reduce: (reduce + 0 (map (* x 2) xs)) = 30", async () => {
    expect(await eval1(`(reduce + 0 (map (lambda (x) (* x 2)) xs))`)).toBe(30);
  });

  it("filter → length: (length (filter (> x 2) xs)) = 3", async () => {
    expect(await eval1(`(length (filter (lambda (x) (> x 2)) xs))`)).toBe(3);
  });

  it("map → filter → reduce: a full pipeline sums to 18", async () => {
    // 1..5 → +1 → 2..6 → keep >2 → {3,4,5,6} → sum 18
    expect(await eval1(`(reduce + 0 (filter (lambda (x) (> x 2)) (map (lambda (x) (+ x 1)) xs)))`)).toBe(18);
  });

  it("reduce respects the eager fold DIRECTION — a non-commutative reducer gives -97", async () => {
    // The base `reduce` is a RIGHT fold: (reduce - 100 '(1 2 3 4 5)) =
    // 1-(2-(3-(4-(5-100)))) = -97. Subtraction makes direction observable. This is the
    // probe that originally caught a hand-rolled left-fold (it gave 85). The eager
    // builtin folds right, so this pins -97 as the fold-direction regression guard.
    expect(await eval1(`(reduce - 100 (map (lambda (x) x) xs))`)).toBe(-97);
  });

  it("length over a pure-map chain counts the elements (= 5)", async () => {
    expect(await eval1(`(length (map (lambda (x) (* x x)) xs))`)).toBe(5);
  });
});

// ── NEXT-STEP assumptions — checks designed, not yet buildable (wait on a slice) ──
describe("NEXT-STEP assumptions (designed; unblock as the slices land)", () => {
  // Step 3 — auto-abort:
  it.todo("A10: a lost race over a PURE fan is cancelled with no observable effect");
  it.todo("A10-hazard: a loser that already crossed the membrane (fired an effect) is NOT silently un-fired");
  // Step 4/5 — graph + ligatures:
  it.todo("A3: a fold carries an acc back-edge (sequential); a fan does not (parallel) — read off the graph");
  it.todo("A9: a reduce parallelizes (tree-reduce) iff its reducer has a Fantasy Land Monoid (associativity)");
  it.todo("A19: each ligature fusion preserves BOTH result and lineage cone — cone(fuse) == cone(stack)");
  // Step 6 — self-explaining values:
  it.todo("A-uneval: eval(uneval(chunk)) === chunk — a lineage chunk round-trips to readable source");
  // Step 7 — effects:
  it.todo("A16: write-set ∩ later read-set != ∅ is a detectable back-edge through the membrane (reject/warn)");
  // Classifier gaps surfaced this session — now CLOSED by W1 (classify() handles
  // surface special forms by shape; lineage-spike + golden-prov-special-forms
  // carry the full proof). These pin the headline closure here in the ledger.
  it("A4-classifier: classify() handles `let`/`if` (special forms), not just applications", async () => {
    const C: Classifier = {
      roleOf: (op) => (["map", "filter"].includes(op) ? "fan" : undefined),
    };
    const cone = async (src: string, b: Record<string, readonly number[]>): Promise<number[]> => {
      const [ast] = await parse(src);
      return fullCone(classify(ast, C), b);
    };
    // `if` → a `mux` (not a mis-read application); predicate ∪ taken arm.
    const [ifAst] = await parse(`(if (< 0 x) v -1)`);
    expect(classify(ifAst, C).kind).toBe("mux");
    expect(await cone(`(if (< 0 x) v -1)`, { x: [7], v: [5] })).toEqual([5, 7]);
    // `let` → transparent: same cone as the inlined form.
    expect(await cone(`(let ((foo (+ 1 v2))) (* v1 foo))`, { v1: [100], v2: [200] })).toEqual([100, 200]);
  });

  it("A21: classify() runs on the SURFACE ast — this engine dispatches special forms directly (no macro-expansion)", async () => {
    const C: Classifier = { roleOf: () => undefined };
    // The evaluator's SPECIAL_FORMS dispatches `let` directly, so the parsed AST
    // head is still the literal `let` symbol (NOT desugared to a lambda
    // application). classify() handles that surface shape rather than requiring a
    // macro-expanded input — so the original "must run on macro-expanded ast"
    // assumption is resolved by surface handling, not by adding an expander.
    const [ast] = await parse(`(let ((foo v1)) (* v1 foo))`);
    expect((ast as { car?: { valueOf?: () => unknown } })?.car?.valueOf?.()).toBe("let"); // surface form, unexpanded
    expect(fullCone(classify(ast, C), { v1: [100] })).toEqual([100]); // transparent on the surface form
  });
});

// ── v0.1 FINALIZATION GATES (G1–G7) ──
// The acceptance ledger for retiring eager per-op provenance in favor of the
// static lineage TREE (lineage.ts: classify → leaf/source/pipe/merge/fan/opaque),
// behind a `--ir-lineage` flag with eager fallback. Design:
// the confluent dataflow-graph IR design (2026-06-17).
//
// The flag DOES NOT EXIST YET, so today's eager behavior IS the golden oracle:
// every gate's static-path assertion is "flag-on == eager golden". These are
// `it.todo` (intent pinned, path unbuilt). Where a gate is partially checkable
// under the eager engine TODAY, a runnable golden is captured alongside — it is
// the eager left-hand side the static path must reproduce byte-for-byte (G2).
// The test NAME states the acceptance condition (the repo law: name IS the gate).
describe("v0.1 FINALIZATION GATES (G1–G7)", () => {
  // G1 — provenance memory is O(program-structure), not O(execution-history).
  it.todo(
    "G1: a program that previously approached DEFAULT_TRACE_CAP (500k) runs with BOUNDED provenance memory under --ir-lineage — pruneChildProvenance + the trace caps become deletable",
  );

  // G2 — equivalence: the static path is provenance-identical to eager on real,
  // macro-expanded programs; flag-OFF stays byte-identical to today.
  it.todo(
    "G2: provenance(static, --ir-lineage on) == provenance(eager, flag off) on macro-expanded REAL programs (incl. if/let/cond and filter-fans); flag-off output is byte-identical to today",
  );

  // G3 — single representation: AValue carries ONE lineage-node reference; the
  // ~64 per-op accumulation sites are gone.
  it.todo(
    "G3: AValue carries a single lineage-node reference (not a flat ReadonlySet<number>) and the ~64 withInputProvenance / unionProvenance call sites are retired",
  );

  // G4 — no stranded consumer: every downstream reader works off the new rep.
  it.todo(
    "G4: handle-provenance (why/where/dag), the sift attestation seal, and the live studio trace-to-regions visualization all produce correct output read off the lineage-tree representation",
  );

  // G5 — confluence guard: the purity invariant is ENFORCED at runtime, not
  // honor-system — a reopened purity-door / secretly-mutating Rosetta is caught.
  it.todo(
    "G5: the purity invariant is ASSERTED at runtime — a reopened purity-door or a secretly-mutating Rosetta crossing is CAUGHT (thrown/flagged), not silently tolerated",
  );

  // G6 — carrier-coercion soundness: provenance survives the standard transforms
  // across ALL carriers; no coercion silently drops a provenance box.
  // Pair is pinned by golden-prov-fan.test.ts's A13 row (it.fails, per the same
  // sweep); the runnable golden below pins the SchemeVector carrier (the
  // remaining constructible one) under the
  // EAGER engine — the oracle the static path must reproduce. AJSArray is a
  // membrane wrapper (no public constructor here) and is asserted only via the
  // todo, end-to-end through the flag.
  it.todo(
    "G6: provenance survives map/filter/length/sort across ALL carriers (Pair / SchemeVector / AJSArray) under --ir-lineage — no coercion silently drops a provenance box; matches the eager golden per carrier",
  );

  // [impl-pinning] pins the CURRENT eager mechanism (grouping-fact stamp survives map,
  // drops on count/convert), not a behavioral guarantee — the static path may reshape this.
  it("G6-eager-golden(SchemeVector): a length-preserving vector-map PRESERVES the collection-level grouping fact; vector-length/vector->list drop to the bare scalar/Pair exactly as eager does (this map IS the G2 oracle)", async () => {
    const mkVec = () => new AVector([sStr("a", 100), sStr("b", 101)], new Set([7]));
    const summary = (r: unknown) => ({
      ctor: (r as { constructor?: { name?: string } })?.constructor?.name ?? typeof r,
      prov: provOf(r),
    });
    const oneShot = async (src: string): Promise<unknown> => {
      const env = inferenceEnv.child(`la-${seq++}`) as EnvWithInternals<ResolvingAmbient>;
      env.bind("xs", mkVec());
      // execState (COMPLEX tier): `summary` reads the BOXED result's constructor
      // name + `provOf` provenance — a boxed-state concern (RULINGS.md R1).
      const [r] = (await execState(src, { env })).values;
      return summary(r);
    };
    const golden = {
      // A length-preserving transform must NOT drop the grouping box (id 7).
      vectorMap: await oneShot(`(vector-map (lambda (e) e) xs)`),
      // Stacked length-preserving fans: the box still survives.
      vectorMapTwice: await oneShot(`(vector-map (lambda (e) e) (vector-map (lambda (e) e) xs))`),
      // A cardinality observation reduces to a bare Number — the grouping box
      // is NOT carried onto the count today (the eager reality the static path
      // must match; G2 forbids "improving" it under the flag).
      vectorLength: await oneShot(`(vector-length xs)`),
      // `length` reads the CONTAINER's own flat grouping-fact stamp; `map` PROXIES
      // `xs`'s own stamp {7} through unchanged [GATE: G2].
      mapLengthCoerce: await oneShot(`(length (map (lambda (e) e) xs))`),
      // vector->list converts the carrier; the collection-level box does not
      // ride onto the resulting Pair today.
      vectorToList: await oneShot(`(vector->list xs)`),
    };
    expect(golden).toMatchInlineSnapshot(`
      {
        "mapLengthCoerce": {
          "ctor": "AExact",
          "prov": [
            7,
          ],
        },
        "vectorLength": {
          "ctor": "AExact",
          "prov": [],
        },
        "vectorMap": {
          "ctor": "AVector",
          "prov": [
            7,
          ],
        },
        "vectorMapTwice": {
          "ctor": "AVector",
          "prov": [
            7,
          ],
        },
        "vectorToList": {
          "ctor": "APair",
          "prov": [],
        },
      }
    `);
  });

  // G7 — viz-readiness: the lineage tree carries the identity the v0.2 inhuman
  // flowchart needs (op-tag per node, call-id per source, a namer hook) so it
  // renders as infer-calls + transforms with no redesign. (Identity survives —
  // NOT a full render.)
  it.todo(
    "G7: the lineage tree carries a per-node op-tag + per-source call-id + a namer hook, so the v0.2 inhuman flowchart can render infer-calls + transforms off it WITHOUT a representation redesign",
  );
});
