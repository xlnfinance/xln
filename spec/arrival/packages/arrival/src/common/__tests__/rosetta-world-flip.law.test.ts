/**
 * LAW — the rosetta RETURN is a JS-world value; an AValue there is an ILLEGAL
 * WORLD FLIP (V's ruling, 2026-08-13, hermeticity audit follow-up).
 *
 * The scheme<>js membrane flips worlds exactly once per direction. A rosetta
 * impl lives on the JS side: its return crosses BACK through the membrane
 * (encode → jsToScheme), which owns boxing, provenance stamping, and
 * attestation. An impl returning an already-boxed AValue — bare or nested
 * inside a plain array/object — smuggles a scheme-world value through the JS
 * half; jsToScheme's owned-artifact phase would pass it through silently,
 * skipping the mint. The membrane crashes explicitly instead (WorldFlipError):
 * return the raw JS value and let the membrane box it, or use symbol.native
 * for a verb that works over scheme values.
 */
import { describe, it, expect } from "vitest";
import * as z from "../scheme-zod/index.js";
import { symbol } from "../../symbol/index.js";
import { makeCallCtx } from "../../run/CallCtx.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AString } from "../../values/primitives/AString.js";
import { tf } from "../../values/tagless-final.js";
import { WorldFlipError } from "../../errors.js";
import type { SchemeValue } from "../../values/types.js";
import type { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";

function invoke(verb: ARosettaProcedure, ...args: SchemeValue[]): unknown {
  return verb[tf("apply")](args, makeCallCtx(CONSTANT_CTX, undefined));
}

describe("rosetta world-flip door (audit B2b)", () => {
  it("P-WORLD-FLIP — raw JS through the z.dynamic escape slot boxes at the membrane", async () => {
    const verb = symbol.rosetta`wf-ok: `({ input: [z.string], output: [z.dynamic] }, (s) => ({ tag: s, n: 1 }));
    await expect(invoke(verb, new AString("a"))).resolves.toBeDefined();
  });

  it("N-WORLD-FLIP-BARE — impl returning a bare AValue crashes", async () => {
    const verb = symbol.rosetta`wf-bare: `(
      { input: [z.string], output: [z.dynamic] },
      ((s: string) => new AString(s)) as never,
    );
    await expect(invoke(verb, new AString("a"))).rejects.toThrow(WorldFlipError);
  });

  it("N-WORLD-FLIP-NESTED — an AValue nested in a plain array / object crashes", async () => {
    const inArray = symbol.rosetta`wf-arr: `({ input: [z.string], output: [z.dynamic] }, ((s: string) => [
      1,
      new AString(s),
    ]) as never);
    await expect(invoke(inArray, new AString("a"))).rejects.toThrow(WorldFlipError);

    const inObject = symbol.rosetta`wf-obj: `({ input: [z.string], output: [z.dynamic] }, ((s: string) => ({
      v: new AString(s),
    })) as never);
    await expect(invoke(inObject, new AString("a"))).rejects.toThrow(WorldFlipError);
  });

  it("N-WORLD-FLIP-CODED — a coded output slot doors with the SAME teaching error, before z.encode", async () => {
    const verb = symbol.rosetta`wf-coded: `(
      { input: [z.string], output: [z.string] },
      ((s: string) => new AString(s)) as never,
    );
    await expect(invoke(verb, new AString("a"))).rejects.toThrow(WorldFlipError);
  });

  it("P-WORLD-FLIP-PASSTHROUGH — a dynamic INPUT may hand the impl a boxed value; returning raw JS derived from it is the sanctioned shape", async () => {
    // The overridable pattern post-fix: dynamic in (boxed operand), plain JS out.
    const verb = symbol.rosetta`wf-derive: `({ input: [z.dynamic], output: [z.dynamic] }, (v) =>
      v instanceof AString ? v["arrival/toJS"]() : String(v),
    );
    await expect(invoke(verb, new AString("a"))).resolves.toBeDefined();
  });
});
