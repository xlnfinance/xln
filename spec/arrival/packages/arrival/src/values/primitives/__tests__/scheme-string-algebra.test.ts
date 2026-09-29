// Algebras-in-entities cell: Setoid + Ord on SchemeString. The arbitrary biases
// toward the hard cases — empty string, unicode, and a small domain so
// collisions make symmetry/transitivity/antisymmetry bite. equalClone forges a
// fresh distinct-but-equal instance, exercising the value-equality (string-copy)
// contract a bare `===` would miss.
import fc from "fast-check";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { describe, expect, it } from "vitest";
import { AString } from "../AString.js";
import { ordLaws, setoidLaws } from "./algebra-laws.js";
import { tf } from "../../tagless-final.js";

// Small domain + edge cases: "" (empty), astral unicode, ASCII collisions.
const arb = fc
  .oneof(fc.constantFrom("", "a", "b", "ab", "🦄", "🦄a", "naïve", "Z"), fc.string({ maxLength: 4 }))
  .map((s) => new AString(s));

const equalClone = (s: AString) => new AString(s.valueOf());

setoidLaws("SchemeString", { arb, equalClone });
ordLaws("SchemeString", arb);

describe("SchemeString Setoid/Ord — totality boundaries", () => {
  it("value equality over distinct heap instances", () => {
    const a = new AString("🦄");
    const b = new AString("🦄");
    expect(a[tf("equals")](b)).toBe(true);
  });

  it("equals is representation-blind (plain string matches by content); lte stays type-strict", () => {
    const a = new AString("a");
    // equals: a boxed string equals the SAME value UNBOXED (a plain JS string) — the representation-
    // blindness that fixes dedup over chain-boxed strings (sift/closure.scm). Content still discriminates.
    expect(a[tf("equals")]("a")).toBe(true);
    expect(a[tf("equals")]("b")).toBe(false);
    expect(a[tf("equals")](42)).toBe(false);
    // lte (Ord) is unchanged: still type-strict. Cross-representation ORDERING is a separate question
    // from the equality bug; left strict deliberately.
    expect(a[tf("lte")]("a")).toBe(false);
    expect(a[tf("lte")](null)).toBe(false);
  });

  it("lexicographic lte agrees with JS string order", () => {
    const a = new AString("ab");
    const b = new AString("b");
    expect(a[tf("lte")](b)).toBe(true);
    expect(b[tf("lte")](a)).toBe(false);
  });
});
