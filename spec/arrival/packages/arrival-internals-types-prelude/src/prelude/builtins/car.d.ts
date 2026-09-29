// ─────────────────────────────────────────────────────────────────────────────
// `car` — the REFERENCE leaf the sibling builtins follow.
//
// Scheme semantics: (car list) → the head element of a non-empty list.
//
// Call form lowers to index access `(xs)[0]` in type-emit; this declare remains
// for value position (`map car xs`) and any residual ambient calls.
// ─────────────────────────────────────────────────────────────────────────────

declare function car<T>(xs: List<T>): T;
