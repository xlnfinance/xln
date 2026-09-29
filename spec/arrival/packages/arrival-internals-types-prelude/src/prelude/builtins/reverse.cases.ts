// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `reverse` — reverses a list (reverse.d.ts → `reverse<T>(xs: List<T>): List<T>`).
// expect-type assertions over the ambient global functions; inputs are WIDENED list literals
// so results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite); negatives use `// @ts-expect-error`.
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// reverse of a number list returns a number list
expectTypeOf(reverse([1, 2, 3])).toEqualTypeOf<List<number>>();
// reverse of a string list returns a string list
expectTypeOf(reverse(["a", "b", "c"])).toEqualTypeOf<List<string>>();

// @ts-expect-error reverse requires a List<T>, not a bare number
reverse(42);
// @ts-expect-error reverse requires a List<T>, not a string
reverse("hello");
