// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `*` — expect-type assertions over the ambient global functions (typed by
// the ambient declare functions; base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// `*` is fully variadic: (* ) → 1.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// nullary: (* ) → 1
expectTypeOf($star$()).toEqualTypeOf<number>();
// binary multiplication
expectTypeOf($star$(3, 4)).toEqualTypeOf<number>();
// variadic
expectTypeOf($star$(2, 3, 4, 5)).toEqualTypeOf<number>();

// @ts-expect-error string argument is not number
$star$("a", 2);
// @ts-expect-error boolean argument is not number
$star$(true, 3);
