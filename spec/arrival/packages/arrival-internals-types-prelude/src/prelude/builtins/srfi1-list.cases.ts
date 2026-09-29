// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the live SRFI-1-adjacent list family (srfi1-list.d.ts). expect-type
// assertions over the ambient global functions; inputs are WIDENED list literals (`[1,2,3]` →
// number[]) so the results are exact brands — positives pin with `.toEqualTypeOf<T>()`
// (an arg-rot OR a return→any rot both bite). Negatives use `// @ts-expect-error`:
// a swapped/wrong arg bites at the call (2345), a wrong-typed threaded result at the
// assignment (2322); if the signature rots to `any` the line stops erroring and the
// unused directive becomes the failure.
// Base vocab (`List`/`number`/`string`/`void`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// take / drop — count-first, element type preserved
expectTypeOf(take(2, [1, 2, 3, 4])).toEqualTypeOf<List<number>>();
expectTypeOf(drop(1, ["a", "b", "c"])).toEqualTypeOf<List<string>>();

// flatten — argument is a list; element type is unknown
// (`concat` is not bound — string concat is R7RS string-append / SRFI-13 string-join.)
expectTypeOf(
  flatten([
    [1, 2],
    [3, [4]],
  ]),
).toEqualTypeOf<List<unknown>>();

// fold — Scheme callback (element, acc); B threads from seed through body
expectTypeOf(fold((x: number, acc: number): number => acc + x, 0, [1, 2, 3])).toEqualTypeOf<number>();
expectTypeOf(fold((x: number, a: List<number>): List<number> => a, [], [1, 2, 3])).toEqualTypeOf<List<number>>();

// nth — index-first, element-or-undefined
expectTypeOf(nth(1, [10, 20, 30])).toEqualTypeOf<number | undefined>();

// for-each — void return; callback param bound to element type
expectTypeOf(
  for$dash$each(
    (x: number): void => {
      x;
    },
    [1, 2, 3],
  ),
).toEqualTypeOf<void>();

// count — number result; pred param bound to element type
expectTypeOf(count((x: number): boolean => x > 1, [1, 2, 3])).toEqualTypeOf<number>();

// remove — inverse filter, element type preserved
expectTypeOf(remove((x: number): boolean => x > 1, [1, 2, 3])).toEqualTypeOf<List<number>>();

// @ts-expect-error take — args swapped (list where the count goes)
take([1, 2, 3], 2);
// @ts-expect-error drop — wrong-typing the threaded result (string list cannot be number list)
const x: List<number> = drop(1, ["a", "b"]);
// @ts-expect-error flatten — argument is not a list
flatten(5);
// @ts-expect-error fold — callback acc type disagrees with the seed type (string acc vs number seed)
fold((x: number, acc: string): string => acc, 0, [1, 2, 3]);
// @ts-expect-error fold — element type mismatches the callback's x param (string x over number list)
fold((x: string, acc: number): number => acc, 0, [1, 2, 3]);
// @ts-expect-error nth — args swapped (list where the index goes)
nth([10, 20], 1);
// @ts-expect-error nth — wrong element type threaded out
const n: string | undefined = nth(1, [10, 20, 30]);
for$dash$each(
  (x: string): void => {
    x;
  },
  // @ts-expect-error for-each — callback param type mismatches the element type
  [1, 2, 3],
);
// @ts-expect-error count — pred param type mismatches the element type
count((x: string): boolean => x.length > 0, [1, 2, 3]);
