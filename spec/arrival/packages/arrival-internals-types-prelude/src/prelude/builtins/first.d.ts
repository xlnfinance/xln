// ─────────────────────────────────────────────────────────────────────────────
// `first` — first element of a list (alias of `car`).
//
// Scheme semantics: (first list) → the head element of a non-empty list.
// ─────────────────────────────────────────────────────────────────────────────

declare function first<T>(xs: List<T>): T;
