// slot-element-type — CUT A: getSlotElementType recovers the ELEMENT type at an array-element cursor,
// across BOTH live array surfaces (`(list …)` and `'(…)`), where the existing slot probes lose it.
//
// THE BUG this probe fixes: at an array value slot the element-type bit is lost the instant the cursor
// descends past the opener. `(list …)` lowers to the generic `list(…)` whose `Parameters[i]` is
// `unknown` (so getSlotAcceptsBareWord reports stringy=true → a bare multi-word word slips in); `'(…)`
// lowers to a TS array-LITERAL with no enclosing call (so the slot probes find nothing — null). This
// probe reads the element via the enclosing array-producer's CONTEXTUAL type instead, so both surfaces
// resolve the SAME element type the outer slot demands.
import { describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

// An array-of-ENUM function (the closed-domain element case) — mirrors completions-narrowing's DIET_HOST.
const DIET_HOST = assembleHostPrelude(
  [
    ["set_diet", "(preferences: T_pref[]): SStr"],
    ["vegan", ": T_pref"],
    ["vegetarian", ": T_pref"],
    ["pescatarian", ": T_pref"],
  ],
  { preamble: `type T_pref = "vegan" | "vegetarian" | "pescatarian";` },
);

// A function with BOTH a free-form string array (the force-quote case) and a scalar string arg (a control),
// plus a number-array (a non-stringy element control). `ReadonlyArray<unknown>` is exactly what bfcl's
// SBASE.array emits for a free-form `array<string>` param.
const MIXED_HOST = assembleHostPrelude([
  ["find", "(location: string, tags: ReadonlyArray<unknown>, scores: number[]): SStr"],
]);

function elem(host: ReturnType<typeof assembleHostPrelude>, scheme: string) {
  const ls = createSchemeLanguageService({ host });
  return ls.getSlotElementType(scheme, scheme.length);
}

describe("getSlotElementType — CUT A (array-element type recovery, both surfaces)", () => {
  // ── ENUM element: the closed string-literal union, recovered identically for (list …) and '(…). ──
  it("(list …) enum element → enum members, not stringy", () => {
    expect(elem(DIET_HOST, `(set_diet (list `)).toEqual({
      isStringy: false,
      enum: ["vegan", "vegetarian", "pescatarian"],
    });
  });
  it("(list …) enum element AFTER a first element → still the enum members", () => {
    expect(elem(DIET_HOST, `(set_diet (list "vegan" `)).toEqual({
      isStringy: false,
      enum: ["vegan", "vegetarian", "pescatarian"],
    });
  });
  it("'(…) enum element → enum members (see-through the quote's array-literal lowering)", () => {
    expect(elem(DIET_HOST, `(set_diet '(`)).toEqual({
      isStringy: false,
      enum: ["vegan", "vegetarian", "pescatarian"],
    });
  });
  it("'(…) enum element AFTER a first element → still the enum members", () => {
    expect(elem(DIET_HOST, `(set_diet '("vegan" `)).toEqual({
      isStringy: false,
      enum: ["vegan", "vegetarian", "pescatarian"],
    });
  });

  // ── FREE-FORM string element: isStringy=true (force-quote), no enum, for BOTH surfaces. ──
  it("(list …) free-form string element → isStringy true, no enum (force-quote)", () => {
    expect(elem(MIXED_HOST, `(find "NYC" (list `)).toEqual({ isStringy: true, enum: null });
  });
  it("'(…) free-form string element → isStringy true, no enum (force-quote)", () => {
    expect(elem(MIXED_HOST, `(find "NYC" '(`)).toEqual({ isStringy: true, enum: null });
  });

  // ── NUMBER element: not stringy, no enum (no force-quote — number elements are unchanged). ──
  it("(list …) number element → not stringy, no enum", () => {
    expect(elem(MIXED_HOST, `(find "NYC" (list "a") (list `)).toEqual({ isStringy: false, enum: null });
  });

  // ── CONTROLS: the probe is INERT (null/null) wherever the cursor is NOT an array element. ──
  it("scalar string slot (not an element) → null/null", () => {
    expect(elem(MIXED_HOST, `(find `)).toEqual({ isStringy: null, enum: null });
  });
  it("the OUTER array slot itself (the array, not its element) → null/null", () => {
    expect(elem(DIET_HOST, `(set_diet `)).toEqual({ isStringy: null, enum: null });
  });
  it("an argument of a REGULAR nested call (its own param governs) → null/null", () => {
    // The cursor is an argument of `some-call`, not an element of set_diet's array.
    expect(elem(DIET_HOST, `(set_diet (some-call `)).toEqual({ isStringy: null, enum: null });
  });
  it("unknown callee → null/null (no slot to resolve)", () => {
    expect(elem(DIET_HOST, `(totally-unknown-tool (list `)).toEqual({ isStringy: null, enum: null });
  });
});
