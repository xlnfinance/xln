// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `list` — fixed-arity → tuple; homogeneous rest → List<T>.
// // ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// Homogeneous 3-arg: fixed overload wins → tuple (fine for apply).
expectTypeOf(list(1, 2, 3)).toEqualTypeOf<[number, number, number]>();
// Empty → []
expectTypeOf(list()).toEqualTypeOf<[]>();
// Singleton is List (pool/seed), not a 1-tuple.
expectTypeOf(list(1)).toEqualTypeOf<List<number>>();
// Heterogeneous fixed-arity is intentional (apply product / zip pairs).
expectTypeOf(list(1, "a")).toEqualTypeOf<[number, string]>();
expectTypeOf(list(1, "a", true, null, 5)).toEqualTypeOf<[number, string, boolean, null, number]>();

// @ts-expect-error assigning a fixed product to a scalar bites
const n: number = list(1, 2, 3);
