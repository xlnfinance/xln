// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `reduce` (reduce.d.ts →
//   `reduce<A,B>(fn: (x: A, acc: B) => B, init: NoInfer<B>, xs: List<A>): B`).
// Scheme callback order: **(element, acc)**. expect-type over ambient globals.
// // ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// Sum: element first, acc second (Scheme).
expectTypeOf(reduce((x: number, acc: number) => acc + x, 0, [1, 2, 3])).toEqualTypeOf<number>();
// Heterogeneous fold: list of strings → number accumulator (A ≠ B).
expectTypeOf(reduce((s: string, acc: number) => acc + s.length, 0, ["a", "bb"])).toEqualTypeOf<number>();

// Empty seed + cons: B inferred from callback return, not never[] from [].
expectTypeOf(reduce((x: number, acc: List<number>) => cons(x, acc), [], [1, 2, 3] as List<number>)).toEqualTypeOf<
  List<number>
>();

// @ts-expect-error init type (string) disagrees with the reducer's accumulator/return (number)
reduce((x: number, acc: number) => acc + x, "seed", [1, 2, 3]);
// @ts-expect-error reducer element param typed string but the list is List<number>
reduce((x: string, acc: number) => acc + x.length, 0, [1, 2, 3]);
