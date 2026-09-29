// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `/` — expect-type assertions over the ambient global functions (typed by
// the ambient declare functions; base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `/` requires at least one number argument (unary reciprocal or n-ary division).
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// unary reciprocal: (/ 4) → 0.25
expectTypeOf($slash$(4)).toEqualTypeOf<number>();
// binary division: (/ 10 2) → 5
expectTypeOf($slash$(10, 2)).toEqualTypeOf<number>();
// variadic: (/ 100 2 5) → 10
expectTypeOf($slash$(100, 2, 5)).toEqualTypeOf<number>();

// @ts-expect-error "/" requires at least one number argument — no args is disallowed
$slash$();
// @ts-expect-error "/" does not accept strings
$slash$("a", 2);
