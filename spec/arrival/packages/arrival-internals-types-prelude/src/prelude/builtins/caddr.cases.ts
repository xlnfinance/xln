// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `caddr` — third element accessor, (car (cdr (cdr xs)))
// (caddr.d.ts → `caddr<T>(xs: List<T>): T`). expect-type assertions over the ambient
// `/*__arr*/`; inputs are WIDENED list literals so the result is the exact element brand
// — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a return→any rot both
// bite). Negatives use `// @ts-expect-error`. Base vocab (`List`/`number`/`string`) is
// ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// (caddr (list 1 2 3)) → 3 (a number)
expectTypeOf(caddr([1, 2, 3])).toEqualTypeOf<number>();
// (caddr (list "a" "b" "c")) → "c" (a string)
expectTypeOf(caddr(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error caddr of a non-list (number) is not assignable to List<T> (TS2345)
caddr(42);
