// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `append` (append.d.ts → `append<T>(...xs: List<T>[]): List<T>`).
// expect-type assertions over the ambient global functions; inputs are WIDENED list literals
// so the result is an exact brand — positives pin with `.toEqualTypeOf<T>()`.
// Every argument must be a list of the same element type T; the result is List<T>.
// Negatives use `// @ts-expect-error`; if the signature rots so the line stops
// erroring, the unused directive itself becomes the compile error.
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// append two number lists → List<number>
expectTypeOf(append([1, 2], [3, 4])).toEqualTypeOf<List<number>>();
// append a single string list → List<string>
expectTypeOf(append(["a", "b", "c"])).toEqualTypeOf<List<string>>();
// append three lists of the same element type
expectTypeOf(append([1], [2], [3])).toEqualTypeOf<List<number>>();

// (apply append (map …)) — args is List<List<T>> (array of lists).
// Mutable rest `List<T>[]` used to reject this; rest must accept it.
expectTypeOf(
  apply(
    append,
    map((x: List<number>): List<number> => x, [[1], [2]] as List<List<number>>),
  ),
).toEqualTypeOf<List<number>>();
// custdev _util shape: map may wrap scalars into singleton lists
expectTypeOf(
  apply(
    append,
    map((x: unknown): List<unknown> => (Array.isArray(x) ? (x as List<unknown>) : list(x)), [
      1,
      [2, 3],
    ] as List<unknown>),
  ),
).toEqualTypeOf<List<unknown>>();

// @ts-expect-error a bare number is not a List
append(42);
// @ts-expect-error a string is not a List
append("hello", "world");
