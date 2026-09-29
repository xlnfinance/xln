// ─────────────────────────────────────────────────────────────────────────────
// `<`, `>`, `<=`, `>=`, `=` — numeric comparison / equality family.
//
// Scheme semantics: (< n ...) → #t iff each argument is strictly less than
//   the next; chained n-ary comparison. All five operators work the same way:
//   they accept ≥2 number arguments and return a boolean. The emitter lowers them
//   via `chainCompare` which chains pairwise `&&`-joined comparisons for n>2.
//
// // ─────────────────────────────────────────────────────────────────────────────

declare function $less$(...n: number[]): boolean;
declare function $greater$(...n: number[]): boolean;
declare function $less$$eq$(...n: number[]): boolean;
declare function $greater$$eq$(...n: number[]): boolean;
declare function $eq$(...n: number[]): boolean;
