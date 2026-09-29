// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the combinators family (combinators.d.ts) — expect-type
// assertions over the ambient global functions. Only the LIVE members are covered:
// `always`, `clone`, `repr`, `when`, `unless` (see the leaf header for what
// was cut and why).
// Base vocab (`List`/`number`/`string`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// always returns a thunk of the input type — the THUNK CALL is the value
const alwaysThunk = always("x");
expectTypeOf(alwaysThunk()).toExtend<string>();
expectTypeOf(alwaysThunk()).not.toBeAny();

// clone preserves element type (exact brand)
expectTypeOf(clone([1, 2] as const as List<number>)).toEqualTypeOf<List<number>>();

// repr produces a string (exact brand)
expectTypeOf(repr(42 as unknown)).toEqualTypeOf<string>();

// when / unless return the last body value or nil → T | null
expectTypeOf(when(true, 1, 2)).toExtend<number | null>();
expectTypeOf(when(true, 1, 2)).not.toBeAny();
expectTypeOf(unless(false, "a")).toExtend<string | null>();
expectTypeOf(unless(false, "a")).not.toBeAny();

// @ts-expect-error always returns a thunk, not the bare value
const always_s: string = always("x");
