/**
 * Property-based tests for `unionProvenance` / `pointProvenance` — the
 * mathematical core of `AValue.ts:91-108`. Three loadbearing properties
 * the rest of the runtime relies on:
 *
 *   - Commutativity / associativity / idempotence — `wrapOperator` and the
 *     two `withInputProvenance` twins (the dissolved husk (then line 2046), bridge.ts:271) must
 *     produce the same provenance regardless of arg order, sub-grouping,
 *     or self-duplication. Without these, `(+ x x)` and `(+ x x x)` would
 *     produce visibly different sets at a downstream consumer.
 *
 *   - Reference-distinct dedup — when two args share the SAME provenance
 *     set BY REFERENCE, the result is that very reference (no allocation).
 *     This is the load-bearing fast path `wrapOperator` calls out: the
 *     parser-literal hot path `(+ 1 2)` allocates nothing.
 *
 *   - Empty identity — empty-provenance args contribute nothing AND the
 *     all-empty case returns `EMPTY_PROVENANCE` BY REFERENCE. Without it
 *     `wrapOperator`'s `provenance.size > 0` short-circuit and the
 *     comparison-bool boxing branch would over-allocate on the parser-
 *     literal hot path.
 *
 * fast-check seeds are deterministic — failures reproduce.
 */

import * as fc from "fast-check";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { describe, expect, it } from "vitest";

import { AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "../../values/primitives/AValue.js";
import { ABool } from "../../values/primitives/ABool.js";

/**
 * Generator: an AValue with arbitrary provenance. SchemeBool is the cheapest
 * AValue subclass to mint (no payload validation). Provenance ids are
 * non-negative integers — the real runtime mints them via `safeUuid()` but
 * the union algebra cares only about membership, not range.
 */
const arbProvenanceSet: fc.Arbitrary<ReadonlySet<number>> = fc
  .uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 6 })
  .map((ids) => (ids.length === 0 ? EMPTY_PROVENANCE : new Set(ids)));

const arbAValue: fc.Arbitrary<AValue> = fc
  .tuple(arbProvenanceSet, fc.boolean())
  .map(([prov, bool]) => new ABool(bool, prov));

/** Permute an array deterministically — used to assert order-independence. */
function permute<T>(arr: readonly T[], rng: fc.Arbitrary<number[]>): fc.Arbitrary<T[]> {
  return rng.map((keys) => {
    const indexed = arr.map((v, i) => [keys[i % keys.length] ?? i, v] as const);
    indexed.sort((a, b) => a[0] - b[0]);
    return indexed.map(([, v]) => v);
  });
}

describe("unionProvenance — algebraic properties", () => {
  it("commutative: union over any permutation of args produces the same set", () => {
    fc.assert(
      fc.property(
        fc.array(arbAValue, { minLength: 2, maxLength: 5 }),
        fc.array(fc.integer(), { minLength: 5, maxLength: 5 }),
        (args, keys) => {
          const original = unionProvenance(args);
          const indexed = args.map((v, i) => [keys[i] ?? i, v] as const);
          indexed.sort((a, b) => a[0] - b[0]);
          const permuted = unionProvenance(indexed.map(([, v]) => v));
          expect(new Set(permuted)).toEqual(new Set(original));
        },
      ),
    );
  });

  it("associative: union(a,b,c) ≡ union(union(a,b),c) ≡ union(a,union(b,c))", () => {
    fc.assert(
      fc.property(arbAValue, arbAValue, arbAValue, (a, b, c) => {
        const flat = unionProvenance([a, b, c]);
        // Wrap the partial unions in fresh AValues so they can re-enter the algebra.
        const left = new ABool(true, unionProvenance([a, b]));
        const leftAssoc = unionProvenance([left, c]);
        const right = new ABool(true, unionProvenance([b, c]));
        const rightAssoc = unionProvenance([a, right]);
        expect(new Set(leftAssoc)).toEqual(new Set(flat));
        expect(new Set(rightAssoc)).toEqual(new Set(flat));
      }),
    );
  });

  it("idempotent: union(a,a,a) has the same membership as a.provenance", () => {
    fc.assert(
      fc.property(arbAValue, (a) => {
        const result = unionProvenance([a, a, a]);
        expect(new Set(result)).toEqual(new Set(a.provenance));
      }),
    );
  });

  it("monotonic: union(a,b) ⊇ a ∧ union(a,b) ⊇ b", () => {
    fc.assert(
      fc.property(arbAValue, arbAValue, (a, b) => {
        const result = unionProvenance([a, b]);
        for (const id of a.provenance) expect(result.has(id)).toBe(true);
        for (const id of b.provenance) expect(result.has(id)).toBe(true);
      }),
    );
  });

  it("empty identity: union(x, empty) has same membership as x.provenance", () => {
    fc.assert(
      fc.property(arbAValue, (x) => {
        const empty = new ABool(false, EMPTY_PROVENANCE);
        const result = unionProvenance([x, empty]);
        expect(new Set(result)).toEqual(new Set(x.provenance));
      }),
    );
  });
});

describe("unionProvenance — reference fast paths", () => {
  // These two are not just optimizations — wrapOperator depends on `result
  // === EMPTY_PROVENANCE` style identity for the bool-boxing decision. The
  // bridge.ts:271 comment ("Empty-provenance short-circuit") names the
  // contract.
  // [impl-pinning] pins reference identity, not membership — a future rewrite of the
  // algebra could satisfy every algebraic property above while returning a fresh set here.
  it("empty fast-path: all-empty inputs return EMPTY_PROVENANCE BY REFERENCE", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 5 }), (bools) => {
        const args = bools.map((b) => new ABool(b, EMPTY_PROVENANCE));
        const result = unionProvenance(args);
        expect(result).toBe(EMPTY_PROVENANCE);
      }),
    );
  });

  // [impl-pinning] reference identity again, not membership.
  it("singleton fast-path: single distinct non-empty set returns that ref BY REFERENCE", () => {
    fc.assert(
      fc.property(
        arbProvenanceSet.filter((s) => s.size > 0),
        fc.integer({ min: 1, max: 4 }),
        (sharedSet, copies) => {
          // All AValues carry the SAME provenance reference — algebra must
          // return that exact ref, not a copy.
          const args = Array.from({ length: copies }, () => new ABool(true, sharedSet));
          const result = unionProvenance(args);
          expect(result).toBe(sharedSet);
        },
      ),
    );
  });

  // [impl-pinning] pins the dedupe-by-reference / allocate-on-merge mechanism, not a
  // behavioral property — membership is identical either way (see `monotonic` above).
  it("reference-equal sets dedupe; value-equal-but-distinct refs merge into a fresh set", () => {
    fc.assert(
      fc.property(
        arbProvenanceSet.filter((s) => s.size > 0),
        (members) => {
          // Two AValues sharing one ref → result IS that ref (singleton path).
          const sharedRef = members;
          const a1 = new ABool(true, sharedRef);
          const a2 = new ABool(false, sharedRef);
          expect(unionProvenance([a1, a2])).toBe(sharedRef);

          // Two AValues with same MEMBERS but DIFFERENT refs → distinct.size
          // is 2, so the algebra falls through to the merge branch and mints
          // a fresh Set. Membership identical, identity is NOT preserved.
          const refA = new Set(sharedRef);
          const refB = new Set(sharedRef);
          const b1 = new ABool(true, refA);
          const b2 = new ABool(false, refB);
          const merged = unionProvenance([b1, b2]);
          expect(new Set(merged)).toEqual(new Set(sharedRef));
          // The merged set is fresh — not refA, not refB, not EMPTY.
          expect(merged).not.toBe(refA);
          expect(merged).not.toBe(refB);
          expect(merged).not.toBe(EMPTY_PROVENANCE);
        },
      ),
    );
  });

  it("monotonic-size: union result size ≤ Σ|inputᵢ.provenance|", () => {
    // Upper bound only — overlapping ids collapse. The lower bound is given
    // by the `monotonic` property above.
    fc.assert(
      fc.property(fc.array(arbAValue, { maxLength: 5 }), (args) => {
        const result = unionProvenance(args);
        const sumSizes = args.reduce((acc, a) => acc + a.provenance.size, 0);
        expect(result.size).toBeLessThanOrEqual(sumSizes);
      }),
    );
  });
});

describe("pointProvenance", () => {
  it("returns a singleton set containing only the supplied callId", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (id) => {
        const result = pointProvenance(id);
        expect(result.size).toBe(1);
        expect(result.has(id)).toBe(true);
      }),
    );
  });

  it("pointProvenance(id) into unionProvenance contributes that id", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), arbAValue, (id, other) => {
        const point = new ABool(true, pointProvenance(id));
        const result = unionProvenance([point, other]);
        expect(result.has(id)).toBe(true);
      }),
    );
  });
});
