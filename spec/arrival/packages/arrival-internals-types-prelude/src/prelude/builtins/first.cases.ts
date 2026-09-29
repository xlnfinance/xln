// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `first` — first element of a list, alias of `car`.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

expectTypeOf(first([1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(first(["a", "b"])).toEqualTypeOf<string>();

// @ts-expect-error non-list argument
first(42);
// @ts-expect-error first of a number list is number, not string
const s: string = first([1, 2, 3]);
