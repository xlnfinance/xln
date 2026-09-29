// ─────────────────────────────────────────────────────────────────────────────
// `max-by` — the element of a list maximizing a numeric key.
//
// Scheme semantics: (max-by key xs) → the element x of `xs` for which `(key x)`
//   is greatest. `key` is applied to each element and the results are compared
//   with `>`, so `key` must yield a number. Empty list errors at runtime.
//     `${list}.reduce((acc, el) => (${key(el)} > ${key("acc")} ? el : acc))`
//
// // The key function is generic over the element type `T` so a mis-typed key
// callback bites; the return is `T` (an element), NOT `number` (the key value).
// ─────────────────────────────────────────────────────────────────────────────

declare function max$dash$by<T>(key: (x: T) => number, xs: List<T>): T;
