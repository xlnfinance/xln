// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `cadr` — second element (car of cdr) of a list
// (cadr.d.ts → `cadr<T>(xs: List<T>): T`). expect-type assertions over the ambient
// `/*__arr*/`; inputs are WIDENED list literals so the result is the exact element brand
// — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a return→any rot both
// bite). Negatives use `// @ts-expect-error`. Base vocab (`List`/`number`/`string`) is
// ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// cadr of a number list → number
expectTypeOf(cadr([10, 20, 30])).toEqualTypeOf<number>();
// cadr of a string list → string
expectTypeOf(cadr(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error cadr of a plain number (not a List) → TS2345
cadr(42);
// @ts-expect-error result is number, not string → TS2322
const s: string = cadr([1, 2, 3]);
