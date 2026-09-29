// ─────────────────────────────────────────────────────────────────────────────
// `cdr` — the REST / TAIL of a list.
//
// Scheme semantics: (cdr list) → all elements of `list` after the first.
// // ─────────────────────────────────────────────────────────────────────────────

declare function cdr<T>(xs: List<T>): List<T>;
