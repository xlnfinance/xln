// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `list-ref` — indexed element access (list-ref.d.ts →
// `"list-ref"<T>(xs: List<T>, i: number): T`). expect-type assertions over the ambient
// `/*__arr*/`; inputs are WIDENED list literals so results are exact brands — positives
// pin with `.toEqualTypeOf<T>()` (an arg-rot OR a return→any rot both bite). Negatives
// use `// @ts-expect-error`: a wrong-typed arg bites at the call (2345).
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// list-ref on a number list returns number
expectTypeOf(list$dash$ref([1, 2, 3], 0)).toEqualTypeOf<number>();
// list-ref on a string list returns string
expectTypeOf(list$dash$ref(["a", "b", "c"], 2)).toEqualTypeOf<string>();

// @ts-expect-error first arg must be List<T>, not a bare number
list$dash$ref(42, 0);
// @ts-expect-error second arg must be number, not a string
list$dash$ref([1, 2, 3], "first");
