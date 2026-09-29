// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `abs` `sqrt` `floor` `round` `min` `max` — numeric math cluster.
// expect-type assertions over the ambient global functions (typed by the ambient declare functions;
// base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `abs`/`sqrt`/`floor`/`round` are unary; `min`/`max` are variadic (≥1 arg).
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// abs of a number returns number
expectTypeOf(abs(-5)).toEqualTypeOf<number>();
// sqrt of a number returns number
expectTypeOf(sqrt(9)).toEqualTypeOf<number>();
// floor of a number returns number
expectTypeOf(floor(3.7)).toEqualTypeOf<number>();
// round of a number returns number
expectTypeOf(round(2.5)).toEqualTypeOf<number>();
// min/max are variadic — one or more number args
expectTypeOf(min(1, 2, 3)).toEqualTypeOf<number>();
expectTypeOf(max(4, 5, 6)).toEqualTypeOf<number>();

// @ts-expect-error abs requires number, not a string
abs("hello");
// @ts-expect-error min requires number args, not strings
min("a", "b");
// @ts-expect-error sqrt requires number, not boolean
sqrt(true);
