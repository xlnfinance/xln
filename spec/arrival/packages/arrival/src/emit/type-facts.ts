// emit/type-facts — TypeFacts: the membrane between tsc and emit rules. Types only;
// layering rule (typescript-free) lives in ./index.ts — the compiler extracts facts FROM
// ts.Type; rules in arrival core consume only this vocabulary.

/** Per-node type facts the compiler's type pass proves and an emit rule consumes.
 *
 *  Law F (fail-safe facts): ABSENCE of a fact ⇒ the conservative residual. Unmapped
 *  spans, `any`/`unknown`, extraction failures all land safe, never clean — so every
 *  field is optional and every consumer must tolerate absence.
 *
 *  Deliberately NOT facts (each a second-source-of-truth hazard):
 *  - asyncness — lives exclusively in ASYNC-IFY's post-emit dataflow (Law W); a
 *    `callable.async` fact could disagree with the real seeded verdict.
 *  - exactness — one number type; no runtime representation exists to dispatch on.
 *
 *  Growth discipline: a new fact lands only as a package deal — leaf change + extraction
 *  rule + consuming emit branch + oracle rows, in one reviewed change. */
export interface TypeFacts {
  /** Condition is provably boolean — Law T emits the bare `c ? a : b`. */
  boolean?: true;
  /** `[T, ...T[]]` — indexing proven safe (car's clean branch). */
  nonEmptyList?: true;
  /** Tuple fixed-prefix depth — `caddr` needs ≥ 3; powers Law-U lens warnings. */
  lengthAtLeast?: number;
  list?: true;
  /** Array-backed pair (pairs are not a separate primitive); adds non-emptiness. */
  pair?: true;
  /** A list's ELEMENT facts, derived recursively (feeds eta'd rules in HOF positions). */
  elementFacts?: TypeFacts;
  /** The INSTANTIATED signature at THIS use site — what lets an eta-expanded value-position
   *  rule emit clean bodies: tsc has already instantiated `car<T>` against the consuming
   *  HOF's element type. `arity` absent when variadic/rest. */
  callable?: {
    arity?: number;
    paramFacts?: TypeFacts[];
  };
  stringy?: true;
  numeric?: true;
  // Extended only by ADDING fields; consumers must tolerate absence (Law F).
}
