import { describe, expect, it } from "vitest";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { parseNumber } from "../../values/numbers.js";

describe("parseNumber", () => {
  it("parses integers", () => {
    const n = parseNumber("42");
    expect(n).toBeInstanceOf(AExact);
    expect(n.toString()).toBe("42");
  });

  it("parses rationals", () => {
    const n = parseNumber("3/4");
    expect(n).toBeInstanceOf(AExact);
    expect(n.toString()).toBe("3/4");
  });

  it("parses floats", () => {
    const n = parseNumber("3.14");
    expect(n).toBeInstanceOf(AInexact);
    expect((n as AInexact).real).toBeCloseTo(3.14);
  });

  it("parses special values", () => {
    expect(parseNumber("+inf.0").toString()).toBe("+inf.0");
    expect(parseNumber("-inf.0").toString()).toBe("-inf.0");
    expect(parseNumber("+nan.0").isNaN).toBe(true);
  });

  it("handles exactness prefixes", () => {
    const inexact = parseNumber("#i42");
    expect(inexact).toBeInstanceOf(AInexact);
    expect(inexact.toString()).toBe("42.0");

    const exact = parseNumber("#e3.0");
    expect(exact).toBeInstanceOf(AExact);
    expect(exact.isInteger).toBe(true);
  });

  it("handles radix prefixes", () => {
    expect(parseNumber("#xff").toString()).toBe("255");
    expect(parseNumber("#b1010").toString()).toBe("10");
    expect(parseNumber("#o77").toString()).toBe("63");
  });
});
