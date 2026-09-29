// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `sort` builtin (sort.d.ts → `sort<T>(xs, cmp?): List<T>`).
// expect-type assertions over the ambient global functions; inputs are WIDENED list literals
// so element type `T` resolves to the exact brand. Arg order is (LIST, comparator?)
// — list FIRST, comparator OPTIONAL second. Element type is preserved in→out, so a
// positive pins the result list (or an indexed element) with `.toEqualTypeOf<T>()`.
// Negatives use `// @ts-expect-error`. Base vocab (`List`/`number`/`string`) is ambient
// from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// sort without a comparator — element type preserved
expectTypeOf(sort([3, 1, 2])).toEqualTypeOf<List<number>>();
// sort with a numeric comparator; result element type preserved (number)
expectTypeOf(sort([3, 1, 2], (a: number, b: number): number => a - b)[0]).toEqualTypeOf<number>();
// comparator over string elements
expectTypeOf(sort(["b", "a"], (a: string, b: string): number => (a < b ? -1 : 1))).toEqualTypeOf<List<string>>();

// @ts-expect-error comparator must RETURN a number, not a string
sort([1, 2], (a: number, b: number): number => "nope");
// @ts-expect-error comparator params are T (number here): cannot call a string method on them
sort([1, 2], (a: number, b: number) => a.toUpperCase());
// @ts-expect-error result is List<number>; assigning an element to a string is wrong
const s: string = sort([3, 1, 2])[0];
