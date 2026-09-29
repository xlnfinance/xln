// vectors.test-d.ts — TYPE-LEVEL proofs for the scheme/vectors Contract-precision audit.
//
// vectors.ts had six declarations whose Contract was looser than their own impl bodies (and
// this file's OWN sibling declarations) already assume:
//   - `vector`'s elements were `z.array(z.custom<unknown>())` where the file's own `make-vector`
//     already uses the precise `z.schemeValue` for its fill slot (the typed z.custom<unknown>() replacement —
//     same runtime acceptance, precise STATIC output `SchemeValue`).
//   - `vector-append`'s elements and `vector-ref`'s vec arg were bare `z.custom<unknown>()`/
//     `z.array(z.custom<unknown>())` where every OTHER accessor in this file (vector-length/
//     vector-copy/vector->string/list->vector/…) already uses `z.vector`.
//   - `vector-ref`/`vector->list`'s RETURN was `z.custom<unknown>()` where `z.schemeValue` is the precise
//     identity schema for "any scheme value, representation-blind by design".
//   - `vector-map`/`vector-for-each` bundled their variadic vectors into ONE combined
//     `z.tuple([head], z.custom<unknown>())` `input` rather than splitting the fixed proc head from an
//     `inputRest: z.vector` tail — the mechanism `apply` (lists.ts) and the 2026-07-05
//     for-each/string-map/string-for-each migration already use (see symbol.test-d.ts's own
//     "2026-07-05 audit" section, which this mirrors).
//
// `NativeSymbolDef.in`/`.out` erase to plain `z.ZodTypeAny` on any REAL exported capability
// (the established convention — see symbol.test-d.ts's "apply's own declared shape" note and
// numeric.test-d.ts's identical framing), so every proof below is a SYNTHETIC contract
// mirroring vectors.ts's own real declared shape (built from the SAME scheme-zod.ts schemas
// the pack uses), not a probe of the erased runtime export.
//
// The runtime-observable half of this fix (does the REAL exported op's schema actually reject
// a wrongly-shaped value?) lives in the sibling `vectors-contract-precision.test.ts` — and ONLY
// for the z.vector-backed fixes. `z.schemeValue` (`z.custom<SchemeValue>()`, no predicate) accepts
// anything at runtime BYTE-IDENTICAL to the `z.custom<unknown>()` it replaces (calibrated empirically
// against the pinned zod 4.3.6 — see scheme-zod.ts's own doc comment on `value`), so `vector`'s
// elements and `vector-ref`/`vector->list`'s returns are STATIC-ONLY precision gains — provable
// only here, at the type level.
import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod/index.js";
import { symbol } from "../../../symbol/index.js";
import { type DecodedArgs, type DecodedArgsWithRest, type DecodedReturn } from "../../../common/symbols/_bake.js";
import type { AVector } from "../../../values/primitives/AVector.js";
import type { AExact } from "../../../values/primitives/AExact.js";
import type { AInexact } from "../../../values/primitives/AInexact.js";
import type { AJSArray } from "../../../membrane/AJSArray.js";
import type { SchemeValue } from "../../../values/types.js";

// v2 vector is the AVector|AJSArray union codec — SCHEME face = AVector | AJSArray, JS face = SchemeValue[].
const svec = z.vector(z.schemeValue);

describe("scheme/vectors Contract precision — element/return precision (z.custom<unknown>() → z.schemeValue/z.vector)", () => {
  test("vector: NEW z.array(z.schemeValue) decodes SchemeValue[], matching the impl's own (...objs: SchemeValue[]) body — and make-vector's own fill-slot convention", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.schemeValue>>>>().toEqualTypeOf<SchemeValue[]>();
  });

  test("vector-append: NEW z.array(z.vector(z.schemeValue)) decodes (AVector | AJSArray)[] on the scheme face — matches every OTHER accessor's z.vector convention in this file", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof svec>>, "scheme">>().toEqualTypeOf<
      (AVector | AJSArray)[]
    >();
  });

  test("vector-ref: NEW input [z.vector(z.schemeValue), z.schemeNumber] decodes [AVector | AJSArray, AExact|AInexact], not [unknown, …]", () => {
    expectTypeOf<DecodedArgs<[typeof svec, typeof z.schemeNumber], "scheme">>().toEqualTypeOf<
      [AVector | AJSArray, AExact | AInexact]
    >();
  });

  test("vector-ref / vector->list: NEW output [z.schemeValue] collapses to a bare `SchemeValue` return — representation-blind by design, not unknown", () => {
    expectTypeOf<DecodedReturn<[typeof z.schemeValue]>>().toEqualTypeOf<SchemeValue>();
  });
});

describe("scheme/vectors Contract precision — negative proof", () => {
  test("vector-map/vector-for-each: a wrong-typed rest element must NOT compile", () => {
    const RUN = false as boolean;
    if (RUN) {
      symbol.native`vm: proof`(
        { input: [z.lambda], inputRest: z.vector(z.schemeValue), output: [z.vector(z.schemeValue)] },
        // @ts-expect-error — rest args decode via z.vector (AVector | AJSArray), annotating them string is wrong
        (proc: (...args: unknown[]) => SchemeValue, ...vectors: string[]): AVector => {
          void proc;
          void vectors;
          return vectors as unknown as AVector;
        },
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});

describe("scheme/vectors Contract precision — regression guard: the shared mechanism stays sound for a non-vector shape", () => {
  test("apply's own declared shape (lists.ts) is untouched by anything added here — same proof symbol.test-d.ts/numeric.test-d.ts already carry", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.schemeValue], typeof z.schemeValue>>().toEqualTypeOf<
      [SchemeValue, ...SchemeValue[]]
    >();
  });
});
