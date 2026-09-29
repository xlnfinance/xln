// ─────────────────────────────────────────────────────────────────────────────
// `every` — universal quantifier over one or more parallel lists.
//
// Scheme semantics (SRFI-1): (every pred xs) → #t iff pred holds for all
// elements; (every pred xs ys …) index-zips — pred applied to each element
// tuple. Predicate FIRST, list(s) after.
//
// Runtime truth: srfi-1 `%every` / multi-list parallel walk. Same zip-alike
// arity bridge as `map` — overloads type the Scheme call shape the lens emits.
// Precise where Scheme is polymorphic: each list's element type binds the
// matching predicate parameter. Return is `boolean` (honest #t/#f surface for
// the type lens; SRFI-1's last-truthy-result shape is a runtime concern).
// ─────────────────────────────────────────────────────────────────────────────

declare function every<T>(pred: (x: T) => boolean, xs: List<T>): boolean;
declare function every<A, B>(pred: (a: A, b: B) => boolean, as: List<A>, bs: List<B>): boolean;
declare function every<A, B, C>(pred: (a: A, b: B, c: C) => boolean, as: List<A>, bs: List<B>, cs: List<C>): boolean;
