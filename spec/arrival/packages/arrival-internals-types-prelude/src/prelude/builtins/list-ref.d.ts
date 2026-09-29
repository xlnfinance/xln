// ─────────────────────────────────────────────────────────────────────────────
// `list-ref` — indexed element access on a list.
//
// Scheme semantics: (list-ref list k) → the k-th element (0-based) of `list`.
// // ─────────────────────────────────────────────────────────────────────────────

declare function list$dash$ref<T>(xs: List<T>, i: number): T;
