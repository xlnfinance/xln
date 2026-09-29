// carriers — the type-layer's carrier vocabulary.
//
// "Scheme is a TS subset except lists." These are the *only* hand-written
// generic types — the closed tagless algebra zod cannot express. Harvested tool
// signatures and the lowered program reference this vocabulary; the lens prepends an
// ambient projection of it to its virtual compile. nil = null; vector = readonly T[]
// (native TS array); scalars/records project to plain TS directly. Fixed 2-products
// are Tuple (not a Pair brand); list generalizes pair spines.
//
// Authored as an `export declare` module (types-only — the lens never RUNS these; the
// emitted TS is inference-only) so bite-guards under __tests__/ import the same
// vocabulary the harvest emits against — one source of truth, no drift.

/** Honest top type for `z.schemeValue` — "any boxed scheme value", the R7RS-polymorphic
 *  domain of car/eq?/filter/vector elements. `unknown` IS the honest bound (a native/
 *  contour slot genuinely admits anything), but printing the bare keyword would erase
 *  the intent that this slot is DELIBERATELY unconstrained (vs. an unmapped schema
 *  falling through to `unknown` by DEFAULT) — a distinct named alias keeps that
 *  distinction visible in a harvested signature. */
export type SchemeValue = unknown;

declare const LIST_BRAND: unique symbol;

/** Opaque proper-list cons cell — the element type rides the phantom brand; the cons
 *  structure is hidden so a list is disjoint from a vector (`readonly T[]`), which is
 *  what makes the 3-way slot verdict clean. */
export interface Cons<out T> {
  readonly [LIST_BRAND]: T;
}

/** A proper list: a chain of `Cons` ending in null. The empty list IS `null`. */
export type List<T> = Cons<T> | null;

/** Fixed-arity product (replaces the old Pair brand). Native 2-tuple. */
export type Tuple<A = unknown, B = unknown> = readonly [A, B];

// ── constructors (lowering targets for '(…), (list …), (cons …)) ──────────────
export declare function list<T>(...xs: T[]): List<T>;
export declare function cons<H, T>(h: H, t: List<T>): List<H | T>; // prepend → List
export declare function cons<H, T>(h: H, t: T): Tuple<H, T>; //       dotted  → Tuple

// ── accessors — serve BOTH a proper List and a fixed Tuple ────────────────────
export declare function car<T>(xs: List<T>): T;
export declare function car<H>(p: Tuple<H, unknown>): H;
export declare function cdr<T>(xs: List<T>): List<T>;
export declare function cdr<T>(p: Tuple<unknown, T>): T;

// ── the closed tagless algebra — generic globals over List AND vector ─────────
// `map` multi-list = index-zip (same as lists.ts capability type / multiListMap).
export declare function map<T, B>(f: (x: T) => B, xs: List<T>): List<B>;
export declare function map<T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[];
export declare function map<A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
export declare function map<A, B, R>(f: (a: A, b: B) => R, as: readonly A[], bs: readonly B[]): readonly R[];
export declare function map<A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>;
export declare function map<A, B, C, R>(
  f: (a: A, b: B, c: C) => R,
  as: readonly A[],
  bs: readonly B[],
  cs: readonly C[],
): readonly R[];
export declare function filter<T>(p: (x: T) => unknown, xs: List<T>): List<T>;
export declare function filter<T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
/** Scheme/runtime order: (element, acc) → acc — not JS Array.reduce (acc, element). */
export declare function reduce<T, A>(f: (x: T, acc: A) => A, init: NoInfer<A>, xs: List<T> | readonly T[]): A;
export declare function length(xs: List<unknown> | readonly unknown[] | string): number;

// ── the slot probes (the lens's narrowing queries) ────────────────────────────
// `NonNullable<S>` strips the empty-list null AND optional null/undefined before classifying.

/** `SlotKind` is four-way (`string` is distinct here). */
export type SlotKind<S> = [NonNullable<S>] extends [Cons<unknown>]
  ? "list"
  : [NonNullable<S>] extends [readonly unknown[]]
    ? "vector"
    : [NonNullable<S>] extends [string]
      ? "string"
      : "scalar";

export type ElemOf<S> =
  NonNullable<S> extends Cons<infer E> ? E : NonNullable<S> extends readonly (infer E)[] ? E : never;

/** Does a value of type `S` admit a bare word as a string (free-form string slot)? */
export type AcceptsBareWord<S> = [NonNullable<S>] extends [readonly unknown[]]
  ? false
  : [NonNullable<S>] extends [Cons<unknown>]
    ? false
    : [string] extends [NonNullable<S>]
      ? true
      : false;

/** Is the slot string-typed (a string subtype — free-form or a closed string-literal enum), not an array? */
export type IsStringTyped<S> = [NonNullable<S>] extends [readonly unknown[]]
  ? false
  : [NonNullable<S>] extends [Cons<unknown>]
    ? false
    : [NonNullable<S>] extends [string]
      ? true
      : false;

// ── the `s` namespace — RESERVED-WORD special forms as calls on a property bag ────
//
// TS reserved words (`if`, `let`, `do`, `case`) parse-catastrophe as a bare head
// (`if(c, a, b)` starts an if-STATEMENT, not a call) but are legal PROPERTY names, so
// lower.ts routes these forms through `s.<name>(...)` instead. Declared here (the
// ambient-vocabulary file) so the same `s` is in scope everywhere the carriers are.
export declare const s: {
  /** `(if c a b)` / `(if c a)` → `s.if(c, a, b)` / `s.if(c, a)`. */
  if<T, F = undefined>(c: unknown, t: T, f?: F): T | F;
  /** `(let ((a v1) (b v2)) body…)` → `s.let(v1, v2, (a, b) => body)`. Also the emission
   *  target for `letrec`/`letrec*` (advisory fidelity — mutual-recursion scoping is not
   *  modeled; a single flat call is enough for typing purposes). */
  let<A extends readonly unknown[], R>(...args: [...A, (...bindings: A) => R]): R;
  /** Named let: `(let loop ((i 0)) body…)` → `s.namedLet(0, (loop, i) => body)`. `loop`'s
   *  type is the same `(...args: A) => R` shape as the call itself — a self-referential
   *  recursive-loop signature. */
  namedLet<A extends readonly unknown[], R>(...args: [...A, (loop: (...args: A) => R, ...bindings: A) => R]): R;
  /** `(cond (test e) … (else d))` → `s.cond([test, e], …, [true, d])` — `else` → `true`.
   *  Each clause is a `[test, result]` tuple; `R` is the union of every clause's result. */
  cond<R>(...clauses: readonly (readonly [unknown, R])[]): R;
  /** Parse-safety only (0 corpus occurrences) — `do`'s named-step/init binding structure
   *  is not type-faithfully expressible as a flat argument list without losing its
   *  per-binding (init, step) pairing; not attempted. */
  do(...args: unknown[]): unknown;
  /** Parse-safety only (0 corpus occurrences) — same rationale as `do`. */
  case(...args: unknown[]): unknown;
};

// ── the reachability query (the list-slot gate) ───────────────────────────────
// At a List slot after `(`, admit a head iff its return COULD be a list — mask only
// PROVABLY non-list. The `[unknown] extends [R]` arm is the nuke-guard: a generic / `if`
// / union return resolves to `unknown` and ADMITS, so we never block `(if …)`/`car`/etc.
// Operates on a RESOLVED return type — head-level admissibility before args (overload-
// aware, call-site-contextual resolution of an in-progress `(head …)`) is deferred:
// typing the actual call in context rather than this abstraction.
export type CouldBeList<R> = [unknown] extends [R]
  ? true
  : [Extract<R, Cons<unknown> | null>] extends [never]
    ? false
    : true;
