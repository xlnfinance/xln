// ─────────────────────────────────────────────────────────────────────────────
// `sort` — stable list sort with an optional comparator.
//
// Scheme semantics: (sort list [comparator]) → a new list with the same elements
//   sorted. The comparator, if supplied, is `(a b) → number` (JS-style ordering:
//   <0 a-before-b, >0 b-before-a). With no comparator, the runtime falls back to
//   the default JS `Array.prototype.sort` ordering.
//   NOTE: runtime arg order is (LIST, comparator?) — list FIRST, comparator
//   OPTIONAL second — NOT the `(cmp, xs)` shape; grounded below.
// // Element type `T` is preserved in → out so a mis-typed comparator or a
// wrong-typed result bites.
// ─────────────────────────────────────────────────────────────────────────────

declare function sort<T>(xs: List<T>, cmp?: (a: T, b: T) => number): List<T>;
