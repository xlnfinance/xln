/**
 * Q9 (docs/PROVENANCE.md §7 "generator corpus classes") — the
 * EXTENDED GENERATOR CORPUS for W1 agreement. Hand-curated rows (one or more per
 * generator class the plan names, plus the task's own additions — loops, field
 * chains, prelude helpers), each hand-verified empirically against BOTH the real
 * evaluator (`w1-harness.ts`'s `runEagerCone`) and the wireframe builder
 * (`prospectiveSourceCone`) before being pinned here — this file is NOT a blind
 * "what do I expect" list, every `precision`/`expectedEager`/`expectedWireframe`
 * triple was checked against actual output while authoring it.
 *
 * `precision`:
 *  - "exact"    — eager cone === wireframe cone (the m3 trade is invisible: no mux
 *    on the reachable path has differing-source arms, so both structural inclusion
 *    of "all arms" and runtime's "one taken arm" land on the same SET of op names).
 *  - "abstract" — wireframe cone is a PROPER superset of eager's (the m3 trade IS
 *    visible: a mux — port-coupled or pure — has an untaken arm touching a
 *    DIFFERENT source than the taken one). `extraInWireframe` names at least one
 *    op present only in the wireframe cone, so the row can assert the superset is
 *    non-vacuous (not accidentally equal).
 */
import type { DeclaredRole } from "../../provenance/lineage.js";
import type { SourceShape } from "./w1-harness.js";

export type GeneratorClass =
  | "interior-sources"
  | "nested-regions"
  | "structured-multi-field-egress"
  | "field-access-chains"
  | "prelude-helpers"
  | "port-coupled-mux"
  | "pure-mux"
  | "deep-mux-nesting"
  | "loop-programs"
  | "first-class-hofs";

export interface CorpusEntry {
  readonly name: string;
  readonly klass: GeneratorClass;
  readonly code: string;
  readonly sources: Record<string, SourceShape>;
  readonly precision: "exact" | "abstract";
  /** Only meaningful for `precision: "abstract"` — at least one op name the
   *  superset assertion checks is present in wireframe but absent from eager. */
  readonly extraInWireframe?: readonly string[];
}

// The declared-role vocabulary every corpus row shares (Q3's shape, synthetic here
// exactly like wireframe-agreement.law.test.ts's own top-level `ROLES`/`CLASSIFIER` —
// this is a SUPERSET covering every op the corpus below uses).
export const CORPUS_ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "fetch-item": "source",
  "fetch-x": "source",
  "fetch-y": "source",
  "get-config": "source",
  map: "fan",
  filter: "fan",
};

export const CORPUS_BASE_NAMES: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  ">",
  "<",
  ">=",
  "<=",
  "=",
  "positive?",
  "negative?",
  "not",
  "car",
  "cdr",
  "cons",
  "list",
  "length",
  "equal?",
]);

const num: SourceShape = "num";
const dict = (...fields: readonly string[]): SourceShape => ({ dict: fields });

export const W1_CORPUS: readonly CorpusEntry[] = [
  // ── interior-sources ────────────────────────────────────────────────────────
  {
    name: "scalar-pipe",
    klass: "interior-sources",
    code: `(+ (src-a) 1)`,
    sources: { "src-a": num },
    precision: "exact",
  },
  {
    name: "scalar-merge",
    klass: "interior-sources",
    code: `(+ (src-a) (src-b))`,
    sources: { "src-a": num, "src-b": num },
    precision: "exact",
  },
  {
    name: "let-transparency",
    klass: "interior-sources",
    code: `(let ((y (src-a))) (+ y 1))`,
    sources: { "src-a": num },
    precision: "exact",
  },
  {
    name: "let-star-chain",
    klass: "interior-sources",
    code: `(let* ((y (src-a)) (z (+ y (src-b)))) (* z 2))`,
    sources: { "src-a": num, "src-b": num },
    precision: "exact",
  },

  // ── nested-regions (map-in-map, filter-in-map) ─────────────────────────────
  {
    name: "map-in-map",
    klass: "nested-regions",
    code: `(map (lambda (row) (map (lambda (v) (+ (fetch-item v) 1)) row)) (list (list 1 2) (list 3 4)))`,
    sources: { "fetch-item": num },
    precision: "exact",
  },
  {
    name: "filter-in-map-empty-cone",
    klass: "nested-regions",
    code: `(map (lambda (row) (filter (lambda (v) (> (fetch-item v) 0)) row)) (list (list 1 2) (list 3 4)))`,
    sources: { "fetch-item": num },
    precision: "exact", // both sides EMPTY — filter's predicate never flows to its output (see w1-harness's lengthPreserving gate note)
  },

  // ── structured-multi-field-egress ───────────────────────────────────────────
  {
    name: "list-of-three-sources",
    klass: "structured-multi-field-egress",
    code: `(list (fetch-x 0) (+ (fetch-y 0) 1) (src-a))`,
    sources: { "fetch-x": num, "fetch-y": num, "src-a": num },
    precision: "exact",
  },
  {
    name: "cons-mixed-with-pure-source",
    klass: "structured-multi-field-egress",
    code: `(cons (fetch-item 0) (+ (src-a) 1))`,
    sources: { "fetch-item": num, "src-a": num },
    precision: "exact",
  },

  // ── field-access-chains ─────────────────────────────────────────────────────
  {
    name: "dict-field-projection",
    klass: "field-access-chains",
    code: `(:flag (get-config))`,
    sources: { "get-config": dict("flag", "value") },
    precision: "exact",
  },

  // ── prelude-helpers ─────────────────────────────────────────────────────────
  {
    name: "pure-helper-over-source",
    klass: "prelude-helpers",
    code: `(define (double x) (* x 2)) (double (src-a))`,
    sources: { "src-a": num },
    precision: "exact",
  },
  {
    name: "pure-helper-chain",
    klass: "prelude-helpers",
    code: `(define (inc x) (+ x 1)) (define (double-inc x) (* (inc x) 2)) (double-inc (src-a))`,
    sources: { "src-a": num },
    precision: "exact",
  },

  // ── port-coupled-mux (selector reaches a port, arms are pure — exact) ───────
  {
    name: "port-coupled-if-pure-arms",
    klass: "port-coupled-mux",
    code: `(if (positive? (src-a)) (+ 1 2) (* 3 4))`,
    sources: { "src-a": num },
    precision: "exact",
  },
  {
    name: "port-coupled-if-selector-repeats-source",
    klass: "port-coupled-mux",
    code: `(if (equal? (fetch-x 0) (fetch-x 0)) (+ 1 1) (+ 2 2))`,
    sources: { "fetch-x": num },
    precision: "exact",
  },

  // ── pure-mux (selector is source-free, arms differ — abstract both-arms) ────
  {
    name: "pure-mux-literal-true",
    klass: "pure-mux",
    code: `(if #t (src-a) (src-b))`,
    sources: { "src-a": num, "src-b": num },
    precision: "abstract",
    extraInWireframe: ["src-b"],
  },
  {
    name: "pure-mux-literal-false",
    klass: "pure-mux",
    code: `(if #f (fetch-x 0) (fetch-y 0))`,
    sources: { "fetch-x": num, "fetch-y": num },
    precision: "abstract",
    extraInWireframe: ["fetch-x"],
  },

  // ── deep-mux-nesting ─────────────────────────────────────────────────────────
  {
    name: "nested-port-coupled-pure-arms",
    klass: "deep-mux-nesting",
    code: `(if (positive? (src-a)) (if (positive? (fetch-x 0)) (+ 1 1) (+ 2 2)) (+ 3 3))`,
    sources: { "src-a": num, "fetch-x": num },
    precision: "exact",
  },
  {
    name: "pure-mux-nested-inside-port-coupled-arm",
    klass: "deep-mux-nesting",
    code: `(if (positive? (src-a)) (if #t (fetch-x 0) (fetch-y 0)) (+ 9 9))`,
    sources: { "src-a": num, "fetch-x": num, "fetch-y": num },
    precision: "abstract",
    extraInWireframe: ["fetch-y"],
  },

  // ── loop-programs (named-let + do; sources fire unconditionally every
  // iteration, loop bound is a corpus-controlled literal so eager and wireframe
  // converge on the same DISTINCT op-name set regardless of iteration count) ────
  {
    name: "named-let-accumulate",
    klass: "loop-programs",
    code: `(let loop ((i 0) (acc 0)) (if (> i 3) acc (loop (+ i 1) (+ acc (fetch-item i)))))`,
    sources: { "fetch-item": num },
    precision: "exact",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// GENERATIVE EXTENSION — a small deterministic-seed grammar over PURE
// pipe/merge/let combinations of a fixed source pool (interior-sources + let-
// transparency shapes, mux-free/fan-free by construction), for the "port-coupled
// decisions + non-mux segments" exact-equality row. Mirrors
// conservation.law.test.ts's own mulberry32-seeded approach (same rationale: a
// deterministic PRNG seeded by a fast-check integer IS "using fast-check" — the
// seed reproduces on failure and fast-check owns shrinking), kept intentionally
// smaller since W1 only needs NON-MUX agreement here (mux/fan classes are the
// hand-curated rows above, where the precision trade needs a human-chosen shape).
// ═══════════════════════════════════════════════════════════════════════════

interface Rng {
  readonly float: () => number;
  readonly int: (min: number, max: number) => number;
  readonly pick: <T>(arr: readonly T[]) => T;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number): Rng {
  const rand = mulberry32(seed);
  return {
    float: () => rand(),
    int: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T,
  };
}

const POOL = ["src-a", "src-b", "fetch-x", "fetch-y"] as const;

/** One randomly-generated non-mux, non-fan, source-pipe/merge/let program: the
 *  code text plus the SET of source ops it structurally uses (every generated
 *  program consumes every drawn source at least once, so the expected cone is
 *  simply "every source drawn" — no static reasoning needed per-program, the
 *  generator's OWN construction guarantees it). */
export function genLinearProgram(seed: number): { readonly code: string; readonly sources: readonly string[] } {
  const rng = makeRng(seed);
  const k = rng.int(2, 4);
  const chosen = new Set<string>();
  while (chosen.size < k) chosen.add(rng.pick(POOL));
  const names = [...chosen];

  // Build a left-fold of `(op acc (name))` over the chosen sources, `op` drawn
  // per step from {+, -, *} (all BASE, all PROVENANCE-forwarding), optionally
  // wrapping the running accumulator in a `(let ((y acc)) y)` transparency hop.
  let code = `(${names[0]})`;
  for (let i = 1; i < names.length; i++) {
    const op = rng.pick(["+", "-", "*"] as const);
    const wrapInLet = rng.float() < 0.4;
    const nextTerm = `(${names[i]})`;
    code = wrapInLet ? `(let ((y ${code})) (${op} y ${nextTerm}))` : `(${op} ${code} ${nextTerm})`;
  }
  return { code, sources: names };
}
