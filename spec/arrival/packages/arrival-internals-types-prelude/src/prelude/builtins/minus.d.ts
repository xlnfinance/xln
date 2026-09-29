// ─────────────────────────────────────────────────────────────────────────────
// `"-"` — arithmetic subtraction (and unary negation).
//
// Scheme semantics: (- n ...) → subtract remaining args from the first, or
// // ─────────────────────────────────────────────────────────────────────────────

declare function $dash$(first: number, ...rest: number[]): number;
