/**
 * `coerceNumeric` (the SchemeExact/SchemeInexact tower coercion) — home:
 * values/op-helpers.ts.
 *
 * Formerly bridge.spec.ts. The Operator/Codec numeric stack this file used to also
 * test was carved into the `scheme/numeric` pack (env/r7rs/numeric.ts) and the old
 * machinery deleted; that behavior is witnessed at the scheme surface by
 * numbers.spec / r7rs-numbers. bridge.ts itself is deleted (lineage:
 * env/r7rs/error-objects.ts header).
 *
 * RE-PINNED (one-number rework, RATIO — docs/design-history/arrival-one-number-rework.md
 * §2.3): `AExact`'s payload is a safe-int `number` now, not `bigint` — every `.num`/`.denom`
 * assertion below dropped the trailing `n`. More substantively, §2.3 makes a raw host
 * `bigint` a membrane NoLensError door, never a scheme number — `coerceNumeric` (verified
 * directly against `values/op-helpers.ts`) THROWS a TypeError on both the bare-bigint
 * and the `valueOf() → bigint` arms if one still reaches arithmetic, pointing the caller
 * at Number/bigintToNumber (safe-range-checked) before re-crossing.
 * This inverts the two "converts bigint..." cases below from a passing conversion to an
 * expected door.
 */

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { AExact } from "../AExact.js";
import { AInexact } from "../AInexact.js";
import { coerceNumeric } from "../../op-helpers.js";

describe("coerceNumeric", () => {
  describe("primitive types", () => {
    it("DOORS on a raw host bigint — opaque host value, not a scheme number (§2.3)", () => {
      expect(() => coerceNumeric(42n)).toThrow(/host bigint is not a scheme number/);
    });

    it("converts safe integer to ExactNumber", () => {
      const result = coerceNumeric(42);
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42);
    });

    it("converts float to InexactNumber", () => {
      const result = coerceNumeric(3.14);
      expect(result).toBeInstanceOf(AInexact);
      expect((result as AInexact).real).toBe(3.14);
    });
  });

  describe("passthrough", () => {
    it("passes through ExactNumber", () => {
      const exact = new AExact(42);
      expect(coerceNumeric(exact)).toBe(exact);
    });

    it("passes through InexactNumber", () => {
      const inexact = new AInexact(3.14);
      expect(coerceNumeric(inexact)).toBe(inexact);
    });
  });

  describe("objects with valueOf", () => {
    it("DOORS on an object whose valueOf() returns a bigint — same opaque-host law as the bare case", () => {
      const obj = { valueOf: () => 12345678901234567890n };
      expect(() => coerceNumeric(obj)).toThrow(/host bigint is not a scheme number/);
    });

    it("converts object with number valueOf to exact for safe integers", () => {
      const obj = { valueOf: () => 42 };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(42);
    });

    it("converts object with number valueOf to inexact for floats", () => {
      const obj = { valueOf: () => 3.14 };
      const result = coerceNumeric(obj);
      expect(result).toBeInstanceOf(AInexact);
      expect((result as AInexact).real).toBe(3.14);
    });
  });

  it("throws on unconvertible value", () => {
    expect(() => coerceNumeric("not a number")).toThrow("Cannot convert");
    expect(() => coerceNumeric(null)).toThrow("Cannot convert");
    expect(() => coerceNumeric(undefined)).toThrow("Cannot convert");
  });
});
