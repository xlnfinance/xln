// Bite cases for `every` — unary and multi-list (index-zip) overloads.
import { expectTypeOf } from "vitest";

// ── unary ────────────────────────────────────────────────────────────────────
expectTypeOf(every((x: number): boolean => x > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
expectTypeOf(every((s: string): boolean => s.length > 0, ["a", "b"])).toEqualTypeOf<boolean>();

// @ts-expect-error predicate element type mismatches the list element type
every((s: string): boolean => s.length > 0, [1, 2, 3] as List<number>);
// @ts-expect-error result is boolean, not assignable to number
const n: number = every((x: number): boolean => x > 0, [1, 2, 3]);

// ── two lists (zip) — gepa dominates? shape ──────────────────────────────────
declare const gte: (a: number, b: number) => boolean;
declare const scoresA: List<number>;
declare const scoresB: List<number>;
expectTypeOf(every(gte, scoresA, scoresB)).toEqualTypeOf<boolean>();
expectTypeOf(every((a: number, b: number): boolean => a >= b, scoresA, scoresB)).toEqualTypeOf<boolean>();

// @ts-expect-error two-list pred first param mismatches first list
every((s: string, n: number): boolean => true, scoresA, scoresB);
// @ts-expect-error second sequence is not a list
every(gte, scoresA, 99);
