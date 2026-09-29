// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `last` — last element of a list.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

expectTypeOf(last([1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(last(["a", "b", "c"])).toEqualTypeOf<string>();

// @ts-expect-error non-list argument (number) is not assignable to List<T>
last(42);
// @ts-expect-error last of a number list is number, not string
const s: string = last([1, 2, 3]);
