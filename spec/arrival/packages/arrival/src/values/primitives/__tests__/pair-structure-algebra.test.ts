// Algebras-in-entities cell (wave 2): Pair's structure-algebras — Functor,
// Filterable, Foldable, Traversable, Chain, Semigroup (list-append), Monoid
// (nil identity). Migrated from the the dissolved fantasy-land bridge monkey-patch INTO the
// Pair class body (plan-2026-06-10-algebras-in-entities.md).
//
// Pair has NO `arrival/tagless-final/equals` BY DESIGN — `structuralEqual` IS its Setoid
// (a self-recursive Pair instance would loop ∞; see the matrix in the plan). So
// the law harness's internal `equals` (which calls `a["arrival/tagless-final/equals"]`)
// can't be used for Pair directly; we feed `functorLaws` an explicit
// structuralEqual `eq`, and assert Semigroup/Monoid laws directly over
// structuralEqual.
import fc from "fast-check";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { describe, expect, it } from "vitest";
import { APair } from "../APair.js";
import { ANil, nil } from "../ANil.js";
import { structuralEqual } from "../../structural-equal.js";
import { functorLaws } from "./algebra-laws.js";
import { AExact } from "../AExact.js";
import { tf, type TaglessOp } from "../../tagless-final.js";
import type { AList, AListAlike, SchemeValue } from "../../types.js";
import {
  unaryContour,
  filterContour,
  reduceContour,
  idContour,
  keepAllContour,
} from "../../../__tests__/_contour-callback.js";

type FL = Record<string, any>;

// Pairs over small integer arrays (deep=false to keep raw JS numbers, so the
// element-level transforms below are plain arithmetic). Includes the empty
// list (nil) and length up to 4 so associativity has something to bite on.
const intList = fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 4 }).map(
  (arr) =>
    APair.fromArray(
      CONSTANT_CTX,
      arr.map((n) => new AExact(n)),
      false,
    ) as AListAlike,
);

// Non-empty variant for tests that need a Pair head (Functor laws map over a
// Pair; nil has its own trivial behavior covered separately).
const nonEmptyIntList = fc.array(fc.integer({ min: -5, max: 5 }), { minLength: 1, maxLength: 4 }).map(
  (arr) =>
    APair.fromArray(
      CONSTANT_CTX,
      arr.map((n) => new AExact(n)),
      false,
    ) as APair<any, any>,
);

const eq = (a: unknown, b: unknown) => structuralEqual(a, b);

// ----------------------------------------------------------------------
// Functor — identity + composition, equality via structuralEqual.
// ----------------------------------------------------------------------
functorLaws<APair<any, any>, number>("Pair", {
  arb: nonEmptyIntList,
  f: (x) => x + 1,
  g: (x) => x * 2,
  eq,
});

// ----------------------------------------------------------------------
// Semigroup (list append) — associativity over structuralEqual. (Cannot use
// the harness `semigroupLaws`: it needs `arrival/tagless-final/equals`, which Pair
// deliberately lacks.)
// ----------------------------------------------------------------------
describe("Pair — Semigroup (list-append)", () => {
  const concat = (a: FL, b: FL) => a[tf("concat")](b);
  it("associativity: (a⋄b)⋄c ≡ a⋄(b⋄c)", () => {
    fc.assert(
      fc.property(intList, intList, intList, (a, b, c) => {
        const lhs = concat(concat(a, b), c);
        const rhs = concat(a, concat(b, c));
        return eq(lhs, rhs);
      }),
    );
  });
  it("concat preserves element order and is pure (operands untouched)", () => {
    const a = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2)], false) as APair<any, any>;
    const b = APair.fromArray(CONSTANT_CTX, [new AExact(3), new AExact(4)], false) as APair<any, any>;
    const r = a[tf("concat")](b);
    expect((r as APair<any, any>).to_array().map((v) => (v as AExact).valueOf())).toEqual([1, 2, 3, 4]);
    expect((a as APair<any, any>).to_array().map((v) => (v as AExact).valueOf())).toEqual([1, 2]);
    expect((b as APair<any, any>).to_array().map((v) => (v as AExact).valueOf())).toEqual([3, 4]);
  });
});

// ----------------------------------------------------------------------
// Monoid — nil is the identity. (Direct, same reason as Semigroup.)
// ----------------------------------------------------------------------
describe("Pair — Monoid (nil identity)", () => {
  const concat = (a: FL, b: FL) => a[tf("concat")](b);
  // "empty" is declared on Pair/Vector/String but NOT in the canonical TaglessOp union today —
  // the `as TaglessOp` cast reaches the algebra method.
  const empty = () => APair[tf("empty" as TaglessOp)]() as ANil;
  // [impl-pinning] pins that empty() is the nil SINGLETON (===), not merely nil-equal.
  it("Pair['arrival/tagless-final/empty']() is nil", () => {
    expect(empty()).toBe(nil);
  });
  it("right identity: a ⋄ empty ≡ a", () => {
    fc.assert(fc.property(intList, (a) => eq(concat(a, empty()), a)));
  });
  it("left identity: empty ⋄ a ≡ a (nil's own concat is the identity)", () => {
    // nil['arrival/tagless-final/concat'](a) === a — Nil is the list-monoid identity
    // (declared in types.ts alongside Pair's list-append).
    fc.assert(fc.property(intList, (a) => eq(concat(empty(), a), a)));
  });
});

// ----------------------------------------------------------------------
// Foldable — behavioral. reduce sums a list; empty folds to the seed.
// ----------------------------------------------------------------------
describe("Pair — Foldable (reduce)", () => {
  it("reduce sums elements left-to-right", async () => {
    const list = APair.fromArray(
      CONSTANT_CTX,
      [new AExact(1), new AExact(2), new AExact(3), new AExact(4)],
      false,
    ) as APair<any, any>;
    // arrival/tagless-final/reduce is element-FIRST: fn(element, acc).
    const sum = await list[tf("reduce")](
      reduceContour((x, acc: number) => acc + (x as AExact).valueOf()),
      0,
      CONSTANT_CTX,
    );
    expect(sum).toBe(10);
  });
  it("reduce collects in order", async () => {
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)], false) as APair<any, any>;
    // element-FIRST fn(element, acc): append the element onto the accumulator, in order.
    const collected = await list[tf("reduce")](
      reduceContour((x, acc: number[]) => [...acc, (x as AExact).valueOf()]),
      [] as number[],
      CONSTANT_CTX,
    );
    expect(collected).toEqual([1, 2, 3]);
  });
  // [impl-pinning] pins zero fn calls over the sentinel, not just the returned value.
  it("reduce on empty-pair sentinel returns the seed (no phantom element)", async () => {
    let calls = 0;
    // element-FIRST fn(element, acc); the sentinel never calls fn, so the seed is returned.
    // @ts-expect-error empty-pair sentinel: car is undefined (not a SchemeValue) by design
    const r = await new APair(undefined, nil)[tf("reduce")](
      reduceContour((_element, acc: string) => {
        calls++;
        return acc;
      }),
      "SEED",
      CONSTANT_CTX,
    );
    expect(calls).toBe(0);
    expect(r).toBe("SEED");
  });
});

// ----------------------------------------------------------------------
// Filterable — behavioral. keeps evens; sentinel short-circuits.
// ----------------------------------------------------------------------
describe("Pair — Filterable (filter)", () => {
  it("filter keeps evens", async () => {
    const list = APair.fromArray(
      CONSTANT_CTX,
      [new AExact(1), new AExact(2), new AExact(3), new AExact(4), new AExact(5), new AExact(6)],
      false,
    ) as APair<any, any>;
    const evens = (await list[tf("filter")](
      filterContour((x) => (x as AExact).valueOf() % 2 === 0),
      CONSTANT_CTX,
    )) as APair<any, any>;
    expect(evens.to_array().map((v) => (v as AExact).valueOf())).toEqual([2, 4, 6]);
  });
  it("filter all-false yields nil", async () => {
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(3), new AExact(5)], false) as APair<any, any>;
    const r = await list[tf("filter")](
      filterContour(() => false),
      CONSTANT_CTX,
    );
    expect(r).toBe(nil);
  });
  // [impl-pinning] pins that the predicate is never invoked over the sentinel.
  it("filter on empty-pair sentinel does not call the predicate", async () => {
    let calls = 0;
    // @ts-expect-error empty-pair sentinel: car is undefined (not a SchemeValue) by design
    await new APair(undefined, nil)[tf("filter")](
      filterContour(() => {
        calls++;
        return true;
      }),
      CONSTANT_CTX,
    );
    expect(calls).toBe(0);
  });
});

// ----------------------------------------------------------------------
// Traversable — behavioral. Over a leaf-mode `of` (no applicative ap), traverse
// wraps each element. We use an array-applicative-free `of = (x)=>x` so the
// structure is rebuilt as nested Pairs (matches the monkey-patch's of-leaf path).
// ----------------------------------------------------------------------
describe("Pair — Traversable (traverse)", () => {
  // [impl-pinning] pins the exact of-call count (base case + one per element), not
  // just "each element visited".
  it("traverse with identity-of visits each element once, terminating at nil", () => {
    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2)], false) as APair<any, any>;
    list[tf("traverse")](of, (x: unknown) => x);
    // base case of(nil) + one of(new Pair(...)) per element (leaf path) = 1 + 2.
    expect(ofCalls.length).toBe(3);
    // last-built base case wrapped nil
    expect(ofCalls.some((v) => v instanceof ANil)).toBe(true);
  });
  it("traverse over an applicative (array) sequences effects", () => {
    // mappedCar carries arrival/tagless-final/ap → traverse uses ap to combine.
    // Use a minimal Identity-like applicative: { value, 'arrival/tagless-final/ap' }.
    const Id = (value: unknown) => ({
      value,
      [tf("ap")](other: any) {
        // this holds a function-or-value; for traverse, `this` wraps the head
        // and `other` wraps the rest — combine into a Pair.
        // @ts-expect-error `this` is untyped in this mock applicative
        return Id(new APair(this.value, other.value));
      },
    });
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)], false);
    // @ts-expect-error traverse result is the mock applicative, not a SchemeValue
    const result = list[tf("traverse")](
      (v: unknown) => Id(v),
      (x: unknown) => Id(x),
    ) as unknown as { value: unknown };
    expect((result.value as APair<any, any>).to_array().map((v) => (v as AExact).valueOf())).toEqual([1, 2, 3]);
  });
});

// ----------------------------------------------------------------------
// Applicative `of` — single-element list.
// ----------------------------------------------------------------------
describe("Pair — Applicative (static of)", () => {
  // [impl-pinning] pins the concrete Pair(x, nil) shape, not just list membership.
  it("of(x) is a one-element list (x)", () => {
    // "of" is declared on Pair/Vector/String but NOT in the canonical TaglessOp union today —
    // the `as TaglessOp` cast reaches the algebra method.
    const p = APair[tf("of" as TaglessOp)](new AExact(42)) as APair<any, any>;
    expect(p).toBeInstanceOf(APair);
    expect((p.car as AExact).valueOf()).toBe(42);
    expect(p.cdr).toBe(nil);
  });
});

// ----------------------------------------------------------------------
// Provenance-clone termination — the recursors stop on `instanceof Nil`, not
// `=== nil`, so a provenance-bearing Nil clone in tail position terminates
// cleanly (no phantom element). Guards the wave-2 invariant.
// ----------------------------------------------------------------------
describe("Pair — recursors terminate on Nil clones (provenance)", () => {
  const cloneNil = () => nil.withProvenance(new Set<number>([42]));
  // [impl-pinning] pins fn-called-once and result.cdr's exact instanceof-Nil shape.
  it("map(Pair(1, nil-clone)) → (1), fn called once", async () => {
    // fn receives the pair's actual boxed element (map never auto-unboxes) — the identity
    // fn hands back the SAME AExact instance, so the result pair's car is that instance.
    const calls: unknown[] = [];
    const one = new AExact(1);
    const r = (await new APair(one, cloneNil())[tf("map")](
      unaryContour((x) => {
        calls.push(x);
        return x;
      }),
      CONSTANT_CTX,
    )) as APair<any, any>;
    expect(calls).toEqual([one]);
    expect(r.car).toBe(one);
    expect(r.cdr).toBeInstanceOf(ANil);
  });
  it("reduce(Pair(1, nil-clone)) folds one element", async () => {
    // `x` is the boxed AExact — unwrap via valueOf() (a JS number) before folding, never mix
    // it directly with a bigint accumulator (AExact.valueOf() returns number, not bigint).
    const r = await new APair(new AExact(1), cloneNil())[tf("reduce")](
      reduceContour((x, acc: number) => acc + (x as AExact).valueOf()),
      0,
      CONSTANT_CTX,
    );
    expect(r).toBe(1);
  });
});
