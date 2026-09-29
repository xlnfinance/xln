// Algebras-in-entities cell: Setoid + Semigroup + Functor on SchemeVector.
// Elements are boxed exact numbers (AExact) from a small domain so collisions
// make the Setoid laws (symmetry/transitivity) bite — a vector's payload is
// SchemeValue[], so `(vector 1 2 3)` stores AExact, not raw JS numbers. The
// Functor transforms are number→number over the elements' numeric value
// (AExact coerces via valueOf).
//
// AVector.map PRESERVES every mapped element's box, rebuilding a FRESH AVector (DR4
// fix — mirrors APair's box-preserving map, P8 "one algebra, every carrier"). So the
// mapped structure exposes a boxed `__vector__`, and the Functor identity law
// `map(id) ≡ id` holds under the BOXED Setoid: `boxedEq` compares the two structures'
// materialized boxes element-wise via `structuralEqual` (which dispatches each
// element's AExact Setoid).
// (Boxing track S5 — docs/plan-2026-06-10-boxing-track.md.)
import fc from "fast-check";
import { unaryContour } from "../../../__tests__/_contour-callback.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { describe, expect, it } from "vitest";
import { AVector } from "../AVector.js";
import { AExact } from "../AExact.js";
import { structuralEqual } from "../../structural-equal.js";
import type { SchemeValue } from "../../types.js";
import { functorLaws, semigroupLaws, setoidLaws } from "./algebra-laws.js";
import { tf } from "../../tagless-final.js";

// A vector element is a boxed exact integer (the interpreter is monadic-boxed:
// `(vector 1 2 3)` mints AExact slots). The reader domain is small ints, so an
// exact box is the faithful element.
const box = (n: number): AExact => new AExact(n);
const vec = (ns: number[]): AVector => new AVector(ns.map(box));

// Numeric value of one element — AExact coerces via valueOf. A mapped structure
// re-boxes its raw `.source` to AExact on access, so a materialized element is an
// AExact just like a constructed one.
const numOf = (x: SchemeValue): number => Number(x.valueOf());

// The BOXED Setoid equality for the Functor laws: AVector.map preserves every element's
// box, rebuilding a fresh AVector — so both the mapped structure and the source expose a
// boxed `__vector__`. We compare those boxes element-wise via `structuralEqual`, which
// routes each element through its own Setoid (AExact ≡ AExact).
const boxedEq = (a: { __vector__: readonly SchemeValue[] }, b: { __vector__: readonly SchemeValue[] }): boolean =>
  a.__vector__.length === b.__vector__.length && a.__vector__.every((x, i) => structuralEqual(x, b.__vector__[i]));

// Small element domain + edge cases: empty, singletons, collisions.
const arb = fc
  .oneof(
    fc.constantFrom<number[]>([], [0], [1], [1, 2], [1, 2, 3], [2, 1]),
    fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 4 }),
  )
  .map(vec);

const equalClone = (v: AVector) => new AVector(v.__vector__.slice());

setoidLaws("SchemeVector", { arb, equalClone });
semigroupLaws("SchemeVector", arb);
// INVARIANT: map identity and composition hold under the boxed (materialized-access)
// equality (pins implementation, not behavior — boxedEq compares __vector__ directly).
functorLaws<AVector, number>("SchemeVector", {
  arb,
  // Natural element transforms — a box arrives, coerces via valueOf, returns a number;
  // the mapped structure re-boxes it on access, so no manual re-boxing is needed here.
  f: (x: number) => x + 1,
  g: (x: number) => x * 2,
  eq: boxedEq,
});

describe("SchemeVector Setoid/Semigroup/Functor — boundaries", () => {
  it("structural value equality over distinct heap payloads", () => {
    const a = vec([1, 2, 3]);
    const b = vec([1, 2, 3]);
    expect(a[tf("equals")](b)).toBe(true);
  });

  it("nested-vector equality recurses through structuralEqual", () => {
    const a = new AVector([vec([1, 2]), box(3)]);
    const b = new AVector([vec([1, 2]), box(3)]);
    expect(a[tf("equals")](b)).toBe(true);
    const c = new AVector([vec([1, 9]), box(3)]);
    expect(a[tf("equals")](c)).toBe(false);
  });

  it("non-SchemeVector other → false (a raw array is NOT a SchemeVector)", () => {
    const a = vec([1, 2]);
    expect(a[tf("equals")]([1, 2])).toBe(false);
    expect(a[tf("equals")](42)).toBe(false);
  });

  it("concat appends elements, length-additive", () => {
    const a = vec([1, 2]);
    const b = vec([3]);
    const c = a[tf("concat")](b);
    expect(c.__vector__.map(numOf)).toEqual([1, 2, 3]);
  });

  it("map preserves element boxes, rebuilding a FRESH AVector (DR4 fix)", async () => {
    const a = vec([1, 2, 3]);
    // The transform returns a boxed element — `map`'s `fn` is honestly typed `SchemeValue →
    // SchemeValue` (a Scheme transform yields a Scheme value). `map` preserves that box
    // directly, rebuilding a fresh AVector (mirrors APair's box-preserving map, P8).
    const mapped = (await a[tf("map")](
      unaryContour((x) => box(numOf(x) * 10)),
      CONSTANT_CTX,
    )) as AVector;
    expect(mapped).toBeInstanceOf(AVector);
    expect(mapped.__vector__.every((e) => e instanceof AExact)).toBe(true);
    expect(mapped.__vector__.map(numOf)).toEqual([10, 20, 30]);
    // The source vector is untouched (a fresh structure was produced).
    expect(a.__vector__.map(numOf)).toEqual([1, 2, 3]);
  });

  it("toJs / TO_JS unwrap to the raw array", () => {
    const a = vec([1, 2, 3]);
    // `arrival/toJS` returns `readonly unknown[]` (the honest membrane-exit boundary) —
    // `Number(x)` (param typed `any`) works on either a raw JS number or a still-boxed
    // AExact (both implement `valueOf()`, which `Number`'s coercion invokes), unlike
    // `numOf`'s `SchemeValue`-typed param.
    expect(a["arrival/toJS"]().map(Number)).toEqual([1, 2, 3]);
    expect(Array.isArray(a["arrival/toJS"]())).toBe(true);
  });
});
