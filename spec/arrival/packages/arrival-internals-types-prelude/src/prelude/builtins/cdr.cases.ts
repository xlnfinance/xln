// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `cdr` — the REST / TAIL accessor (cdr.d.ts → `cdr<T>(xs: List<T>): List<T>`).
// expect-type assertions over the ambient global functions; inputs are WIDENED list literals
// so the result is the exact brand `List<T>` — positives pin with `.toEqualTypeOf<T>()`
// (an arg-rot OR a return→any rot both bite). Negatives use `// @ts-expect-error`:
// the unused directive becomes the failure if the signature rots so the line stops
// erroring. Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// cdr of a typed list returns the same element-type list
expectTypeOf(cdr([1, 2, 3])).toEqualTypeOf<List<number>>();
// cdr of a string list
expectTypeOf(cdr(["a", "b", "c"])).toEqualTypeOf<List<string>>();

// @ts-expect-error cdr requires a List<T>, not a bare number
cdr(5);
// @ts-expect-error cdr requires a List<T>, not a string
cdr("hello");
