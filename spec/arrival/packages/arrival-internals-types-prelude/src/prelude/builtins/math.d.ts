// ─────────────────────────────────────────────────────────────────────────────
// `abs` `sqrt` `floor` `round` `min` `max` — numeric math cluster.
//
// Scheme semantics:
//   (abs x)          → |x|, same type (number → number)
//   (sqrt x)         → square root
//   (floor x)        → largest integer ≤ x
//   (round x)        → nearest integer (banker's rounding per R7RS)
//   (min x ...)      → smallest of one or more numbers
//   (max x ...)      → largest of one or more numbers
//
// // ─────────────────────────────────────────────────────────────────────────────

declare function abs(x: number): number;
declare function sqrt(x: number): number;
declare function floor(x: number): number;
declare function round(x: number): number;
declare function min(...n: number[]): number;
declare function max(...n: number[]): number;
