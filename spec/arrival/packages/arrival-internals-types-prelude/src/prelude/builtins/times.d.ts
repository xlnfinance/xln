// ─────────────────────────────────────────────────────────────────────────────
// `*` — variadic numeric multiplication.
//
// Scheme semantics: (* n ...) → the product of all arguments; (* ) → 1.
// // Operator name `*` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────

declare function $star$(...n: number[]): number;
