// ─────────────────────────────────────────────────────────────────────────────
// `map` — apply a function over one or more lists, collecting the results.
//
// Scheme semantics (R7RS 6.10 / SRFI-1):
//   (map f list)        → list of (f x) for each x
//   (map f xs ys …)     → list of (f x y …) index-zipped; stops at shortest
//
// Runtime truth: lists.ts `map` — single list uses the operand's own map;
// multi-list is multiListMap / index-zip emit. The overload set below is the
// type surface of that zip-alike, not a type-emit rewrite.
//
// Unary form: callback param ↔ element type so
//   (map (lambda (n) (string-upcase n)) '(1 2 3)) bites.
// Multi-list form: callback arity matches list count; each list pins its
// corresponding param.
// ─────────────────────────────────────────────────────────────────────────────

declare function map<A, B>(f: (a: A) => B, xs: List<A>): List<B>;
declare function map<A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>;
declare function map<A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>;
