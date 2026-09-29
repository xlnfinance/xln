// Bite cases for `filter`.
import { expectTypeOf } from "vitest";

expectTypeOf(filter((x: number) => x > 0, [1, 2, 3])).toEqualTypeOf<List<number>>();
expectTypeOf(filter((s: string) => s.length > 0, ["a", "b"])).toEqualTypeOf<List<string>>();

// @ts-expect-error predicate param disagrees with list element type
filter((s: string) => s.length > 0, [1, 2, 3]);
// @ts-expect-error second argument is not a list
filter((x: number) => x > 0, 123);
