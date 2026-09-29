import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { isComplex } from "../../numbers.js";
import { AExact } from "../AExact.js";
import { AInexact } from "../AInexact.js";

describe("isComplex", () => {
  it("is the omitted-tower stub — always #f", () => {
    expect(isComplex(new AExact(3))).toBe(false);
    expect(isComplex(new AInexact(3.14))).toBe(false);
    expect(isComplex(undefined)).toBe(false);
  });
});

describe("ExactNumber", () => {
  it("creates integers", () => {
    const n = new AExact(42);
    expect(n.num).toBe(42);
    expect(n.denom).toBe(1);
    expect(n.isInteger).toBe(true);
    expect(n.isExact).toBe(true);
    expect(n.toString()).toBe("42");
  });

  it("creates and normalizes rationals", () => {
    const n = new AExact(6, 4);
    expect(n.num).toBe(3);
    expect(n.denom).toBe(2);
    expect(n.isInteger).toBe(false);
    expect(n.toString()).toBe("3/2");
  });

  it("handles negative rationals", () => {
    const n = new AExact(-6, 4);
    expect(n.num).toBe(-3);
    expect(n.denom).toBe(2);

    const n2 = new AExact(6, -4);
    expect(n2.num).toBe(-3);
    expect(n2.denom).toBe(2);
  });

  it("performs exact arithmetic", () => {
    const a = new AExact(1, 2);
    const b = new AExact(1, 3);

    expect(a.add(b).toString()).toBe("5/6");
    expect(a.sub(b).toString()).toBe("1/6");
    expect(a.mul(b).toString()).toBe("1/6");
    expect(a.div(b).toString()).toBe("3/2");
  });

  it("has tower predicates", () => {
    const n = new AExact(3, 4);
    expect(n.isInteger).toBe(false);
    expect(n.isRational).toBe(true);
    expect(n.isReal).toBe(true);
    expect(n.isComplex).toBe(false);
  });

  it("rounds to even on ties", () => {
    expect(new AExact(5, 2).round().toString()).toBe("2"); // 2.5 → 2
    expect(new AExact(7, 2).round().toString()).toBe("4"); // 3.5 → 4
    expect(new AExact(-5, 2).round().toString()).toBe("-2"); // -2.5 → -2
  });
});

describe("InexactNumber", () => {
  it("creates reals", () => {
    const n = new AInexact(3.14);
    expect(n.real).toBe(3.14);
    expect(n.isReal).toBe(true);
    expect(n.isExact).toBe(false);
  });

  // Complex construction / arithmetic removed: arrival is reals-only (complex tower
  // omitted, R7RS § 6.2.3). SchemeInexact has no imaginary axis.

  it("has tower predicates", () => {
    const real = new AInexact(3.0);
    expect(real.isInteger).toBe(true);
    expect(real.isRational).toBe(true); // R7RS: finite reals are rational
    expect(real.isReal).toBe(true);
    expect(real.isComplex).toBe(false);
  });

  it("rounds to even on ties", () => {
    expect(new AInexact(2.5).round().real).toBe(2);
    expect(new AInexact(3.5).round().real).toBe(4);
    expect(new AInexact(4.5).round().real).toBe(4);
  });

  it("handles special values", () => {
    expect(new AInexact(Infinity).toString()).toBe("+inf.0");
    expect(new AInexact(-Infinity).toString()).toBe("-inf.0");
    expect(new AInexact(NaN).toString()).toBe("+nan.0");
  });
});
