// ─────────────────────────────────────────────────────────────────────────────
// `modulo` / `remainder` / `quotient` — integer division family.
//
// Scheme semantics:
//   (modulo   a b) → a mod b (floor-based sign; same as JS % for same-sign)
//   (remainder a b) → a remainder b (truncate-based; same as JS %)
//   (quotient  a b) → truncated integer quotient (Math.trunc(a/b))
// All three take exactly 2 numeric arguments and return a number.
//
// ─────────────────────────────────────────────────────────────────────────────

declare function modulo(a: number, b: number): number;
declare function remainder(a: number, b: number): number;
declare function quotient(a: number, b: number): number;
