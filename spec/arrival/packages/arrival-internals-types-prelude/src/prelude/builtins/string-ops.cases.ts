// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `string-append`, `string-length`, `string-upcase`,
// `string-downcase`, `string-contains`, `string-join` (string-ops.d.ts). expect-type assertions
// over the ambient global functions; inputs are WIDENED string literals so the results are
// exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot OR a
// return→any rot both bite). Negatives use `// @ts-expect-error`: a non-string arg
// bites at the call (2345); if the signature rots to `any` the line stops erroring
// and the unused directive becomes the failure.
// Base vocab (`string`/`number`/`boolean`/`List`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// string-append of multiple string values returns string
expectTypeOf(string$dash$append("hello", " ", "world")).toEqualTypeOf<string>();
// string-length of a string returns number
expectTypeOf(string$dash$length("hello")).toEqualTypeOf<number>();
// string-upcase returns string
expectTypeOf(string$dash$upcase("hello")).toEqualTypeOf<string>();
// string-downcase returns string
expectTypeOf(string$dash$downcase("HELLO")).toEqualTypeOf<string>();
// string-contains returns boolean
expectTypeOf(string$dash$contains("hello world", "world")).toEqualTypeOf<boolean>();
// string=? / string-ci=? — case-sensitive / case-insensitive equality
expectTypeOf(string$eq$$qmark$("a", "a")).toEqualTypeOf<boolean>();
expectTypeOf(string$dash$ci$eq$$qmark$("A", "a")).toEqualTypeOf<boolean>();
// string-join: list-first, optional delimiter, folds to one string (SRFI-13)
expectTypeOf(string$dash$join(["a", "b", "c"])).toEqualTypeOf<string>();
expectTypeOf(string$dash$join(["a", "b"], ", ")).toEqualTypeOf<string>();

// @ts-expect-error string-append requires string args, not number
string$dash$append(42, "world");
// @ts-expect-error string-length requires string, not a number
string$dash$length(42);
// @ts-expect-error string-contains requires two string args, not a number as second arg
string$dash$contains("hello", 42);
// @ts-expect-error string-ci=? requires string args
string$dash$ci$eq$$qmark$(42, "a");
// @ts-expect-error string-join wants a list of strings, not a scalar string
string$dash$join("a,b");
// @ts-expect-error string-join delimiter is a string, not a number
string$dash$join(["a", "b"], 1);
