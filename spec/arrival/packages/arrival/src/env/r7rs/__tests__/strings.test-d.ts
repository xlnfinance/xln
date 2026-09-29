// strings.test-d.ts — TYPE-LEVEL proofs for the `scheme/strings` 2026-07-05 Contract
// precision audit (see the sibling strings-contract-precision.test.ts for the RUNTIME
// proof against the REAL exported ops — NativeSymbolDef.in/.out erase to plain
// z.ZodTypeAny on any real export, mirroring numeric.test-d.ts's/symbol.test-d.ts's own
// established note, so every proof here is a SYNTHETIC contract mirroring each op's real
// declared shape, built from the SAME scheme-zod.ts schemas the fix maps to).
//
// HONEST CAVEAT (unlike numeric.test-d.ts's z.numberOrBigint case): none of this round's
// fixes introduce a brand-new scheme-zod.ts export — z.schemeChar/z.schemeString/z.pair/
// z.nil/z.schemeValue all already exist, and the DecodedArgs/DecodedArgsWithRest/DecodedReturn
// mechanism is already proven correct (symbol.test-d.ts). So, exactly like the sibling
// symbol.test-d.ts "2026-07-05 audit" section for for-each/string-map/string-for-each/
// filter/typecheck, these OLD-vs-NEW pairs compile/pass regardless of strings.ts's fix
// state — they PIN the intended decoded shape as a compile-checked spec (and would catch
// a regression in the shared mechanism itself), but the genuine RED-before/GREEN-after
// gate for a "swap which existing schema is plugged into an existing contract" fix lives
// in the runtime file, which probes actual value acceptance via zod's own safeParse.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod/index.js";
import { symbol } from "../../../symbol/index.js";
import { type DecodedArgs, type DecodedReturn } from "../../../common/symbols/_bake.js";
import type { SchemeValue } from "../../../values/types.js";
import type { ACharacter } from "../../../values/primitives/ACharacter.js";
import type { AString } from "../../../values/primitives/AString.js";

describe("scheme/strings Contract precision — array-element tightening (string / comparisons / string-append)", () => {
  test("NEW `string` shape: z.array(z.schemeChar) decodes to ACharacter[], not unknown[]", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.char>>, "scheme">>().toEqualTypeOf<ACharacter[]>();
  });

  test("NEW comparison/string-append shape: z.array(z.schemeString) decodes to AString[], not unknown[]", () => {
    expectTypeOf<DecodedArgs<ReturnType<typeof z.array<typeof z.string>>, "scheme">>().toEqualTypeOf<AString[]>();
  });
});

describe("scheme/strings Contract precision — list-shaped slots (string->list output / list->string input)", () => {
  const listSchema = z.union([z.pair, z.nil]);

  test("NEW shape: [z.union([z.pair, z.nil])] decodes the OUTPUT to APair | null, not unknown (string->list) — nil's JS face is null, not ANil; AList is the scheme face", () => {
    expectTypeOf<DecodedReturn<[typeof listSchema]>>().toEqualTypeOf<[SchemeValue, SchemeValue] | null>();
  });

  test("NEW shape: [z.union([z.pair, z.nil])] decodes the INPUT to [APair | null], not [unknown] (list->string)", () => {
    expectTypeOf<DecodedArgs<[typeof listSchema]>>().toEqualTypeOf<[[SchemeValue, SchemeValue] | null]>();
  });
});

describe("scheme/strings Contract precision — regression guard: wrong-typed impls must NOT compile against the tightened shapes", () => {
  const RUN = false as boolean;

  test("string: a wrong-typed char rest element (raw string, not ACharacter) must NOT compile", () => {
    if (RUN) {
      symbol.native`s: proof`(
        { input: z.array(z.char), output: [z.string] },
        // @ts-expect-error — elements decode via z.schemeChar (ACharacter), annotating them string is wrong
        (...chars: string[]): AString => chars as unknown as AString,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("string->list: a wrong-typed return (bare string, not APair | ANil) must NOT compile", () => {
    if (RUN) {
      symbol.native`sl: proof`(
        { input: [z.string], output: [z.union([z.pair, z.nil])] },
        // @ts-expect-error — output decodes to APair | ANil, returning a string is wrong
        (str: AString): string => str.valueOf(),
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("list->string: a wrong-typed param (string, not APair | ANil) must NOT compile", () => {
    if (RUN) {
      symbol.native`ls: proof`(
        { input: [z.union([z.pair, z.nil])], output: [z.string] },
        // @ts-expect-error — arg decodes to APair | ANil, annotating it string is wrong
        (list: string): AString => list as unknown as AString,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
