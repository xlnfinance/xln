// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `second` — element at index 1 of a list.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

expectTypeOf(second([1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(second(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error non-list argument
second(42);
// @ts-expect-error second of a number list is number, not string
const s: string = second([1, 2, 3]);
