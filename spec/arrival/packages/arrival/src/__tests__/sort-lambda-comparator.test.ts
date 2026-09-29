// S1 (the manifold benchmark-defect register, private monorepo docs) — `sort` with a
// lambda comparator was SILENTLY WRONG, the worst defect in the 89x2 benchmark audit.
//
// `deriveSortCompare` (values/op-helpers.ts) invokes the comparator through `applyCallback`
// and reads its return value synchronously (`typeof v === "number"` / `v instanceof
// AExact|AInexact` / `is_false(v)`). A Scheme LAMBDA comparator's settled value is a
// **Promise** (lambda bodies run through the trampolined async evaluator, unlike a native
// procedure) — none of those three checks recognize a Promise, so every branch fell through
// to the `is_false(Promise)` ternary's #f-arm, minting a CONSTANT -1 verdict for EVERY pair
// regardless of the comparator's actual direction. `Array.prototype.sort` then emits a
// deterministic wrong order (= reverse(input)) with NO error at all, and `<` vs `>`
// comparators produced byte-identical (wrong) output in the benchmark corpus.
//
// FIX SHIPPED (this tranche): the INTERIM honest door, not the full async rework. Full async
// threading would need `sort`'s term algebra (APair/AVector's own
// `arrival/tagless-final/sort`) to return `MaybePromise<AListAlike>` end to end, the same
// MaybePromise convention `map`/`filter` already use (call every comparator eagerly, detect
// `is_promise`, `Array.prototype.sort` cannot itself take an async comparator so a real fix
// needs a custom async-aware sort algorithm) — a Wave-4-sized change, not a same-tranche fix.
// Per the register's own ruling: "if async threading proves too invasive for one tranche,
// ship the INTERIM: throw an honest door... NEVER leave the silent path." A lambda comparator
// now throws `AsyncSortComparatorError` the first time its call settles to a Promise, instead
// of silently mis-sorting.
import { describe, expect, it } from "vitest";
import { execStateOverFrame as execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { toJS } from "../membrane/rosetta.js";

const run = (code: string) => execState(code, { env: inferenceEnv.child("sort-lambda-comparator") });

describe("S1 — sort with a lambda comparator throws instead of silently mis-sorting", () => {
  it("a lambda comparator throws an honest, named door (never silently reorders)", async () => {
    await expect(run("(sort (list 3 1 2) (lambda (a b) (< a b)))")).rejects.toThrow(/comparator/i);
  });

  it("BOTH `<` and `>` lambda comparators throw — direction never silently collapses to one verdict", async () => {
    // Pre-fix, both of these silently returned the SAME (wrong) byte-identical array —
    // the smoking gun from the benchmark corpus (`scm-longcat89f/…c8d6.scm`). Post-fix,
    // both throw instead of returning anything at all — the class is closed either way,
    // not just this one direction.
    await expect(run("(sort (list 3 1 2) (lambda (a b) (< a b)))")).rejects.toThrow();
    await expect(run("(sort (list 3 1 2) (lambda (a b) (> a b)))")).rejects.toThrow();
  });

  it("a NATIVE comparator (never a Promise) is unaffected — sorts correctly, no door", async () => {
    // `<` passed bare (not wrapped in a lambda) resolves synchronously through
    // `applyCallback` (a native/rosetta procedure, not a trampolined lambda body) — the
    // door is specific to the async (lambda) path, not comparator-bearing sort in general.
    const { values } = await run("(sort (list 3 1 2) <)");
    expect(toJS(values[0], {})).toEqual([1, 2, 3]);
  });

  it("no comparator at all still sorts by the elements' own total order (unaffected)", async () => {
    const { values } = await run("(sort (list 3 1 2))");
    expect(toJS(values[0], {})).toEqual([1, 2, 3]);
  });
});
