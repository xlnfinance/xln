// ─────────────────────────────────────────────────────────────────────────────
// `+` — variadic numeric addition.
//
// Scheme semantics: (+ n ...) → the sum of all arguments; (+ ) → 0.
// // Operator name `+` is not a valid TS identifier → bracketed string key.
// ─────────────────────────────────────────────────────────────────────────────

declare function $plus$(...n: number[]): number;
