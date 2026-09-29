// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `car` — the REFERENCE leaf.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

expectTypeOf(car([1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(car(["a", "b"])).toEqualTypeOf<string>();

// @ts-expect-error argument is not a list
car(5);
// @ts-expect-error head of a number list is number, not string
const s: string = car([1, 2, 3]);
