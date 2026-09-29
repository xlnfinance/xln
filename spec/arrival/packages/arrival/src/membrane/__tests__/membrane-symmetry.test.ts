/**
 * Two-API membrane symmetry tests.
 *
 * The codebase has two parallel JS↔Scheme conversion surfaces:
 *
 *   - rosetta.ts:  toJS / jsToScheme — used by rosetta wrappers + sandbox env.
 *   - membrane.ts: AValue.fromJs + boxer dispatch / membrane.toJS — used by
 *                  FFI codecs (Operator/Codec) and the AValue subtype boxers.
 *
 * They should compose: jsToScheme → toJS round-trips, fromJs → toJs round-trips,
 * and the two APIs agree on the SHAPE of converted values.
 *
 * The membrane now MATERIALIZES faithfully: `jsToScheme` boxes every
 * primitive (number→exact, boolean→ABool, string→AString) through the boxer registry,
 * map undefined → #void (a lens, no warn), a bare function → a genuine scheme-callable
 * `ARosettaProcedure` (the reverse-membrane lens, V's 2026-07-24 ruling — args cross
 * scheme→js, result crosses js→scheme), a unique symbol and a host bigint door
 * (`NoLensError`), and Symbol.for('x') → the keyword `:x`. The sandbox never holds a
 * raw JS value — the deliberate, host-agnostic narrowing of JS interop. These tests
 * pin that.
 *
 * Tests intended to pass are GREEN; documented divergences are it.fails.
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";
import { fromJs } from "../boxing.js";
import { is_nil } from "../../values/value-guards.js";
import { isSchemeValue } from "../membrane.js";
import { toJS, jsToScheme } from "../rosetta.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";
import { ALambda } from "../../values/primitives/ACallable.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { ABool, schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { theVoid, AVoid } from "../../values/primitives/AVoid.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";

// =========================================================================
// AValue.fromJs boxer dispatch — coverage of every registered tag
// =========================================================================

describe("AValue.fromJs — boxer dispatch produces the expected subtype per typeof tag", () => {
  // Boxer registry resolution: typeof string → "string" boxer (SchemeString.ts:139)
  it("string → SchemeString", () => {
    const result = fromJs(CONSTANT_CTX, "hello");
    expect(result).toBeInstanceOf(AString);
    expect((result as AString).valueOf()).toBe("hello");
  });

  // typeof 42 === "number" — registered in operators/index.ts (via the
  // numbers module). Safe integer path → SchemeExact with bigint num.
  it("number (safe integer) → SchemeExact", () => {
    const result = fromJs(CONSTANT_CTX, 42);
    expect(result).toBeInstanceOf(AExact);
    expect((result as AExact).num).toBe(42);
  });

  // Non-integer float → SchemeInexact (real part).
  it("number (float) → SchemeInexact", () => {
    const result = fromJs(CONSTANT_CTX, 3.14);
    expect(result).toBeInstanceOf(AInexact);
    expect((result as AInexact).real).toBe(3.14);
  });

  // typeof 1n === "bigint" → NoLensError door (same spirit as unique-symbol).
  it("bigint → door (NoLensError; never boxed; not a scheme number)", () => {
    expect(() => fromJs(CONSTANT_CTX, 123n)).toThrow(/no lens for a host bigint/);
  });

  // SchemeBool.ts:32-34 — empty-provenance fast path REUSES the schemeTrue/schemeFalse
  // singletons. Non-empty provenance mints a fresh SchemeBool.
  it("boolean (empty provenance) → singleton SchemeBool", () => {
    expect(fromJs(CONSTANT_CTX, true)).toBe(schemeTrue);
    expect(fromJs(CONSTANT_CTX, false)).toBe(schemeFalse);
  });

  it("boolean (non-empty provenance) → fresh SchemeBool with provenance", () => {
    const prov = new Set<number>([99]);
    const result = fromJs(CONSTANT_CTX, true, prov);
    expect(result).toBeInstanceOf(ABool);
    expect(result).not.toBe(schemeTrue);
    expect((result as ABool).value).toBe(true);
    expect([...result.provenance]).toEqual([99]);
  });

  // The two JS bottoms map to the two distinct Scheme absences (Rosetta
  // concept-split): null → nil (empty list); undefined → void (unspecified).
  // Empty provenance still returns a fresh instance (withProvenance always
  // allocates) — the clone-leak shape.
  it("null → Nil instance", () => {
    const result = fromJs(CONSTANT_CTX, null);
    expect(result).toBeInstanceOf(ANil);
    expect(result instanceof ANil).toBe(true);
  });

  it("undefined → Void instance", () => {
    const result = fromJs(CONSTANT_CTX, undefined);
    expect(result).toBeInstanceOf(AVoid);
  });

  // the "object" boxer. A JS array IS an R7RS vector → a borrowed AJSArray (no more list
  // coercion); a plain object wraps as SchemeJSObject.
  it("array → borrowed AJSArray vector (boxes lazily on access)", () => {
    const result = fromJs(CONSTANT_CTX, [1, 2, 3]);
    expect(result).toBeInstanceOf(AJSArray);
    expect((result as { kind: string }).kind).toBe("vector");
    expect((result as unknown as { __vector__: AExact[] }).__vector__[0].num).toBe(1);
  });

  it("plain object → SchemeJSObject wrapper", () => {
    const obj = { foo: 1 };
    const result = fromJs(CONSTANT_CTX, obj);
    expect(result).toBeInstanceOf(AJSObject);
    expect((result as AJSObject).source).toBe(obj);
  });

  // INVARIANT: function → callable — V's ruling (2026-07-24) retired the void tier;
  // the boxer registry now mints the SAME reverse-membrane lens jsToScheme's
  // FOREIGN_LENS_CLAIMS function row does (ACallable.ts's `hostFnToCallable`).
  it("function → ARosettaProcedure (the boxer registry mints the reverse-membrane lens)", () => {
    expect(fromJs(CONSTANT_CTX, () => 42)).toBeInstanceOf(ARosettaProcedure);
  });

  // A real ALambda passes through jsToScheme by identity — already a scheme value.
  it("a real ALambda passes through jsToScheme by identity (it IS a scheme value)", () => {
    const lam = new ALambda({
      name: "test-lambda",
      arity: { min: 0, max: 0 },
      scope: undefined,
      runner: () => theVoid,
    });
    expect(jsToScheme(CONSTANT_CTX, lam)).toBe(lam);
  });

  it("a bare host function crosses jsToScheme as a callable (reverse-membrane lens)", () => {
    expect(jsToScheme(CONSTANT_CTX, () => 42)).toBeInstanceOf(ARosettaProcedure);
  });

  // AValue input is returned as-is on the empty-provenance fast path.
  it("AValue input (empty provenance) is returned by identity", () => {
    const orig = new AString("x");
    expect(fromJs(CONSTANT_CTX, orig)).toBe(orig);
  });

  it("AValue input (with non-empty provenance) is cloned via withProvenance", () => {
    const orig = new AString("x");
    const prov = new Set<number>([7]);
    const result = fromJs(CONSTANT_CTX, orig, prov);
    expect(result).not.toBe(orig);
    expect(result).toBeInstanceOf(AString);
    expect([...(result as AString).provenance]).toEqual([7]);
  });
});

// =========================================================================
// jsToScheme → toJS round-trip
// =========================================================================

describe("jsToScheme → toJS round-trip", () => {
  // A JS string boxes to AString on the way in.
  it("string is wrapped through jsToScheme into SchemeString", () => {
    const lipsified = jsToScheme(CONSTANT_CTX, "hello");
    expect(lipsified).toBeInstanceOf(AString);
  });

  // Then unwraps back to a raw JS string on the way out.
  it("string round-trips by passthrough (raw → raw)", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, "hello"))).toBe("hello");
  });

  it("number round-trips by passthrough", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, 42))).toBe(42);
  });

  it("boolean round-trips by passthrough", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, true))).toBe(true);
  });

  // Arrays enter as borrowed AJSArray vectors; toJS unwraps back to a JS array.
  it("array round-trips through a Pair chain", () => {
    const result = toJS(jsToScheme(CONSTANT_CTX, [1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  it("nested array round-trips", () => {
    const result = toJS(
      jsToScheme(CONSTANT_CTX, [
        [1, 2],
        [3, 4],
      ]),
    );
    expect(result).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  // Plain objects are recursed: jsToScheme builds { k: jsToScheme(CONSTANT_CTX, v) }, toJS
  // mirrors via Object.entries → toJS(value). Round-trip is correct.
  it("plain object round-trips", () => {
    const result = toJS(jsToScheme(CONSTANT_CTX, { a: 1, b: "two" }));
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("nested object round-trips", () => {
    const result = toJS(jsToScheme(CONSTANT_CTX, { outer: { inner: 42 } }));
    expect(result).toEqual({ outer: { inner: 42 } });
  });

  // null → nil (jsToScheme); toJS(nil) → [] — the reverse delegates to
  // arrival/toJS, whose face is the empty list's ARRAY (nil-as-array, V ruling
  // 2026-07-13: emptiness must not flip a list's JS type to null; matches the
  // compiled world's '() representation). The round trip is asymmetric BY LAW:
  // ingress permissive (null → nil), egress canonical (nil → []).
  it("null enters as nil and exits as [] (ingress permissive, egress canonical)", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, null))).toEqual([]);
  });
});

// =========================================================================
// isSchemeValue completeness — every native AValue subtype
// =========================================================================

describe("isSchemeValue completeness — every native AValue subtype is recognised", () => {
  // INVARIANT: every native AValue subtype (String/Symbol/Character/Exact/Inexact/Bool/Pair/nil/JSObject) is recognized as a scheme value
  it("SchemeString → true", () => {
    expect(isSchemeValue(new AString("x"))).toBe(true);
  });

  it("SchemeSymbol → true", () => {
    expect(isSchemeValue(new ASymbol("foo"))).toBe(true);
  });

  it("SchemeCharacter → true", () => {
    expect(isSchemeValue(new ACharacter("a"))).toBe(true);
  });

  it("SchemeExact → true", () => {
    expect(isSchemeValue(new AExact(42))).toBe(true);
  });

  it("SchemeInexact → true", () => {
    expect(isSchemeValue(new AInexact(3.14))).toBe(true);
  });

  it("SchemeBool (singletons) → true", () => {
    expect(isSchemeValue(schemeTrue)).toBe(true);
    expect(isSchemeValue(schemeFalse)).toBe(true);
  });

  it("Pair → true", () => {
    expect(isSchemeValue(new APair(new AExact(1), nil))).toBe(true);
  });

  it("nil singleton → true (via the `=== nil` short-circuit)", () => {
    expect(isSchemeValue(nil)).toBe(true);
  });

  it("SchemeJSObject → true", () => {
    expect(isSchemeValue(new AJSObject({}))).toBe(true);
  });

  // Nil-clone isSchemeValue: owned by identity.law (membrane.ts section) — not re-pinned here.

  // Plain JS values should NOT be Scheme values. Negative cases keep the
  // boundary's other direction honest.
  // INVARIANT: plain JS values (string/number/object/array/null/undefined) are NOT scheme values
  it("plain string → false", () => {
    expect(isSchemeValue("hello")).toBe(false);
  });

  it("plain number → false", () => {
    expect(isSchemeValue(42)).toBe(false);
  });

  it("plain object → false", () => {
    expect(isSchemeValue({})).toBe(false);
  });

  it("plain array → false (arrays cons up via boxer, but a raw array is not Scheme)", () => {
    expect(isSchemeValue([1, 2, 3])).toBe(false);
  });

  it("null → false", () => {
    expect(isSchemeValue(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isSchemeValue(undefined)).toBe(false);
  });
});

// =========================================================================
// jsToScheme / toJS — inbound/outbound symmetry
// =========================================================================

describe("membrane jsToScheme / toJS — round-trip", () => {
  it("primitive round-trips: string", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, "hello"))).toBe("hello");
  });

  it("primitive round-trips: number", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, 42))).toBe(42);
  });

  it("bigint DOORS at the membrane (never boxed; never raw passthrough)", () => {
    expect(() => jsToScheme(CONSTANT_CTX, 10n)).toThrow(/no lens for a host bigint/);
    expect(() => toJS(10n as never)).toThrow(/toJS: received a non-scheme value/);
  });

  it("null enters as nil; nil exits as []", () => {
    expect(toJS(jsToScheme(CONSTANT_CTX, null))).toEqual([]);
  });

  it("object round-trips through AJSObject (same source reference)", () => {
    const obj = { a: 1 };
    const wrapped = jsToScheme(CONSTANT_CTX, obj);
    expect(wrapped).toBeInstanceOf(AJSObject);
    expect(toJS(wrapped)).toBe(obj);
  });

  it("a borrowed function crosses IN as a callable (ARosettaProcedure, reverse-membrane lens)", () => {
    expect(jsToScheme(CONSTANT_CTX, () => 42)).toBeInstanceOf(ARosettaProcedure);
  });
});
