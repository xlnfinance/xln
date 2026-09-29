// ─────────────────────────────────────────────────────────────────────────────
// `caddr` — third element accessor.
//
// Scheme semantics: (caddr list) → the third element of a list (index 2),
// equivalent to (car (cdr (cdr list))).
// // ─────────────────────────────────────────────────────────────────────────────

declare function caddr<T>(xs: List<T>): T;
