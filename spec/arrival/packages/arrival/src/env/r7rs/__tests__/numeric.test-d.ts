// numeric.test-d.ts — TYPE-LEVEL proofs for the numeric-pack Contract precision fix.
//
// `bind` (numeric.ts) used to degrade EVERY one of the pack's 81 ops' outer
// `symbol.native` Contract to `{ input: z.array(z.custom<unknown>()), output: [z.custom<unknown>()] }`,
// discarding the op's own precise `NumSpec` (`in`/`inRest`/`out` — the six `NCodec`s
// carved at the top of numeric.ts). This file proves the FIXED codec→zod bridge
// produces schemas whose DECODED types are precise, for one representative op per
// NumSpec shape found in the pack.
//
// `NativeSymbolDef.in`/`.out` erase to `z.ZodTypeAny` on any real EXPORTED capability
// (see `symbol.test-d.ts`'s "apply's own declared shape" note) — so, mirroring that
// established convention exactly, each proof below is a SYNTHETIC contract mirroring
// the op's real declared shape (built from the SAME `scheme-zod.ts` schemas the pack's
// codec bridge maps to), not a probe of the erased runtime export. The "did the fix
// actually land on the real 81 ops" proof — which NEEDS a runtime check, since the
// static erasure above makes it type-unobservable — lives in the sibling
// `numeric-contract-precision.test.ts`.
//
// Per docs/design-history/arrival-one-number-rework.md §2.3, the numeric pack's own
// NumSpecs have converged onto `z.schemeNumber` (the "scheme" face decodes to `ANumeric`,
// i.e. `AExact | AInexact`) for essentially every op below, INCLUDING quotient/abs/zero? —
// there is no surviving "AnyNum, plain number|bigint" shape in the live pack; the inline
// `z.union([z.number, z.bigint])` pairing this file used to mirror is gone along with the
// ops that used it. `z.bigint` itself still exists in scheme-zod.ts, but only as a KEPT
// (deliberately not deleted) historical compat export for consumers outside this sweep's scope
// (chars.ts/strings.ts/srfi-13.ts) — the numeric pack's own contracts no longer reference
// it at all, so it has no remaining "face" to prove here.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod/index.js";
import type { DecodedArgs, DecodedArgsWithRest, DecodedReturn } from "../../../common/symbols/_bake.js";
import type { ANumeric } from "../../../values/numbers.js";

describe("numeric Contract precision — representative NumSpec shapes decode precisely", () => {
  test("pure-variadic (+): in:[], inRest:SchemeNum, out:SchemeNum — args are ANumeric[], return ANumeric (matches addFn's own (...args: ANumeric[]) => ANumeric)", () => {
    expectTypeOf<DecodedArgsWithRest<[], typeof z.schemeNumber, "scheme">>().toEqualTypeOf<ANumeric[]>();
    expectTypeOf<DecodedReturn<[typeof z.schemeNumber], "scheme">>().toEqualTypeOf<ANumeric>();
  });

  test("fixed-head-plus-rest (-): in:[SchemeNum], inRest:SchemeNum, out:SchemeNum — matches subFn's (first: ANumeric, ...rest: ANumeric[]) => ANumeric", () => {
    expectTypeOf<DecodedArgsWithRest<[typeof z.schemeNumber], typeof z.schemeNumber, "scheme">>().toEqualTypeOf<
      [ANumeric, ...ANumeric[]]
    >();
  });

  test("fixed-2-arity (quotient): in:[SchemeNum,SchemeNum], out:SchemeNum — args/return are ANumeric, not bigint (matches quotientFn's (a: ANumeric, b: ANumeric) => ANumeric)", () => {
    expectTypeOf<DecodedArgs<[typeof z.schemeNumber, typeof z.schemeNumber], "scheme">>().toEqualTypeOf<
      [ANumeric, ANumeric]
    >();
    expectTypeOf<DecodedReturn<[typeof z.schemeNumber], "scheme">>().toEqualTypeOf<ANumeric>();
  });

  test("fixed-1-arity (abs): in:[SchemeNum], out:SchemeNum — ANumeric, NOT unknown (matches schemeAbs's (x: ANumeric) => ANumeric)", () => {
    expectTypeOf<DecodedArgs<[typeof z.schemeNumber], "scheme">>().toEqualTypeOf<[ANumeric]>();
    expectTypeOf<DecodedReturn<[typeof z.schemeNumber], "scheme">>().toEqualTypeOf<ANumeric>();
  });

  test("boolean-output predicate (zero?): in:[SchemeNum], out:Bool — args ANumeric, return boolean, not unknown (matches isZeroFn's (x: ANumeric) => boolean)", () => {
    expectTypeOf<DecodedArgs<[typeof z.schemeNumber], "scheme">>().toEqualTypeOf<[ANumeric]>();
    expectTypeOf<DecodedReturn<[typeof z.boolean]>>().toEqualTypeOf<boolean>();
  });

  // floor/ product (pair) is covered at runtime by numeric-contract-precision
  // (def.out.safeParse on APair) — z.pair scheme-face equals dance is flaky under
  // expectTypeOf (APair vs AListAlike); don't duplicate here.
});

describe("numeric Contract precision — regression guard: the shared mechanism stays sound for a non-numeric shape", () => {
  test("apply's own declared shape (lists.ts) is untouched by anything added here — same proof symbol.test-d.ts already carries", () => {
    // Mirrors symbol.test-d.ts's own "apply's own declared shape" test byte-for-byte — a
    // canary that the numeric-pack-local additions (CODEC_SCHEMA, contractFromSpec, the
    // z.schemeNumber-based NumSpecs above) cannot have perturbed the shared inputRest mechanism itself.
    expectTypeOf<DecodedArgsWithRest<[typeof z.schemeValue], typeof z.schemeValue>>().toEqualTypeOf<
      [import("../../../values/types.js").SchemeValue, ...import("../../../values/types.js").SchemeValue[]]
    >();
  });
});
