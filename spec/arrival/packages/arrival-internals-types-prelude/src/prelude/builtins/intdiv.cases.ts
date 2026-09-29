// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `modulo` / `remainder` / `quotient` — integer division family.
// expect-type assertions over the ambient global functions (typed by the ambient declare functions;
// base vocab `number` is ambient from ../types.d.ts).
//   • positives  → `expectTypeOf(...).toEqualTypeOf<number>()` pins the EXACT result
//     type, so an arg-rot OR a return→any rot both bite.
//   • negatives  → `// @ts-expect-error`; if the signature rots so the line stops
//     erroring, the unused directive itself becomes the compile error.
// All three take exactly 2 numeric arguments.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// modulo: two numbers → number
expectTypeOf(modulo(10, 3)).toEqualTypeOf<number>();
// remainder: two numbers → number
expectTypeOf(remainder(10, 3)).toEqualTypeOf<number>();
// quotient: two numbers → number
expectTypeOf(quotient(10, 3)).toEqualTypeOf<number>();

// @ts-expect-error string argument is not number
modulo("10", 3);
// @ts-expect-error boolean argument is not number
quotient(true, 2);
// @ts-expect-error missing second argument (arity must be exactly 2)
remainder(10);
