/**
 * Provenance deep-stamping at the rosetta boundary (Option C).
 *
 * Pre-change: `jsToScheme` constructed a Pair-chain whose top-level container
 * received provenance via a separate `withProvenance` walk; the spine cons
 * cells + leaf primitives stayed empty. Spec §5.3 says car/cdr are
 * projections (element-only) — so `(car (infer …))` returned a SchemeString
 * carrying nothing, breaking the v0-gap provenance chain.
 *
 * Post-change: `jsToScheme(CONSTANT_CTX, raw, opts, provenance)` deep-stamps every
 * constructed AValue in a single pass. Plain JS objects wrap as
 * `SchemeJSObject`; their entries box lazily via `.get(key)` carrying the
 * wrapper's provenance, with a per-wrapper cache for identity stability.
 * `(@ obj :x)` and `(:x obj)` route through the same `.get`, so the cached
 * AValue makes `(eq? (@ obj :x) (@ obj :x))` return #t.
 */
import { describe, expect, it } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { EMPTY_PROVENANCE } from "../../values/primitives/AValue.js";
import { schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { AJSObject } from "../../membrane/AJSObject.js";
import { AJSArray } from "../../membrane/AJSArray.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { APair } from "../../values/primitives/APair.js";
import { jsToScheme } from "../../membrane/rosetta.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { execOverFrame as exec } from "../../eval/generator-exec.js";
import { ANil, nil } from "../../values/primitives/ANil.js";

const PROV = new Set<number>([42]);

describe("jsToScheme deep-stamps every constructed AValue", () => {
  it("array → borrowed AJSArray vector — container + each lazily-boxed leaf carry provenance", () => {
    const result = jsToScheme(CONSTANT_CTX, ["a", "b"], {}, PROV);
    // A JS array IS a vector → a borrowed AJSArray (parallel to a plain object → AJSObject below),
    // NOT a deep-stamped Pair-chain. The container carries the crossing provenance; elements box
    // LAZILY through vec(), which threads that provenance — so each materialized leaf carries [42].
    expect(result).toBeInstanceOf(AJSArray);
    expect([...(result as AJSArray).provenance]).toEqual([42]);
    const elems = (result as unknown as { __vector__: AString[] }).__vector__;
    expect(elems[0]).toBeInstanceOf(AString);
    expect([...elems[0].provenance]).toEqual([42]);
    expect(elems[1]).toBeInstanceOf(AString);
    expect([...elems[1].provenance]).toEqual([42]);
  });

  it("nested array → nested borrowed AJSArray; leaves carry provenance through the lazy borrow", () => {
    const result = jsToScheme(CONSTANT_CTX, [[1], [2, 3]], {}, PROV);
    expect(result).toBeInstanceOf(AJSArray);
    expect([...(result as AJSArray).provenance]).toEqual([42]);
    const inner = (result as unknown as { __vector__: AJSArray[] }).__vector__[0];
    expect(inner).toBeInstanceOf(AJSArray);
    expect([...inner.provenance]).toEqual([42]);
    const innerElems = (inner as unknown as { __vector__: AExact[] }).__vector__;
    expect(innerElems[0]).toBeInstanceOf(AExact);
    expect([...innerElems[0].provenance]).toEqual([42]);
  });

  it("plain object → SchemeJSObject with provenance; entries lazy-boxed", () => {
    const result = jsToScheme(CONSTANT_CTX, { name: "claude" }, {}, PROV);
    expect(result).toBeInstanceOf(AJSObject);
    expect([...(result as AJSObject).provenance]).toEqual([42]);
    // Entry surfaces through `.get` — boxed lazily with the wrapper's provenance.
    const name = (result as AJSObject).get("name");
    expect(name).toBeInstanceOf(AString);
    expect([...(name as AString).provenance]).toEqual([42]);
  });

  it("primitive string → SchemeString boxed via AValue.fromJs with provenance", () => {
    const result = jsToScheme(CONSTANT_CTX, "hello", {}, PROV);
    expect(result).toBeInstanceOf(AString);
    expect([...(result as AString).provenance]).toEqual([42]);
  });

  it("primitive number → SchemeExact (safe int) or SchemeInexact with provenance", () => {
    const intResult = jsToScheme(CONSTANT_CTX, 42, {}, PROV);
    expect(intResult).toBeInstanceOf(AExact);
    expect([...(intResult as AExact).provenance]).toEqual([42]);

    const floatResult = jsToScheme(CONSTANT_CTX, 3.14, {}, PROV);
    expect(floatResult).toBeInstanceOf(AInexact);
    expect([...(floatResult as AInexact).provenance]).toEqual([42]);
  });

  it("with EMPTY_PROVENANCE preserves backward-compatible no-stamp behavior", () => {
    // Empty-provenance fast path reuses singletons / skips withProvenance —
    // boxer registry decides whether to allocate. SchemeString always
    // allocates (no singleton); SchemeBool reuses schemeTrue/schemeFalse.
    expect(jsToScheme(CONSTANT_CTX, true, {}, EMPTY_PROVENANCE)).toBe(schemeTrue);
    expect(jsToScheme(CONSTANT_CTX, false, {}, EMPTY_PROVENANCE)).toBe(schemeFalse);
    const str = jsToScheme(CONSTANT_CTX, "x", {}, EMPTY_PROVENANCE) as AString;
    expect(str).toBeInstanceOf(AString);
    expect(str.provenance.size).toBe(0);
  });

  it("with already-AValue same provenance returns input unchanged (identity fast path)", () => {
    const orig = new AString("x", PROV);
    expect(jsToScheme(CONSTANT_CTX, orig, {}, PROV)).toBe(orig);
    // Empty-provenance argument also short-circuits — input is preserved.
    expect(jsToScheme(CONSTANT_CTX, orig, {}, EMPTY_PROVENANCE)).toBe(orig);
  });
});

describe("jsToScheme WeakSet cycle protection", () => {
  it("self-cyclic JS array does not stack-overflow", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    // No assertion on the inner reference shape — only that the call returns
    // without blowing the stack. The Pair-chain for the outer reference is
    // built; the cyclic slot bottoms out at the WeakSet guard.
    expect(() => jsToScheme(CONSTANT_CTX, arr, {}, PROV)).not.toThrow();
  });

  it("mutual-cycle plain objects terminate", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.peer = b;
    b.peer = a;
    expect(() => jsToScheme(CONSTANT_CTX, a, {}, PROV)).not.toThrow();
  });
});

describe("SchemeJSObject.get — cached boundary-validated boxing", () => {
  it("(eq? (@ obj :x) (@ obj :x)) returns #t — cached AValue reused", () => {
    const obj = new AJSObject({ x: 42 }, PROV);
    const a = obj.get("x");
    const b = obj.get("x");
    // Identity: the cache returns the same AValue instance on repeat reads.
    expect(a).toBe(b);
  });

  it("entry carries the wrapper's provenance", () => {
    const obj = new AJSObject({ greeting: "hi" }, PROV);
    const greeting = obj.get("greeting") as AString;
    expect(greeting).toBeInstanceOf(AString);
    expect([...greeting.provenance]).toEqual([42]);
  });

  it("missing key returns nil", () => {
    const obj = new AJSObject({ x: 1 }, PROV);
    expect(obj.get("nope")).toBe(nil);
  });

  // [impl-pinning] pins the exact mechanism (throw + cached-read stability), not just
  // "writes don't work" — a rewrite that dropped the cache stability would regress silently.
  it("rejects writes — set is banned (pure-dataflow sandbox), source unchanged", () => {
    const source: { x: unknown } = { x: 1 };
    const obj = new AJSObject(source, PROV);
    const first = obj.get("x") as AExact;
    expect(first.valueOf()).toBe(1);
    // Writing the foreign peer is not dataflow — the membrane is read-only.
    expect(() => obj.set("x", new AExact(99))).toThrow(/writes are banned/);
    expect(source.x).toBe(1); // nothing was written
    // The cached read remains the same stable AValue.
    expect(obj.get("x")).toBe(first);
  });

  it("withProvenance returns a wrapper with empty cache", () => {
    const obj = new AJSObject({ x: 1 }, PROV);
    obj.get("x"); // populate cache
    const clone = obj.withProvenance(new Set<number>([99]));
    // Clone holds the same source but boxes entries fresh with the new
    // provenance — identity does NOT cross-talk between provenance variants.
    const xViaClone = clone.get("x") as AExact;
    expect([...xViaClone.provenance]).toEqual([99]);
  });

  it("blocked key (sandboxedAccess NOT_FOUND) returns nil", () => {
    // Object.prototype methods are filtered by the sandbox boundary —
    // `.get("toString")` resolves to NOT_FOUND for plain-object sources.
    const obj = new AJSObject({ x: 1 }, PROV);
    expect(obj.get("toString")).toBe(nil);
  });
});

describe("dict-ref / @ / :key all route through SchemeJSObject.get", () => {
  it("(:x obj) returns the same AValue identity as (@ obj :x)", async () => {
    // Both `@` and `:key` dispatch into `obj.get(...)` for SchemeJSObject
    // targets — the wrapper's cache makes the two surfaces return the same
    // AValue instance, so `(eq? (@ obj :x) (:x obj))` holds.
    const env = inferenceEnv.child("test") as EnvWithInternals<ResolvingAmbient>;
    const wrapper = new AJSObject({ x: "hello" });
    env.bind("obj", wrapper);
    const [viaAt] = await exec("(@ obj :x)", { env });
    const [viaColon] = await exec("(:x obj)", { env });
    expect(viaAt).toBe(viaColon);
  });
});
