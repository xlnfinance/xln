// Bite cases for `find`.
import { expectTypeOf } from "vitest";

expectTypeOf(find((n: number) => n > 0, [1, 2, 3])).toEqualTypeOf<number | undefined>();
expectTypeOf(find((s: string) => s.length > 0, ["a", "bb"])).toEqualTypeOf<string | undefined>();

// @ts-expect-error predicate param mismatches list element type
find((s: string) => s.length > 0, [1, 2, 3]);
// @ts-expect-error result may be undefined
const n: number = find((n: number) => n > 0, [1, 2, 3]);
// @ts-expect-error second arg is not a list
find((n: number) => n > 0, 123);
