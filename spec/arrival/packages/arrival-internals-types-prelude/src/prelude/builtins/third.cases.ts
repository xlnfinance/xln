// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `third` — third element of a list.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

expectTypeOf(third([1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(third(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error non-list argument
third(42);
// @ts-expect-error third of a number list is number, not string
const s: string = third([1, 2, 3]);
