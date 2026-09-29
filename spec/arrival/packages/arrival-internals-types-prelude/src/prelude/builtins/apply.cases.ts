// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `apply` leaf (apply.d.ts → spread a list as a function's
// args). expect-type assertions over the ambient global functions. Args are
// plain tuples/lists (List = T[]; no readonly split). Positives pin return
// with `.toEqualTypeOf<R>()`. Negatives use `// @ts-expect-error` (2345).
// Base vocab (`number`/`string`/`List`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// args tuple matches the callee's parameter types → returns the callee's brand
expectTypeOf(apply((a: number, b: number) => a + b, [1, 2])).toEqualTypeOf<number>();
expectTypeOf(apply((x: string) => x, ["hi"])).toEqualTypeOf<string>();

// (apply + xs) / (apply * xs) — List is the same dialect as rest number[].
expectTypeOf(apply($plus$, [1, 2, 3] as List<number>)).toEqualTypeOf<number>();
expectTypeOf(apply($star$, [2, 3, 4] as List<number>)).toEqualTypeOf<number>();

// @ts-expect-error second arg is a string but the callee's 2nd param is number → TS2345
apply((a: number, b: number) => a + b, [1, "x"] as [number, string]);
// @ts-expect-error first arg is not a function → TS2345
apply(5, [1, 2]);
