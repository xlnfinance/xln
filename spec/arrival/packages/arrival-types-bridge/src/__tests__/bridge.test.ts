import { describe, expect, it } from "vitest";

import { emitTypes, encodeSchemeIdent, schemeifyTsText } from "../index.js";

describe("arrival-types-bridge", () => {
  it("encodes and schemeifies identifiers losslessly", () => {
    expect(encodeSchemeIdent("string-append")).toBe("string$dash$append");
    expect(schemeifyTsText("string$dash$append")).toBe("string-append");
  });

  it("emitTypes produces mapped virtual TS", () => {
    const { ts, mappings } = emitTypes(`(define (f x) x)`);
    expect(ts).toMatch(/const f = \(x\) => x/);
    expect(mappings.length).toBeGreaterThan(0);
  });
});
