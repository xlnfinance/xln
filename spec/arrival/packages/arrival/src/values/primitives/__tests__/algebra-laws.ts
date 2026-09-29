// Property-based Fantasy Land algebra law suites — the safety harness (A2) for
// the algebras-in-entities migration (plan-2026-06-10-algebras-in-entities.md).
//
// Each value type's instance cell calls these with an `fc.Arbitrary` that
// produces instances of that type. A wrong instance = a violated law = a red
// test, caught locally in that cell. This is what LICENSES the parallel fan-out
// over the value kernel (permanent commitments): no instance lands without its
// laws green.
//
// The protocol keys are the Fantasy Land strings themselves — they ARE the spec,
// so we use them directly rather than via an indirection.
import fc from "fast-check";
import { describe, it } from "vitest";
import { tf } from "../../tagless-final.js";
import { AString } from "../AString.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { unaryContour } from "../../../__tests__/_contour-callback.js";

type FL = Record<string, any>;
const equals = (a: FL, b: FL): boolean => Boolean(a[tf("equals")](b));
const lte = (a: FL, b: FL): boolean => Boolean(a[tf("lte")](b));

// ----------------------------------------------------------------------
// Setoid — reflexive, symmetric, transitive. The `equalClone` exercises the
// provenance-clone / string-copy contract that bare `===` would miss: two
// distinct heap instances of the same value MUST compare equal.
// ----------------------------------------------------------------------
export interface SetoidArbs<T> {
  arb: fc.Arbitrary<T>;
  /** produce a DISTINCT-but-equal instance of `a` (fresh heap object). */
  equalClone?: (a: T) => T;
}

export function setoidLaws<T>(name: string, { arb, equalClone }: SetoidArbs<T>): void {
  describe(`${name} — Setoid`, () => {
    it("reflexivity: a ≡ a", () => {
      fc.assert(fc.property(arb, (a) => equals(a as FL, a as FL)));
    });
    if (equalClone) {
      it("reflexivity across a distinct-but-equal clone (provenance/string-copy)", () => {
        fc.assert(
          fc.property(arb, (a) => {
            const c = equalClone(a);
            return equals(a as FL, c as FL) && equals(c as FL, a as FL);
          }),
        );
      });
    }
    it("symmetry: (a ≡ b) === (b ≡ a)", () => {
      fc.assert(fc.property(arb, arb, (a, b) => equals(a as FL, b as FL) === equals(b as FL, a as FL)));
    });
    it("transitivity: a≡b ∧ b≡c ⇒ a≡c", () => {
      fc.assert(
        fc.property(
          arb,
          arb,
          arb,
          (a, b, c) => !(equals(a as FL, b as FL) && equals(b as FL, c as FL)) || equals(a as FL, c as FL),
        ),
      );
    });
  });
}

// ----------------------------------------------------------------------
// Ord (extends Setoid) — totality/connex, antisymmetry (vs equals), transitive,
// reflexive. Antisymmetry consults `equals`, so the type MUST be a Setoid too.
// ----------------------------------------------------------------------
export function ordLaws<T>(name: string, arb: fc.Arbitrary<T>): void {
  describe(`${name} — Ord`, () => {
    it("reflexivity: a ≤ a", () => {
      fc.assert(fc.property(arb, (a) => lte(a as FL, a as FL)));
    });
    it("totality/connex: a ≤ b ∨ b ≤ a", () => {
      fc.assert(fc.property(arb, arb, (a, b) => lte(a as FL, b as FL) || lte(b as FL, a as FL)));
    });
    it("antisymmetry: a≤b ∧ b≤a ⇒ a ≡ b", () => {
      fc.assert(
        fc.property(arb, arb, (a, b) => !(lte(a as FL, b as FL) && lte(b as FL, a as FL)) || equals(a as FL, b as FL)),
      );
    });
    it("transitivity: a≤b ∧ b≤c ⇒ a≤c", () => {
      fc.assert(
        fc.property(
          arb,
          arb,
          arb,
          (a, b, c) => !(lte(a as FL, b as FL) && lte(b as FL, c as FL)) || lte(a as FL, c as FL),
        ),
      );
    });
  });
}

// ----------------------------------------------------------------------
// Semigroup — associativity. Equality of results via the type's own `equals`.
// ----------------------------------------------------------------------
export function semigroupLaws<T>(name: string, arb: fc.Arbitrary<T>): void {
  const concat = (a: FL, b: FL): FL => a[tf("concat")](b);
  describe(`${name} — Semigroup`, () => {
    it("associativity: (a⋄b)⋄c ≡ a⋄(b⋄c)", () => {
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) =>
          equals(concat(concat(a as FL, b as FL), c as FL), concat(a as FL, concat(b as FL, c as FL))),
        ),
      );
    });
  });
}

// ----------------------------------------------------------------------
// Monoid (extends Semigroup) — left/right identity against `empty`.
// ----------------------------------------------------------------------
export function monoidLaws<T>(name: string, arb: fc.Arbitrary<T>, empty: () => T): void {
  const concat = (a: FL, b: FL): FL => a[tf("concat")](b);
  describe(`${name} — Monoid`, () => {
    it("left identity: empty ⋄ a ≡ a", () => {
      fc.assert(fc.property(arb, (a) => equals(concat(empty() as FL, a as FL), a as FL)));
    });
    it("right identity: a ⋄ empty ≡ a", () => {
      fc.assert(fc.property(arb, (a) => equals(concat(a as FL, empty() as FL), a as FL)));
    });
  });
}

// ----------------------------------------------------------------------
// Functor — identity + composition. The cell supplies element-level transforms
// `f`/`g` (the contained values' type is the cell's business) and an equality
// for the mapped structures (defaults to the type's own `equals`).
// ----------------------------------------------------------------------
export interface FunctorArbs<T, A> {
  arb: fc.Arbitrary<T>;
  f: (x: A) => A;
  g: (x: A) => A;
  /** equality on the (possibly transformed) structure; defaults to `equals`. */
  eq?: (a: T, b: T) => boolean;
}

export function functorLaws<T, A>(name: string, { arb, f, g, eq }: FunctorArbs<T, A>): void {
  // map may be async (APair/AVector await the user fn) or sync (AString char-map); await
  // covers both. eqF stays sync — it compares the already-materialized structures.
  // W8: APair/AVector take ACallable + runCtx; AString's char-map stays bare host unary.
  const map = async (x: FL, fn: (a: A) => A): Promise<FL> => {
    const term = x[tf("map")] as ((...args: unknown[]) => unknown) | undefined;
    if (term === undefined) throw new Error("functorLaws: no map term");
    if (x instanceof AString) return (await term.call(x, fn)) as FL;
    return (await term.call(
      x,
      unaryContour((el) => fn(el as A) as never),
      CONSTANT_CTX,
    )) as FL;
  };
  const eqF = eq ?? ((a: T, b: T) => equals(a as FL, b as FL));
  describe(`${name} — Functor`, () => {
    it("identity: map(id) ≡ id", async () => {
      await fc.assert(fc.asyncProperty(arb, async (a) => eqF((await map(a as FL, (x) => x)) as T, a)));
    });
    it("composition: map(f∘g) ≡ map(f)∘map(g)", async () => {
      await fc.assert(
        fc.asyncProperty(arb, async (a) => {
          const lhs = await map(a as FL, (x) => f(g(x)));
          const rhs = await map(await map(a as FL, g), f);
          return eqF(lhs as T, rhs as T);
        }),
      );
    });
  });
}
