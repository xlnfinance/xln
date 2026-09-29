// ─────────────────────────────────────────────────────────────────────────────
// `filter` — keep the elements of a list that satisfy a predicate.
//
// Scheme semantics: (filter pred list) → a list of the elements `x` of `list`
// for which `(pred x)` is truthy. Element type is preserved (filter narrows the
// COUNT, not the type), so the result is `List<T>` over the same `T`.
//
// // ─────────────────────────────────────────────────────────────────────────────

declare function filter<T>(pred: (x: T) => boolean, xs: List<T>): List<T>;
