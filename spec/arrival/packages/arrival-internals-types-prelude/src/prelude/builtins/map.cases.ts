// Bite cases for the `map` builtin — unary and multi-list (index-zip) overloads.
import { expectTypeOf } from "vitest";

// ── unary ────────────────────────────────────────────────────────────────────
expectTypeOf(map((n: number): number => n, [1, 2, 3])).toEqualTypeOf<List<number>>();
expectTypeOf(map((x: number): string => `${x}`, [1, 2, 3])).toEqualTypeOf<List<string>>();

// @ts-expect-error callback param type mismatches the list element type
map((x: string): string => x, [1, 2, 3]);
// @ts-expect-error second arg is not a list
map((n: number): number => n, 123);

// ── two lists (zip) ──────────────────────────────────────────────────────────
expectTypeOf(
  map((n: number, s: string): number => n + s.length, [1, 2] as List<number>, ["a", "b"] as List<string>),
).toEqualTypeOf<List<number>>();
expectTypeOf(
  map((a: number, b: number): boolean => a >= b, [1, 2] as List<number>, [0, 3] as List<number>),
).toEqualTypeOf<List<boolean>>();

// gepa shape: (map list examples scores) — pairwise into a 2-product
expectTypeOf(
  map(
    (a: { id: string }, b: number): Tuple<{ id: string }, number> => [a, b] as const,
    [{ id: "x" }] as List<{ id: string }>,
    [1] as List<number>,
  ),
).toEqualTypeOf<List<Tuple<{ id: string }, number>>>();

// @ts-expect-error two-list callback first param mismatches first list element
map((s: string, n: number): number => n, [1, 2] as List<number>, ["a"] as List<string>);
// @ts-expect-error two-list form still needs a list for the second sequence
map((a: number, b: number): number => a + b, [1, 2] as List<number>, 99);

// ── three lists ──────────────────────────────────────────────────────────────
expectTypeOf(
  map(
    (a: number, b: string, c: boolean): string => `${a}${b}${c}`,
    [1] as List<number>,
    ["x"] as List<string>,
    [true] as List<boolean>,
  ),
).toEqualTypeOf<List<string>>();
