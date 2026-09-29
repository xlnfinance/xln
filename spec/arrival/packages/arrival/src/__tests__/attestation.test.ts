// Attestation core-walk suite (design: arrival-manifold/docs/attestation-design.md §1, return-walk stamp site). The registry (values/attestation.ts) is a
// WeakSet keyed by box identity; the bakeRosetta return walk deep-attests SOURCE
// rosetta returns (spine + leaves), the membrane wrappers inherit at the pluck
// site, and computation drops attestation for free (fresh boxes). The manifold's
// boundary/flow behavior is covered in arrival-manifold's attestation-flows suite;
// THIS suite pins the core mechanics those flows stand on.

import { describe, expect, it } from "vitest";

import * as z from "../common/scheme-zod/index.js";
import { symbol } from "../symbol/index.js";
import { attest, attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js";
import { exec, execState } from "../eval/generator-exec.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { AJSArray } from "../membrane/AJSArray.js";
import { AJSObject } from "../membrane/AJSObject.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { APair } from "../values/primitives/APair.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AVector } from "../values/primitives/AVector.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { tf } from "../values/tagless-final.js";
import { AListAlike } from "../values/types.js";
import { jsToScheme } from "../membrane/rosetta.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { testCallCtx } from "../run/CallCtx.js";

/** A SOURCE rosetta (default — not pure) returning a fixed JS value; its apply term
 *  called direct-JS (no evaluator ctx) exercises the bake step-4 walk.
 *  The impl returns raw JS; the membrane boxes it and `attestDeep`s. An AValue
 *  in the impl return is a WorldFlipError. */
const source = (impl: () => unknown) =>
  symbol.rosetta`t: test source`({ input: [], output: [z.dynamic] }, () => impl());

function fire(proc: { ["arrival/tagless-final/apply"](args: any[], callCtx: any): any }, callCtx: any, ...args: any[]) {
  return proc["arrival/tagless-final/apply"](args, callCtx);
}

describe("attestation registry (attest / isAttested / freshIfSingleton)", () => {
  it("refuses the exempt singletons: nil, #void, interned symbols, #t/#f flyweights", async () => {
    expect(isAttested(attest(nil))).toBe(false);
    expect(isAttested(attest(theVoid))).toBe(false);
    expect(isAttested(attest(schemeTrue))).toBe(false);
    expect(isAttested(attest(schemeFalse))).toBe(false);
    // execState (COMPLEX tier): asserts box discipline directly (RULINGS.md R1).
    const [kw] = (await execState("(quote some-symbol)")).values;
    expect(kw).toBeInstanceOf(ASymbol);
    expect(isAttested(attest(kw))).toBe(false);
    expect(isAttested(attest("raw string"))).toBe(false);
    expect(isAttested(attest(undefined))).toBe(false);
  });

  it("freshIfSingleton clones ONLY the #t/#f flyweights; the clone attests, the singleton never does", async () => {
    const fresh = freshIfSingleton(schemeTrue);
    expect(fresh).not.toBe(schemeTrue);
    expect(isAttested(attest(fresh))).toBe(true);
    expect(isAttested(schemeTrue)).toBe(false);
    const [num] = await exec("42");
    expect(freshIfSingleton(num!)).toBe(num);
  });
});

describe("bakeRosetta return walk (stamp site 1)", () => {
  it("attests a scalar return; a boolean return is a fresh attested clone, never the flyweight", async () => {
    expect(
      isAttested(
        await fire(
          source(() => 42),
          testCallCtx(),
        ),
      ),
    ).toBe(true);
    expect(
      isAttested(
        await fire(
          source(() => "hi"),
          testCallCtx(),
        ),
      ),
    ).toBe(true);
    const bool = await fire(
      source(() => true),
      testCallCtx(),
    );
    expect(isAttested(bool)).toBe(true);
    expect(bool).not.toBe(schemeTrue);
    expect(isAttested(schemeTrue)).toBe(false); // no program-wide leak
  });

  it("a PURE rosetta's return is NOT machine-attested (a transform, not a source)", async () => {
    const pureDef = symbol.rosetta`p: pure transform`({ input: [], output: [z.number], provenance: "pipe" }, () => 42);
    expect(isAttested(await fire(pureDef, testCallCtx()))).toBe(false);
  });

  it("attests a dict return's wrapper; entries inherit through get, cache-stable", async () => {
    const def = source(() => ({ a: 1, nested: { x: 2 }, tags: [7, 8] }));
    const out = (await fire(def, testCallCtx())) as AJSObject;
    expect(out).toBeInstanceOf(AJSObject);
    expect(isAttested(out)).toBe(true);

    const a = out.get("a");
    expect(isAttested(a)).toBe(true);
    expect(out.get("a")).toBe(a);
    expect(isAttested(out.get("a"))).toBe(true);

    const nested = out.get("nested");
    expect(nested).toBeInstanceOf(AJSObject);
    expect(isAttested(nested)).toBe(true);
    expect(isAttested((nested as AJSObject).get("x"))).toBe(true);

    const tags = out.get("tags");
    expect(tags).toBeInstanceOf(AJSArray);
    expect(isAttested(tags)).toBe(true);
    expect(isAttested((tags as AJSArray)[tf("vector-ref")](0))).toBe(true);
  });

  it("a missing key plucks the SHARED nil — never attested", async () => {
    const def = source(() => ({ a: 1 }));
    const out = (await fire(def, testCallCtx())) as AJSObject;
    const missing = out.get("missing");
    expect(missing).toBeInstanceOf(ANil);
    expect(isAttested(missing)).toBe(false);
  });

  it("AJSArray materialization inherits: every materialized element box is attested", async () => {
    const def = source(() => [1, 2, 3]);
    const out = (await fire(def, testCallCtx())) as AJSArray;
    expect(out).toBeInstanceOf(AJSArray);
    expect(isAttested(out)).toBe(true);
    for (const el of out.__vector__) expect(isAttested(el)).toBe(true);
  });

  it("attests a pair spine + leaves (car/cdr on a source return are attested STORED boxes)", async () => {
    // World-flip rebaseline: a rosetta can no longer echo a boxed pair through
    // z.dynamic — the impl returns RAW JS and a coded slot (z.list) has the
    // membrane construct the pair spine, which the return walk then deep-attests.
    const listSource = symbol.rosetta`t-list: pair-spine source`({ input: [], output: [z.list(z.number)] }, () => [
      1, 2, 3,
    ]);
    const out = (await fire(listSource, testCallCtx())) as APair<any, any>;
    expect(out).toBeInstanceOf(APair);
    expect(isAttested(out)).toBe(true);
    expect(isAttested(out.car)).toBe(true);
    expect(isAttested(out.cdr)).toBe(true);
    expect(isAttested(out.cdr.car)).toBe(true);
  });

  it("attests a vector's stored elements", async () => {
    const vecSource = symbol.rosetta`t-vec: vector source`({ input: [], output: [z.vector(z.number)] }, () => [1, 2]);
    const out = (await fire(vecSource, testCallCtx())) as AVector;
    expect(out).toBeInstanceOf(AVector);
    expect(isAttested(out)).toBe(true);
    for (const el of out.__vector__) expect(isAttested(el)).toBe(true);
  });

  it("an unrelated freshly-evaluated value is NOT attested (computation/literals stay bare)", async () => {
    const [computed] = await exec("(+ 1 2)");
    expect(isAttested(computed)).toBe(false);
    const [literal] = await exec("41");
    expect(isAttested(literal)).toBe(false);
  });
});

describe("attestDeep", () => {
  it("walks a mixed spine and skips the exempt singletons", async () => {
    const [pair] = (await execState("'(1 #(2 3))")).values;
    attestDeep(pair);
    const p = pair as APair<any, APair<AVector, any>>;
    expect(isAttested(p)).toBe(true);
    expect(isAttested(p.car)).toBe(true);
    const inner = p.cdr.car as AVector;
    expect(isAttested(inner)).toBe(true);
    for (const el of inner.__vector__) expect(isAttested(el)).toBe(true);
    // the shared nil list-terminator never enters the registry
    expect(isAttested(nil)).toBe(false);
  });
});
