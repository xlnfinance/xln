// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `-` — expect-type assertions over the ambient global functions (typed by
// the ambient declare functions; base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `-` requires at least one number argument (unary negation or n-ary subtraction).
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// unary negation: (- 5) → -5
expectTypeOf($dash$(5)).toEqualTypeOf<number>();
// binary subtraction: (- 10 3) → 7
expectTypeOf($dash$(10, 3)).toEqualTypeOf<number>();
// variadic: (- 100 10 5) → 85
expectTypeOf($dash$(100, 10, 5)).toEqualTypeOf<number>();

// @ts-expect-error "-" requires at least one number argument — no args is disallowed
$dash$();
// @ts-expect-error "-" does not accept strings
$dash$("a", 1);
