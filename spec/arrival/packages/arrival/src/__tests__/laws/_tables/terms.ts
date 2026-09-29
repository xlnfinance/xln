/**
 * The tagless-term table — F1's row axis (docs/test-suite-architecture.md F1).
 *
 * Every term declares its BOX DISCIPLINE up front: that declaration IS the law the
 * term×carrier grid enforces (P0/P8 — one algebra, every carrier). A term whose
 * discipline "depends on the carrier" cannot be expressed in this table; that is
 * the point.
 *
 * boxDiscipline:
 *  - "element-preserving": every element's box (identity + provenance) survives
 *    into the result (map, filter, sort, concat elements).
 *  - "element-unioning": the result is a fresh scalar/container whose provenance
 *    is the union of consumed elements' (length counts, equals verdicts — pending
 *    R2 for the container-box question).
 *  - "projecting": the result IS one of the input's elements, box intact (car,
 *    cdr-of-dotted, vector-ref, assoc hit).
 *
 * containerBox (R2 RULED, docs/RULINGS.md — the R2 container
 * structural-facts batch): what happens to a container's own TWO structural facts —
 * the GROUPING fact (its top-level provenance stamp, the R2 "collection-level
 * grouping fact") and, for sequence-shaped carriers, the LENGTH fact (postponed
 * for dicts: keyset) — with three explicit, NAMED verbs (naive-but-explicit: named
 * fields, not emergent behavior — this table IS the law):
 *
 *  - "PROXIED"     — length-preserving ops (map, sort; reverse in env/, untouched
 *                    by this batch) thread the INPUT container's own stamp
 *                    through UNCHANGED (`withInputProvenance([this], result)`).
 *  - "PROVENANCED" — length-changing ops (filter/remove; concat) MINT a fresh
 *                    stamp: the union of (a) the input container's own stamp and
 *                    (b) the decision lineage that changed the length — the
 *                    SURVIVING elements' own provenance for filter, both
 *                    operands' (deep-collapsed) for concat/append.
 *  - "MINTED"      — constructors (cons/list/vector/string/bytevector — env/
 *                    packs, not this table's terms) union their ARGS' own
 *                    top-level provenance onto the freshly built container.
 *  - "n/a"         — the term doesn't produce/consume a container in the R2
 *                    sense: a scalar-producing term (reduce/equals), a pure
 *                    element projection (car), or an egress term (toJS/print).
 *                    `length` itself is "n/a" here too — it is the CONSUMER of
 *                    the length fact (C4: reads the container's own flat stamp),
 *                    not a producer of one.
 *
 * Declared ONCE per term (not per carrier): P8 requires every SUPPORTED carrier to
 * agree, so a term whose containerBox "depends on the carrier" is exactly the bug
 * class R2 closed (the old Pair-sort-drops/Vector-sort-preserves divergence,
 * 2026-07-09 suite consolidation) — the law-grid asserts
 * this agreement directly (term-carrier.law.test.ts's "container box" cell,
 * conservation.law.test.ts's "container-box rows" §3).
 */
export interface TermRow {
  /** protocol key, e.g. "arrival/tagless-final/map" */
  readonly term: string;
  /** scheme-surface verbs dispatching to it (for conformance cross-reference) */
  readonly verbs: readonly string[];
  readonly boxDiscipline: "element-preserving" | "element-unioning" | "projecting";
  /** R2's structural-fact verb for both the grouping fact and the length fact —
   *  see the file header. Uniform across every carrier that supports the term
   *  (P8); "n/a" for terms with no container-box question. */
  readonly containerBox: {
    readonly groupingFact: "PROXIED" | "PROVENANCED" | "MINTED" | "n/a";
    readonly lengthFact: "PROXIED" | "PROVENANCED" | "MINTED" | "n/a";
  };
}

const NA = { groupingFact: "n/a", lengthFact: "n/a" } as const;
const PROXIED = { groupingFact: "PROXIED", lengthFact: "PROXIED" } as const;
const PROVENANCED = { groupingFact: "PROVENANCED", lengthFact: "PROVENANCED" } as const;

export const TERMS: readonly TermRow[] = [
  {
    term: "arrival/tagless-final/map",
    verbs: ["map", "vector-map", "string-map"],
    boxDiscipline: "element-preserving",
    containerBox: PROXIED,
  },
  {
    term: "arrival/tagless-final/filter",
    verbs: ["filter"],
    boxDiscipline: "element-preserving",
    containerBox: PROVENANCED,
  },
  { term: "arrival/tagless-final/reduce", verbs: ["reduce"], boxDiscipline: "element-unioning", containerBox: NA },
  { term: "arrival/tagless-final/sort", verbs: ["sort"], boxDiscipline: "element-preserving", containerBox: PROXIED },
  // `bytevector-append` completes the verb list — ABytevector genuinely implements this term
  // (ABytevector.ts's `arrival/tagless-final/concat`) via its own dedicated native binding,
  // same shape as string-append/vector-append; the table was missing exactly the kind of
  // absent-cell gap docs/test-suite-architecture.md F1 warns about (the DR4 divergence hid in an absent cell too).
  // containerBox: PROVENANCED — concat is length-changing; `concatPair` (APair.ts) mints the
  // rebuilt head's stamp as the deep-collapsed union of BOTH operands (a stronger, already-
  // correct realization of "union the container stamp with the decision lineage" — the
  // pre-existing H2 conservation-repair fix, unchanged by this batch).
  {
    term: "arrival/tagless-final/concat",
    verbs: ["append", "string-append", "vector-append", "bytevector-append"],
    boxDiscipline: "element-preserving",
    containerBox: PROVENANCED,
  },
  // "n/a": length is the CONSUMER of the length fact (C4 interim fix — reads the container's
  // own flat stamp via `withInputProvenance([this], count)`), not a producer of a container.
  {
    term: "arrival/tagless-final/length",
    verbs: ["length", "vector-length", "string-length"],
    boxDiscipline: "element-unioning",
    containerBox: NA,
  },
  { term: "arrival/tagless-final/equals", verbs: ["equal?"], boxDiscipline: "element-unioning", containerBox: NA },
  { term: "arrival/tagless-final/car", verbs: ["car"], boxDiscipline: "projecting", containerBox: NA },
  // cdr projects a SUB-CONTAINER (the remaining spine), not a scalar — outside R2's named
  // three (map/sort/reverse PROXIED, filter/remove PROVENANCED, constructors MINTED), but its
  // existing H2 conservation-repair fix (APair.ts's cdr) already mints a fresh derived stamp
  // (deep-collapsed union of what the sub-spine still reaches) — the closest of the three
  // named verbs, so PROVENANCED, with a stronger (deep, not shallow) derivation than filter's.
  { term: "arrival/tagless-final/cdr", verbs: ["cdr"], boxDiscipline: "projecting", containerBox: PROVENANCED },
  { term: "arrival/toJS", verbs: [], boxDiscipline: "element-unioning", containerBox: NA },
  { term: "arrival/print", verbs: [], boxDiscipline: "element-unioning", containerBox: NA },
] as const;
