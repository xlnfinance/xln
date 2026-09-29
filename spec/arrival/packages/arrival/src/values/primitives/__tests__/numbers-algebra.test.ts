// Reference cell for the algebras-in-entities migration: Setoid on the number
// types. Proves the A2 law-checker end-to-end AND fixes the live
// `(equal? 1 1.0) → #t` bug (structuralEqual consults arrival/tagless-final/equals first,
// so the exact/inexact instances now answer correctly).
import fc from "fast-check";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { describe, expect, it } from "vitest";
import { AExact } from "../AExact.js";
import { AInexact } from "../AInexact.js";
import { structuralEqual } from "../../structural-equal.js";
import { setoidLaws } from "./algebra-laws.js";
import { tf } from "../../tagless-final.js";

// Exact rationals over a small domain (collisions exercise symmetry/transitivity).
// RE-PINNED (one-number rework, RATIO — docs/design-history/arrival-one-number-rework.md
// §0.2): AExact's num/denom are safe-int `number`s now, not `bigint` — `fc.integer` replaces
// `fc.bigInt` (fast-check's bigint arbitrary can't feed a number-only constructor at all).
const exactArb = fc
  .tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: 1, max: 50 }))
  .map(([num, denom]) => new AExact(num, denom));

// Inexact reals incl. NaN / ±0 / ±Infinity — the cases that bite reflexivity.
const inexactArb = fc.double({ noDefaultInfinity: false, noNaN: false }).map((real) => new AInexact(real));

setoidLaws("SchemeExact", { arb: exactArb, equalClone: (a) => new AExact(a.num, a.denom) });
setoidLaws("SchemeInexact", { arb: inexactArb, equalClone: (a) => new AInexact(a.real) });

describe("number Setoid — exactness boundary (the (equal? 1 1.0) fix)", () => {
  it("exact 1 is NOT arrival/tagless-final/equals inexact 1.0 (both directions)", () => {
    const one = new AExact(1);
    const oneFloat = new AInexact(1);
    expect(one[tf("equals")](oneFloat)).toBe(false);
    expect(oneFloat[tf("equals")](one)).toBe(false);
  });

  it("structuralEqual honors the exactness boundary (the bug)", () => {
    // structuralEqual consults tagless equals first, so exact 1 ≠ inexact 1.0.
    expect(structuralEqual(new AExact(1), new AInexact(1))).toBe(false);
    expect(structuralEqual(new AExact(1), new AExact(1))).toBe(true);
    expect(structuralEqual(new AInexact(1), new AInexact(1))).toBe(true);
  });

  it("NaN reflexivity holds (Object.is, not ===)", () => {
    const nan = new AInexact(NaN);
    expect(nan[tf("equals")](new AInexact(NaN))).toBe(true);
  });
});
