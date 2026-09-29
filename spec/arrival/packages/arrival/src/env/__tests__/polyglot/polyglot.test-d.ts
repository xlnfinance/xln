// polyglot.test-d.ts — TYPE-LEVEL proofs for the scheme/polyglot Contract precision fix
// (env/polyglot/polyglot.ts): `@` / `@?` / `@keys` / `dict` all declared `output: [z.custom<unknown>()]`,
// discarding each op's own precise return type (`readMember` returns `SchemeValue`,
// `hasMember` returns `boolean`, `memberKeys` returns `string[]`, `dict`'s impl always
// builds a `Record<string, unknown>`). This file proves the FIXED contracts' decoded
// return types are precise, mirroring the established convention exactly (see
// `symbol.test-d.ts`'s "apply's own declared shape" note and `numeric.test-d.ts`'s header):
// `NativeSymbolDef.in`/`.out` erase to plain `z.ZodTypeAny` on any real EXPORTED capability,
// so each proof below is a SYNTHETIC contract mirroring polyglot's real declared shape
// (built from the SAME `scheme-zod.ts` schemas polyglot.ts now uses), not a probe of the
// erased runtime export. The runtime-observable half of this fix (does `def.out` now
// REJECT what it used to silently accept) lives in the sibling
// `polyglot-contract-precision.test.ts`.
//
// ★HONEST ACCOUNTING (see the audit report): `@`'s fix (`z.custom<unknown>()` → `z.schemeValue`) has NO
// mechanical red/green of ANY kind — `z.schemeValue` is `z.custom<SchemeValue>()` with no
// refinement, runtime-identical to `z.custom<unknown>()` (scheme-zod.ts's own doc comment), and
// `readMember`'s real impl was ALREADY typed `SchemeValue`-returning, so tightening the
// annotation causes no compile transition either. The proof below for `@` is a pure
// mechanism/documentation proof (the shape decodes correctly), not a RED-before-fix probe —
// nothing in this repo can distinguish the old and new state for that one symbol.

import { describe, expectTypeOf, test } from "vitest";
import * as z from "../../../common/scheme-zod/index.js";
import { symbol } from "../../../symbol/index.js";
import { type DecodedReturn } from "../../../common/symbols/_bake.js";
import type { SchemeValue } from "../../../values/types.js";

describe("scheme/polyglot Contract precision — representative fixes decode precisely", () => {
  test("@ (readMember): out z.schemeValue — decodes to SchemeValue, not unknown (matches readMember's own (obj, key) => SchemeValue)", () => {
    expectTypeOf<DecodedReturn<[typeof z.schemeValue]>>().toEqualTypeOf<SchemeValue>();
  });

  test("@? (hasMember): out z.boolean — decodes to boolean, not unknown (matches hasMember's own (obj, key) => boolean)", () => {
    expectTypeOf<DecodedReturn<[typeof z.boolean]>>().toEqualTypeOf<boolean>();
  });

  test("@keys (memberKeys): out z.array(z.string) — decodes to string[], not unknown (matches memberKeys's own (obj) => string[])", () => {
    type KeysOutput = ReturnType<typeof z.array<typeof z.string>>;
    expectTypeOf<DecodedReturn<[KeysOutput]>>().toEqualTypeOf<string[]>();
  });

  test("dict: out z.record(z.string, z.custom<unknown>()) — decodes to Record<string, unknown>, not unknown", () => {
    type DictOutput = ReturnType<typeof z.record<typeof z.string, z.ZodCustom<unknown>>>;
    expectTypeOf<DecodedReturn<[DictOutput]>>().toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("scheme/polyglot Contract precision — wrong-typed impls must NOT compile (negative proofs)", () => {
  // Guarded by a `false` const so the constructors never run — these are type-only proofs,
  // exactly mirroring symbol.test-d.ts's own established convention.
  const RUN = false as boolean;

  test("@?-shaped: a non-boolean return must NOT compile against z.boolean output", () => {
    if (RUN) {
      symbol.native`hasmember-proof: proof`(
        { input: [z.custom<unknown>(), z.custom<unknown>()], output: [z.boolean] },
        // @ts-expect-error — must return boolean, not a bare number
        (obj: unknown, key: unknown): number => 42,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("@keys-shaped: a non-string-array return must NOT compile against z.array(z.string) output", () => {
    if (RUN) {
      symbol.native`memberkeys-proof: proof`(
        { input: [z.custom<unknown>()], output: [z.array(z.string)] },
        // @ts-expect-error — must return string[], not number[]
        (obj: unknown): number[] => [1, 2, 3],
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("dict-shaped: an array return must NOT compile against the record output", () => {
    if (RUN) {
      symbol.native`dict-proof: proof`(
        { input: z.array(z.custom<unknown>()), output: [z.record(z.string, z.custom<unknown>())] },
        // @ts-expect-error — must return Record<string, unknown>, not an array
        (...args: unknown[]): unknown[] => args,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });

  test("@-shaped (documentation only — see the honest accounting above): a non-SchemeValue return must NOT compile against z.schemeValue output", () => {
    if (RUN) {
      symbol.native`readmember-proof: proof`(
        { input: [z.custom<unknown>(), z.custom<unknown>()], output: [z.schemeValue] },
        // @ts-expect-error — must return SchemeValue, not a bare number
        (obj: unknown, key: unknown): number => 42,
      );
    }
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
