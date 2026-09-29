/**
 * Fuzz harness for the provenance algebra — invariant maintenance on
 * synthetic AValue trees built directly through the algebra (no parser, no
 * evaluator). The same properties proved in provenance-algebra.property.test.ts
 * must hold even at multi-level depth.
 *
 * Split from src/__tests__/evaluator-provenance.fuzz.test.ts (that file keeps
 * the evaluator crash-safety half — a distinct concern, unrelated fuzz
 * scaffolding). Fuzz is exploratory by design — when this finds a real
 * invariant break, the failing seed reproduces deterministically (vitest
 * prints the fast-check shrunk counter-example). Promote any reproducible
 * bug into provenance-algebra.property.test.ts as a named, .fails-tagged
 * case.
 */

import * as fc from "fast-check";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { describe, expect, it } from "vitest";

import { AValue, EMPTY_PROVENANCE, unionProvenance } from "../../values/primitives/AValue.js";
import { ABool } from "../../values/primitives/ABool.js";

describe("fuzz — provenance algebra invariants at depth", () => {
  // Build random N-level union trees by treating `unionProvenance` results
  // as fresh AValue children for the next level. Any single-level invariant
  // proved in property.test.ts should hold across the full nested tree —
  // associativity and idempotence guarantee it, this asserts the guarantee
  // numerically.
  it("nested-union round-trip: flattened ids == set union of leaf ids", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), { maxLength: 4 }), { minLength: 1, maxLength: 5 }),
        (leafSets) => {
          // Round-trip 1: union all leaves at once.
          const flatLeaves = leafSets.map((ids) => new ABool(true, new Set(ids)));
          const flatResult = unionProvenance(flatLeaves);

          // Round-trip 2: pairwise-fold through wrapped AValues.
          let acc: AValue = new ABool(true, EMPTY_PROVENANCE);
          for (const ids of leafSets) {
            const leaf = new ABool(false, new Set(ids));
            acc = new ABool(false, unionProvenance([acc, leaf]));
          }

          // Both routes must agree on membership — associativity is what
          // makes the runtime free to choose either depending on evaluation
          // order (currying, partial application, generator vs legacy evaluator).
          expect(new Set(acc.provenance)).toEqual(new Set(flatResult));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("nested-union idempotence: re-unioning a result through itself is a no-op", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), { maxLength: 6 }), (ids) => {
        const seed = new ABool(true, ids.length === 0 ? EMPTY_PROVENANCE : new Set(ids));
        const once = unionProvenance([seed]);
        const twice = unionProvenance([new ABool(true, once), new ABool(true, once)]);
        expect(new Set(twice)).toEqual(new Set(once));
      }),
      { numRuns: 50 },
    );
  });
});
