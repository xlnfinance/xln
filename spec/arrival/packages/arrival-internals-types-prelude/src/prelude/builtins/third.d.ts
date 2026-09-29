// ─────────────────────────────────────────────────────────────────────────────
// `third` — third element of a list.
//
// Scheme semantics: (third list) → the third element of a list (index 2),
// equivalent to (car (cdr (cdr list))).
// ─────────────────────────────────────────────────────────────────────────────

declare function third<T>(xs: List<T>): T;
