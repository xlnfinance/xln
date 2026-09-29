// polyglot-contract-precision.test.ts — RUNTIME proof that the type-precision fixes to
// scheme/polyglot's native Contracts (env/polyglot/polyglot.ts) actually tighten `def.out` for the
// REAL exported symbols (not a synthetic mirror — see the sibling `polyglot.test-d.ts` for
// the type-level mechanism proofs, which must stay synthetic because `NativeSymbolDef.in`/
// `.out` erase to plain `z.ZodTypeAny` on any real export — same reasoning as
// `numeric.test-d.ts` / `numeric-contract-precision.test.ts`, this pair's own precedent).
//
// `@?` (hasMember) / `@keys` (memberKeys) / `dict` all declared `output: [z.unknown()]`,
// silently accepting ANY encoded value. This file checks: does `def.out` now REJECT a
// wrongly-shaped value it used to silently ACCEPT? That rejection is the fix's entire
// externally visible effect — native ops never run this validation during evaluation (see
// `_bake.ts`'s `bakeNative` doc comment: "NO runtime validation, NO codec — the impl works
// on scheme values directly"), so this is a HARVEST/type-surface proof, not a behavior
// change. The behavioral byte-identical proof is the pre-existing `polyglot.test.ts` suite,
// run unmodified before/after.
//
// ★NOT COVERED HERE: `@` (readMember)'s fix (`z.unknown()` → `z.schemeValue`) has NO
// runtime-observable counterpart. `z.schemeValue` is `z.custom<SchemeValue>()` with NO refinement
// predicate (see scheme-zod.ts's own doc comment on `value`), so it accepts anything at
// runtime — byte-identical to `z.unknown()`. That fix is a pure static-inference
// improvement; it cannot RED/GREEN via `.safeParse`/`.safeEncode` no matter the schema
// choice, since both schemas validate identically. Its only proof surface is the
// type-level mechanism proof in `polyglot.test-d.ts` (which is itself unfalsifiable against
// THIS file's real export, for the erasure reason above) — see the audit report for the
// honest accounting of what is and isn't mechanically provable for that one symbol.

import { describe, expect, it } from "vitest";
import dedent from "dedent";
import polyglot from "../../polyglot/polyglot.js";
import type { AEntity } from "../../../common/symbols/_bake.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import { ADict } from "../../../values/primitives/ADict.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// `symbols` is a builder (activation) => Record<string, AEntity> for this capability —
// call it with an empty (unused) activation shape; polyglot's symbols builder never reads
// `this.configuration`/`this.resources` (no config/resources declared on this capability).
// `spec.symbols` IS the record. Each entry is a minted A-value — `harvestContracts`
// pulls the AEntity contract off each one.
const symbols = harvestContracts(polyglot.spec.symbols ?? {});

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`polyglot pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`polyglot pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

function defineDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`polyglot pack: no symbol named ${name}`);
  if (def.kind !== "define") throw new Error(`polyglot pack: ${name} is not a define def (got ${def.kind})`);
  return def;
}

describe("scheme/polyglot Contract precision — the real exported ops reject wrongly-typed output (were z.unknown(), now precise)", () => {
  it("@? (hasMember): output is now the z.boolean codec — accepts a real boolean, rejects a non-boolean", () => {
    const def = nativeDef("@?");
    expect(def.out.safeEncode([true]).success).toBe(true);
    expect(def.out.safeEncode([false]).success).toBe(true);
    expect(def.out.safeEncode(["not a boolean"]).success).toBe(false);
    expect(def.out.safeEncode([42]).success).toBe(false);
  });

  it("@keys (memberKeys): output is now z.array(z.string) — accepts a string array, rejects a non-string element", () => {
    const def = nativeDef("@keys");
    expect(def.out.safeEncode([["a", "b", "c"]]).success).toBe(true);
    expect(def.out.safeEncode([[]]).success).toBe(true);
    expect(def.out.safeEncode([[1, 2]]).success).toBe(false);
    expect(def.out.safeEncode([["a", 2]]).success).toBe(false);
  });

  it("dict: output is an ADict-accepting schema (native-dict-provenance.md) — accepts an ADict, rejects a plain object", () => {
    const def = nativeDef("dict");
    // v2 `dict()` is the open-record codec whose SCHEME face is `ADict | dict-shaped-AJSObject`.
    // A raw ADict decodes (its `arrival/toJS` record); a plain JS object / array / scalar is
    // neither an ADict nor an AJSObject, so `.safeParse` rejects it — the precision this asserts.
    expect(def.out.safeParse([new ADict([])]).success).toBe(true);
    expect(def.out.safeParse([{ a: 1, b: "two" }]).success).toBe(false);
    expect(def.out.safeParse([{}]).success).toBe(false);
    expect(def.out.safeParse([["not", "a", "dict"]]).success).toBe(false);
    expect(def.out.safeParse(["just a string"]).success).toBe(false);
    expect(def.out.safeParse([42]).success).toBe(false);
  });
});

describe("scheme/polyglot Contract.type overrides — compose/pipe composition ladders (z.lambda harvest is shapeless)", () => {
  it("compose: RTL seed-last ladder depth 0–6", () => {
    expect(norm(signatureOf(defineDef("compose")))).toBe(
      norm(dedent`
        {
          (): <T>(x: T) => T;
          <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
          <A extends unknown[], B, R>(f: (b: B) => R, g: (...args: A) => B): (...args: A) => R;
          <A extends unknown[], B, C, R>(f: (c: C) => R, g: (b: B) => C, h: (...args: A) => B): (...args: A) => R;
          <A extends unknown[], B, C, D, R>(f: (d: D) => R, g: (c: C) => D, h: (b: B) => C, i: (...args: A) => B): (...args: A) => R;
          <A extends unknown[], B, C, D, E, R>(f: (e: E) => R, g: (d: D) => E, h: (c: C) => D, i: (b: B) => C, j: (...args: A) => B): (...args: A) => R;
          <A extends unknown[], B, C, D, E, F, R>(f: (f: F) => R, g: (e: E) => F, h: (d: D) => E, i: (c: C) => D, j: (b: B) => C, k: (...args: A) => B): (...args: A) => R;
        }
      `),
    );
  });

  it("pipe: LTR seed-first ladder depth 0–6", () => {
    expect(norm(signatureOf(defineDef("pipe")))).toBe(
      norm(dedent`
        {
          (): <T>(x: T) => T;
          <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
          <A extends unknown[], B, R>(f: (...args: A) => B, g: (b: B) => R): (...args: A) => R;
          <A extends unknown[], B, C, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => R): (...args: A) => R;
          <A extends unknown[], B, C, D, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => R): (...args: A) => R;
          <A extends unknown[], B, C, D, E, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => E, j: (e: E) => R): (...args: A) => R;
          <A extends unknown[], B, C, D, E, F, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => E, j: (e: E) => F, k: (f: F) => R): (...args: A) => R;
        }
      `),
    );
  });

  // flow is a CONSTANT define (eq? pipe) — no Contract.type channel; harvest stays z.lambda.
  it("flow: constant alias — no type override (callable false)", () => {
    const def = defineDef("flow");
    expect(def.callable).toBe(false);
    expect(def.type).toBeUndefined();
  });
});
