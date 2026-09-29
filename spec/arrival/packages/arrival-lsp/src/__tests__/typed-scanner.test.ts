// typed-scanner — the Σ∩T bridge. Proves narrowByType intersects a base scanner's validSymbols()
// with the type-valid set at an argument slot, passes through elsewhere, and memoizes the (slow)
// type query per slot. A mock base scanner supplies a known Σ; the REAL language service supplies T.
import { describe, expect, it, vi } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";
import { narrowByType, type Scanner, type ScannerState } from "../typed-scanner.js";

const SIGMA = new Set(["car", "cdr", "filter", "list", "length", "not"]);

/** A mock base scanner: every query reports the given position/formKind and the fixed Σ. Enough to
 *  drive narrowByType — it only consumes midToken/position/formKind/validSymbols. */
function mockScanner(position: ScannerState["position"], formKind: ScannerState["formKind"] = "application"): Scanner {
  const ATOM = /[^\s()[\]{}"';]/;
  const midToken = (s: string) => s.length > 0 && ATOM.test(s.at(-1)!);
  return {
    feasible: () => true,
    analyze: (s): ScannerState => ({
      midToken: midToken(s),
      position,
      formKind,
      closeable: false,
      validSymbols: () => SIGMA,
    }),
  };
}

describe("narrowByType — Σ∩T at the argument slot", () => {
  const ls = createSchemeLanguageService();

  it("narrows validSymbols() to the type-valid subset at a typed argument slot", () => {
    const scanner = narrowByType(mockScanner("argument"), ls);
    // `(car ⟨atom⟩` — the arg wants a List, so only list-PRODUCERS survive the Σ∩T intersection.
    const valid = scanner.analyze("(car l").validSymbols()!;
    expect(valid.has("filter")).toBe(true); // returns a list
    expect(valid.has("list")).toBe(true);
    expect(valid.has("cdr")).toBe(true);
    expect(valid.has("car")).toBe(false); // returns an element — type-masked out
    expect(valid.has("length")).toBe(false); // returns a number
    expect(valid.has("not")).toBe(false); // returns a bool
    // The narrowed set is a SUBSET of Σ (T only drops, never adds).
    for (const s of valid) expect(SIGMA.has(s)).toBe(true);
  });

  it("passes through unchanged at the operator slot (Σ owns operators)", () => {
    const scanner = narrowByType(mockScanner("operator"), ls);
    expect(scanner.analyze("(ca").validSymbols()).toBe(SIGMA); // same reference — untouched
  });

  it("passes through when not an application (e.g. quote/lambda-list)", () => {
    const scanner = narrowByType(mockScanner("argument", "quote"), ls);
    expect(scanner.analyze("(quote x").validSymbols()).toBe(SIGMA);
  });

  it("memoizes the type query per slot — one lens call for all candidates of a step", () => {
    const spy = vi.fn(ls.getTypeValidCandidates.bind(ls));
    const arrSpy = vi.fn(ls.getSlotIsArray.bind(ls));
    const strSpy = vi.fn(ls.getSlotAcceptsBareWord.bind(ls));
    const elemSpy = vi.fn(ls.getSlotElementType.bind(ls));
    const scanner = narrowByType(mockScanner("argument"), {
      getTypeValidCandidates: spy,
      getSlotIsArray: arrSpy,
      getSlotAcceptsBareWord: strSpy,
      getSlotElementType: elemSpy,
    });
    // Same slot `(car `, different trailing atoms (as candidates extend the prefix): one query EACH.
    scanner.analyze("(car c");
    scanner.analyze("(car ca");
    scanner.analyze("(car cd");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(arrSpy).toHaveBeenCalledTimes(1); // the structure verdict is memoized per slot too
    expect(strSpy).toHaveBeenCalledTimes(1); // the scalar-string verdict is memoized per slot too
    expect(elemSpy).toHaveBeenCalledTimes(1); // the array-element verdict is memoized per slot too
    // A different slot → a second query of each.
    scanner.analyze("(+ 1 l");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(arrSpy).toHaveBeenCalledTimes(2);
    expect(strSpy).toHaveBeenCalledTimes(2);
    expect(elemSpy).toHaveBeenCalledTimes(2);
  });
});
