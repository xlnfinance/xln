// Bite cases for `some` — unary and multi-list (index-zip) overloads.
import { expectTypeOf } from "vitest";

// ── unary ────────────────────────────────────────────────────────────────────
expectTypeOf(some((x: number): boolean => x > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
expectTypeOf(some((s: string): boolean => s.length > 0, ["a", "b"])).toEqualTypeOf<boolean>();

// @ts-expect-error predicate param mismatches list element type
some((s: string): boolean => s.length > 0, [1, 2, 3]);
// @ts-expect-error second arg is not a list
some((x: number): boolean => x > 0, 123);
// @ts-expect-error result is boolean, not number
const n: number = some((x: number): boolean => x > 0, [1, 2, 3]);

// ── two lists (zip) — gepa dominates? shape ──────────────────────────────────
declare const gt: (a: number, b: number) => boolean;
declare const scoresA: List<number>;
declare const scoresB: List<number>;
expectTypeOf(some(gt, scoresA, scoresB)).toEqualTypeOf<boolean>();
expectTypeOf(some((a: number, b: number): boolean => a > b, scoresA, scoresB)).toEqualTypeOf<boolean>();

// @ts-expect-error two-list pred second param mismatches second list
some((a: number, s: string): boolean => true, scoresA, scoresB);
// @ts-expect-error second sequence is not a list
some(gt, scoresA, 99);
