// ─────────────────────────────────────────────────────────────────────────────
// `"/"` — arithmetic division (and unary reciprocal).
//
// Scheme semantics: (/ n ...) → divide the first arg by the rest, or
//   take the reciprocal of a single argument. At least one number required.
// // Operator name `/` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────

declare function $slash$(first: number, ...rest: number[]): number;
