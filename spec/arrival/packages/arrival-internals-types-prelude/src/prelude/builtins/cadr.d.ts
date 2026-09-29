// ─────────────────────────────────────────────────────────────────────────────
// `cadr` — second element (car of cdr) of a list.
//
// Scheme semantics: (cadr xs) → the second element of xs, i.e. (car (cdr xs)).
// // ─────────────────────────────────────────────────────────────────────────────

declare function cadr<T>(xs: List<T>): T;
