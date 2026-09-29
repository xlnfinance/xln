// ─────────────────────────────────────────────────────────────────────────────
// `some` — existential quantifier over one or more parallel lists.
//
// Scheme semantics: (some pred list) → #t iff pred is truthy for at least one
// element (SRFI-1 `any?` / alias `some`); (some pred xs ys …) index-zips.
// Predicate-first; multi-list is the same zip-alike bridge as `map`/`every`.
//
// Generic in each list's element type so the matching predicate parameter is
// checked — `(some odd? xs)` where xs is a string-list bites; two-list form
// pins both sides of the pred.
// ─────────────────────────────────────────────────────────────────────────────

declare function some<T>(pred: (x: T) => boolean, xs: List<T>): boolean;
declare function some<A, B>(pred: (a: A, b: B) => boolean, as: List<A>, bs: List<B>): boolean;
declare function some<A, B, C>(pred: (a: A, b: B, c: C) => boolean, as: List<A>, bs: List<B>, cs: List<C>): boolean;
