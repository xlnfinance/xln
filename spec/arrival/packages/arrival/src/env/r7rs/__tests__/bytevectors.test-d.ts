// bytevectors.test-d.ts — TYPE-LEVEL proofs for the scheme/bytevectors Contract precision fix.
//
// `bytevector` and `bytevector-append` (env/r7rs/bytevectors.ts) declared a wholly-variadic
// `input: z.array(z.custom<unknown>())` — every argument decoded as a flat `unknown[]`, discarding the
// op's own homogeneous element domain (a byte for `bytevector`; a bytevector for
// `bytevector-append`). Unlike `for-each`/`string-map` (a DISTINCT callable head + a
// differently-typed rest tail, migrated via `inputRest` — see symbol.test-d.ts's 2026-07-05
// audit section), these two ops have NO head: every argument is the SAME kind, so the fix is a
// single bare `z.array(<precise-element-schema>)`, not a head/rest split.
//
// `NativeSymbolDef.in`/`.out` erase to plain `z.ZodTypeAny` on any REAL exported capability (see
// symbol.test-d.ts's "apply's own declared shape" note), so — mirroring that established
// convention exactly — each proof below is a SYNTHETIC contract mirroring the op's real declared
// shape, built from the SAME `scheme-zod.ts` schemas the fix uses. Both `z.schemeNumber` and
// `z.bytevector` are stable exports, so this file compiles and passes both BEFORE and AFTER the
// source fix — it is a
// mechanism/regression proof (does `DecodedArgs` compute the right type for the NEW schema?), not
// a compile-gated RED. The genuine RED-before/GREEN-after lives in the sibling runtime file
// `bytevectors-contract-precision.test.ts` (a schema's precision is only externally observable
// via `.safeParse`, since native ops run no validation during evaluation).

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod/index.js";
import { symbol } from "../../../symbol/index.js";
import { type DecodedArgs } from "../../../common/symbols/_bake.js";
import type { ANumeric } from "../../../values/numbers.js";
import type { ABytevector } from "../../../values/primitives/ABytevector.js";

describe("bytevector Contract precision — wholly-variadic homogeneous element domains", () => {
  test("NEW bytevector shape: z.array(z.schemeNumber) decodes to ANumeric[] — each arg IS a scheme number, not unknown", () => {
    // Mirrors bytevector's real migrated contract: { input: z.array(z.schemeNumber), output: [z.bytevector] }.
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.schemeNumber>>, "scheme">>().toEqualTypeOf<
      ANumeric[]
    >();
  });

  test("NEW bytevector-append shape: z.array(z.bytevector) decodes to ABytevector[] on the scheme face — each arg IS a bytevector, not unknown", () => {
    // Mirrors bytevector-append's real migrated contract: { input: z.array(z.bytevector), output: [z.bytevector] }.
    // v2 bytevector is a codec: SCHEME face = ABytevector (the native op's face), JS face = Uint8Array.
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.bytevector>>, "scheme">>().toEqualTypeOf<
      ABytevector[]
    >();
  });
});

describe("bytevector Contract precision — negative proofs (wrong-typed impl must NOT compile)", () => {
  // Guarded by a `false` const so the constructors never run — these are type-only proofs,
  // mirroring symbol.test-d.ts's established `RUN`-guard idiom exactly.
  const RUN = false as boolean;

  test("bytevector: a wrong-typed rest element must NOT compile", () => {
    if (RUN) {
      symbol.native`bv: proof`(
        { input: z.array(z.schemeNumber), output: [z.bytevector] },
        // @ts-expect-error — elements decode via z.schemeNumber (ANumeric), annotating them string is wrong
        (...bytes: string[]): ABytevector => bytes as unknown as ABytevector,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("bytevector-append: a wrong-typed rest element must NOT compile", () => {
    if (RUN) {
      symbol.native`bva: proof`(
        { input: z.array(z.bytevector), output: [z.bytevector] },
        // @ts-expect-error — elements decode via z.bytevector (ABytevector), annotating them number is wrong
        (...bvs: number[]): ABytevector => bvs as unknown as ABytevector,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
