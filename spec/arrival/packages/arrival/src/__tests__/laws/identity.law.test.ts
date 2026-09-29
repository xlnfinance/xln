/**
 * LAW — every spine/guard treats a provenance-bearing Nil clone as nil (P0/P8).
 *
 * Survivor of `clone-identity.test.ts` (retired in the 2026-07-09 suite
 * consolidation). The
 * war-story ledger (the original 14-site audit narrative) has moved to private docs;
 * this file carries the LIVE regression coverage
 * forward as one law, per-site, rather than a standalone top-level test file.
 *
 * Background — what the bug is and why it matters
 * -----------------------------------------------
 * `Nil` extends `AValue`, and `AValue.withProvenance(p)` returns a FRESH instance
 * (types.ts — `withProvenance(p) { return new Nil(p); }`). Every Scheme-side codepath
 * that touches a `Nil` value through the provenance machinery (most notably
 * `restrictControlFlowProvenance` in `eval/evaluator.ts`, plus the rosetta wrapper) can
 * mint a `Nil` instance that is OBSERVABLY identical to `nil` (same class, same
 * `toJs() === null`, same `toString() === "()"`) but FAILS `=== nil` because it is a
 * different heap object. `is_nil` (value-guards.ts) was fixed to `instanceof ANil`; the
 * sites below are every place once left on `=== nil` — each a place where a Nil clone
 * could slip through with the wrong answer. As of 2026-07-08 every site is re-verified
 * against current source: all are fixed EXCEPT `rosetta.ts:70`, which stays `it.fails`.
 *
 * One test per site. Each mints a nil clone via `nil.withProvenance(new Set([42]))`,
 * exercises ONLY the path gated by that site's former `=== nil` check, and asserts the
 * `is_nil`-equivalent / behavior-equivalent outcome. When `rosetta.ts:70` is fixed,
 * removing `it.fails` flips its row green — this file doubles as that migration's
 * acceptance test.
 */
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { testCallCtx } from "../../run/CallCtx.js";
import { isSchemeValue } from "../../membrane/membrane.js";
import { toJS } from "../../membrane/rosetta.js";
import listsCap from "../../env/r7rs/lists.js";
import type { EnvCapability } from "../../common/capability.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { tf } from "../../values/tagless-final.js";
import { AExact } from "../../values/primitives/AExact.js";
import { unaryContour, filterContour, reduceContour, keepAllContour } from "../_contour-callback.js";
import { harvestContracts } from "../_symbols-harvest.js";

// A nil clone carrying non-empty provenance — exactly what
// `restrictControlFlowProvenance` (evaluator.ts) hands back when an `if` arm resolves
// to nil while the predicate carries provenance. Same shape the rosetta wrapper mints
// for AValue results.
const cloneNil = (origin = 42) => nil.withProvenance(new Set<number>([origin]));

// Source op fns from the capability's inlined `symbols` — migrated packs expose
// `symbol.native` defs (`{ kind: "native", impl }`); the untagged `{ value }` form is the
// fallback for any entry not yet on the symbol.* API.
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    // Stage A2: the CONTRACT (native's raw `.impl`) rides `.contract` on the minted
    // ANativeProcedure now — `harvestContracts` pulls it off (the shared read-side seam).
    Object.entries(harvestContracts(cap.spec.symbols) as Record<string, { impl?: unknown; value?: unknown }>)
      .map(([k, v]) => [k, v.impl ?? v.value] as const)
      .filter((entry): entry is [string, (...a: any[]) => any] => typeof entry[1] === "function"),
  );
const LIST_OPS = opsOf(listsCap);

describe("nil-clone witness sanity (NOT a bug — guards the test fixture)", () => {
  it("clone is an instance of Nil", () => {
    expect(cloneNil()).toBeInstanceOf(ANil);
  });
  it("clone is_nil-true (guards.ts uses instanceof — the FIXED path)", () => {
    expect(cloneNil() instanceof ANil).toBe(true);
  });
  it("clone is NOT === nil (heap-distinct from the singleton)", () => {
    expect(cloneNil() === nil).toBe(false);
  });
  it("clone carries the supplied provenance", () => {
    expect([...cloneNil(7).provenance]).toEqual([7]);
  });
  it("clone serializes the same as nil", () => {
    expect(cloneNil()["arrival/toJS"]()).toEqual([]); // nil-as-array (V 2026-07-13)
    expect(cloneNil().toString()).toBe("()");
  });
});

describe("membrane.ts — `=== nil` identity-equality sites", () => {
  it("isSchemeValue(nil-clone) — is true (membrane.ts, instanceof AValue dispatch)", () => {
    expect(isSchemeValue(cloneNil())).toBe(true);
  });
  it("toJS(nil-clone) — is [] (membrane.ts, full protocol dispatch; nil-as-array)", () => {
    expect(toJS(cloneNil())).toEqual([]);
  });
});

describe("rosetta.ts — `=== nil` identity-equality sites", () => {
  // Both exit as JS `[]` now — toJS delegates to arrival/toJS (nil-as-array,
  // V 2026-07-13); ANil's toJS returns [] whether the clone carries provenance or
  // not, so the singleton and a clone agree.
  it("toJS(nil-clone) — returns [], same as the singleton (via arrival/toJS)", () => {
    const singletonResult = toJS(nil);
    expect(singletonResult).toEqual([]);
    expect(toJS(cloneNil())).toEqual(singletonResult);
  });

  it("toJS(Pair(1, nil-clone)) — proper list, not dotted (rosetta.ts:130)", () => {
    const p = new APair(new AExact(1), cloneNil());
    expect(toJS(p)).toEqual([1]);
  });
});

describe("list-copy (env/r7rs/lists.ts) — `=== nil` identity-equality sites", () => {
  it("list-copy(nil-clone) — does NOT alias the input by reference (env/r7rs/lists.ts)", () => {
    // `list-copy`'s impl is `function(this: CallCtx, …)` (the ctx-honesty rework,
    // arrival-constant-ctx-audit-2026-07-11.md §2.4) — bind the sanctioned test
    // door (CallCtx.ts) rather than calling the raw fn bare.
    const listCopy = LIST_OPS["list-copy"] as (this: unknown, l: unknown) => unknown;
    const input = cloneNil();
    const result = listCopy.call(testCallCtx(), input) as unknown;
    expect(result === input).toBe(false);
  });

  it("list-copy(Pair(1, nil-clone)) — tail does NOT alias the input's tail (env/r7rs/lists.ts)", () => {
    const listCopy = LIST_OPS["list-copy"] as (this: unknown, l: unknown) => unknown;
    const cdrClone = cloneNil();
    const input = new APair(new AExact(1), cdrClone);
    const result = listCopy.call(testCallCtx(), input);
    expect(result).toBeInstanceOf(APair);
    expect((result as APair<any, any>).cdr === cdrClone).toBe(false);
  });
});

describe("APair.ts tagless-final map/filter/reduce/traverse — `=== nil` identity-equality sites", () => {
  it("mapPair(f, Pair(1, nil-clone)) — produces (1) only, fn called once", async () => {
    const calls: unknown[] = [];
    const p = new APair(new AExact(1), cloneNil());
    const result = await p[tf("map")](
      unaryContour((x) => {
        calls.push(x);
        return x;
      }),
      CONSTANT_CTX,
    );
    expect(calls.map((v) => (v as AExact).valueOf())).toEqual([1]);
    expect(result).toBeInstanceOf(APair);
    expect((result as APair<any, any>).cdr instanceof ANil).toBe(true);
  });

  it("filterPair(_, Pair(1, nil-clone)) — predicate called once", async () => {
    let predCalls = 0;
    const p = new APair(new AExact(1), cloneNil());
    await p[tf("filter")](
      filterContour(() => {
        predCalls++;
        return true;
      }),
      CONSTANT_CTX,
    );
    expect(predCalls).toBe(1);
  });

  it("reducePair(f, init, Pair(1, nil-clone)) — f called once", async () => {
    const collected: unknown[] = [];
    const p = new APair(new AExact(1), cloneNil());
    // arrival/tagless-final/reduce is element-FIRST: fn(element, acc).
    await p[tf("reduce")](
      reduceContour((v, acc: unknown[]) => {
        collected.push(v);
        return [...acc, v];
      }),
      [] as unknown[],
      CONSTANT_CTX,
    );
    expect(collected.map((v) => (v as AExact).valueOf())).toEqual([1]);
  });

  it("traversePair(of, f, Pair(1, nil-clone)) — of called once for the nil base case + once per leaf wrap", () => {
    const ofCalls: unknown[] = [];
    const of = (v: unknown) => {
      ofCalls.push(v);
      return v;
    };
    const p = new APair(new AExact(1), cloneNil());
    p[tf("traverse")](of, (x: unknown) => x);
    expect(ofCalls.length).toBe(2);
    expect(ofCalls[0] instanceof ANil).toBe(true);
  });
});
