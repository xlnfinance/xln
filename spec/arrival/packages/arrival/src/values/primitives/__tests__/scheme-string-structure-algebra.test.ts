// Algebras-in-entities cell (wave 2): SchemeString's structure-algebras —
// Functor (char map), Semigroup (string-append), Monoid ("" identity).
// Migrated from the the dissolved fantasy-land bridge monkey-patch INTO the SchemeString
// class body (plan-2026-06-10-algebras-in-entities.md).
//
// SchemeString HAS `arrival/tagless-final/equals` (wave-1 Setoid), so the law harness's
// internal `equals` works directly — no custom eq needed.
import fc from "fast-check";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { describe, expect, it } from "vitest";
import { AString } from "../AString.js";
import { functorLaws, monoidLaws, semigroupLaws } from "./algebra-laws.js";
import { tf, type TaglessOp } from "../../tagless-final.js";

type FL = Record<string, any>;

// Small domain + edge cases: "" (empty), astral unicode, ASCII.
const arb = fc
  .oneof(fc.constantFrom("", "a", "b", "ab", "🦄", "naïve", "Z"), fc.string({ maxLength: 4 }))
  .map((s) => new AString(s));

// ----------------------------------------------------------------------
// Semigroup (string-append) — associativity. Functor — identity + composition
// over ASCII char transforms (uppercase/swap) to keep it code-point-clean.
// ----------------------------------------------------------------------
semigroupLaws("SchemeString", arb);

// Functor laws map per-character; use case-flip transforms (string→string).
functorLaws<AString, string>("SchemeString", {
  arb,
  f: (c) => c.toUpperCase(),
  g: (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()),
});

// ----------------------------------------------------------------------
// Monoid — "" is the identity for append.
// ----------------------------------------------------------------------
monoidLaws("SchemeString", arb, () => new AString(""));

describe("SchemeString — structure-algebra behavior", () => {
  it("concat appends underlying strings", () => {
    const r = (new AString("foo") as FL)[tf("concat")](new AString("bar"));
    expect((r as AString).valueOf()).toBe("foobar");
  });
  // INVARIANT: empty() produces the empty string (pins implementation, not behavior —
  // "empty" not in canonical TaglessOp union today, cast reaches the algebra method).
  it("empty() is the empty string", () => {
    const e = (AString as FL)[tf("empty" as TaglessOp)]() as AString;
    expect(e.valueOf()).toBe("");
  });
  // INVARIANT: of(value) stringifies into a SchemeString (pins implementation, not
  // behavior — "of" not in canonical TaglessOp union today, cast reaches the algebra method).
  it("of(value) stringifies into a SchemeString", () => {
    const s = (AString as FL)[tf("of" as TaglessOp)](42) as AString;
    expect(s).toBeInstanceOf(AString);
    expect(s.valueOf()).toBe("42");
  });
  it("map transforms each character", () => {
    const r = (new AString("abc") as FL)[tf("map")]((c: string) => c.toUpperCase());
    expect((r as AString).valueOf()).toBe("ABC");
  });
  it("map iterates by code point (astral chars map as single graphemes)", () => {
    const seen: string[] = [];
    (new AString("a🦄b") as FL)[tf("map")]((c: string) => {
      seen.push(c);
      return c;
    });
    expect(seen).toEqual(["a", "🦄", "b"]);
  });
  it("concat is pure (operands untouched)", () => {
    const a = new AString("x");
    const b = new AString("y");
    (a as FL)[tf("concat")](b);
    expect(a.valueOf()).toBe("x");
    expect(b.valueOf()).toBe("y");
  });
});
