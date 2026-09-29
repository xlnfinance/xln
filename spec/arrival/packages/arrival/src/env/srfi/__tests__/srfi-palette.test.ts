// Unified SRFI palette — assemble each capability onto a real env and run one verb.
import { toJS } from "../../../membrane/rosetta.js";
import { execOverFrame, execStateOverFrame } from "../../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { describe, expect, it } from "vitest";
import type { EnvCapability } from "../../../common/capability.js";
import * as z from "../../../common/scheme-zod/index.js";
import { ZodTuple, type ZodOptional, type ZodTypeAny } from "zod";
import type { SequenceSymbolDef } from "../../../common/symbols/_bake.js";
import type { ANativeProcedure } from "../../../values/primitives/ANativeProcedure.js";
import core from "../../core/core.js";
import { allSrfi } from "../index.js";
import srfi1 from "../srfi-1.js";
import srfi13 from "../srfi-13.js";
import srfi26 from "../srfi-26.js";
import srfi43 from "../srfi-43.js";
import srfi95 from "../srfi-95.js";
import srfi128 from "../srfi-128.js";
import srfi189 from "../srfi-189.js";
import srfi2 from "../srfi-2.js";
import srfi8 from "../srfi-8.js";
import srfi235 from "../srfi-235.js";

/** Assemble one capability onto a fresh env; return a `(num src)` runner. `scheme/core` is
 *  folded in ALONGSIDE (never as the capability's OWN declared dep — see srfi-26.ts's header
 *  for why `core` can't be a real `deps` edge without repositioning `BASE_PACKS`'s "precedence
 *  floor"): `gensym` (used by srfi-26/srfi-2's `defineSyntax` transformers) is otherwise only
 *  available through `BASE_PACKS`'s own positional guarantee, which this per-pack STANDALONE
 *  fixture doesn't have. */
async function withCap(cap: EnvCapability, name: string) {
  const env = sandboxedEnv.child(name);
  await applyCapability(env, [cap, core]);
  return async (src: string) => Number((await execOverFrame(src, { env }))[0]);
}

describe("@inhuman.tools/arrival/srfi", () => {
  it("SRFI-1 list library", async () => {
    const num = await withCap(srfi1, "s1");
    expect(await num("(length+ (list 1 2 3 4))")).toBe(4);
  });
  it("SRFI-13 string library", async () => {
    const num = await withCap(srfi13, "s13");
    expect(await num('(string-index "abc" #\\b)')).toBe(1);
  });
  it("SRFI-43 vectors", async () => {
    const num = await withCap(srfi43, "s43");
    expect(await num("(vector-count odd? (vector 1 2 3 4 5))")).toBe(3);
  });
  it("SRFI-189 Maybe/Either", async () => {
    const num = await withCap(srfi189, "s189");
    expect(await num("(maybe-ref (just 7))")).toBe(7);
  });
  it("SRFI-128 comparators", async () => {
    const num = await withCap(srfi128, "s128");
    expect(await num("(if (=? (make-default-comparator) 1 1) 1 0)")).toBe(1);
  });
  it("SRFI-26 cut/cute", async () => {
    const num = await withCap(srfi26, "s26");
    expect(await num("((cut + 1 <>) 5)")).toBe(6);
  });
  it("SRFI-8 receive is a multi-return purity door", async () => {
    const env = sandboxedEnv.child("s8");
    await applyCapability(env, [srfi8]);
    await expect(execOverFrame("(receive 1 2)", { env })).rejects.toThrow(
      /multiple-value returns are omitted|continuation arity|not available/,
    );
  });
  it("SRFI-2 and-let* (define-syntax — may not survive the sandbox)", async () => {
    const num = await withCap(srfi2, "s2");
    expect(await num("(and-let* ((x 5)) (+ x 1))")).toBe(6);
  });

  it("SRFI-235 combinators (constantly / always / never)", async () => {
    const num = await withCap(srfi235, "s235");
    expect(await num("((constantly 7) 1 2 3)")).toBe(7);
    // always is SRFI-235 (always #t), not an alias of constantly
    expect(await num("(if (always 1 2 3) 1 0)")).toBe(1);
    expect(await num("(if (never 1 2 3) 1 0)")).toBe(0);
  });

  it("allSrfi exposes the whole set (sanity: exactly 13 SRFI packs — the scope this fix must cover)", () => {
    expect(allSrfi).toHaveLength(13);
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-1");
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-13");
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-95");
    expect(allSrfi.map((c) => c.name)).toContain("scheme/srfi-235");
  });
});

// SRFI-1 positional head accessors (first … tenth), added to srfi-1.ts. `last` /
// `last-pair` already lived in the pack, so they are exercised here only for
// completeness (1-element + improper/dotted list) — the new symbols are first…tenth.
// Assembles srfi-1 EXPLICITLY (the accessors are not registered globally this round).
describe("@inhuman.tools/arrival/srfi-1 — positional accessors", () => {
  async function accEnv() {
    const env = sandboxedEnv.child(`s1acc-${Math.random().toString(36).slice(2)}`);
    await applyCapability(env, [srfi1]);
    const num = async (src: string) => Number((await execOverFrame(src, { env }))[0]);
    const raw = (src: string) => execOverFrame(src, { env });
    return { num, raw };
  }

  it("first … tenth pick the nth element of a proper list", async () => {
    const { num } = await accEnv();
    const xs = "(list 10 20 30 40 50 60 70 80 90 100)";
    expect(await num(`(first ${xs})`)).toBe(10);
    expect(await num(`(second ${xs})`)).toBe(20);
    expect(await num(`(third ${xs})`)).toBe(30);
    expect(await num(`(fourth ${xs})`)).toBe(40);
    expect(await num(`(fifth ${xs})`)).toBe(50);
    expect(await num(`(sixth ${xs})`)).toBe(60);
    expect(await num(`(seventh ${xs})`)).toBe(70);
    expect(await num(`(eighth ${xs})`)).toBe(80);
    expect(await num(`(ninth ${xs})`)).toBe(90);
    // exact boundary — tenth of a 10-element list is the last element.
    expect(await num(`(tenth ${xs})`)).toBe(100);
  });

  it("errors when the list is too short for the requested position", async () => {
    const { raw } = await accEnv();
    await expect(raw("(third (list 1 2))")).rejects.toThrow(/third: list has fewer than 3/);
    await expect(raw("(tenth (list 1 2 3 4 5 6 7 8 9))")).rejects.toThrow(/tenth: list has fewer than 10/);
    await expect(raw("(first '())")).rejects.toThrow(/first: list has no elements/);
  });

  it("returns the element AS-IS (nested structure preserved, no re-stamp)", async () => {
    const { num } = await accEnv();
    // second element is itself a list; taking its car proves it was returned intact.
    expect(await num("(car (second (list 1 (list 7 8) 3)))")).toBe(7);
  });

  it("last / last-pair on a 1-element list", async () => {
    const { num } = await accEnv();
    expect(await num("(last (list 42))")).toBe(42);
    expect(await num("(car (last-pair (list 42)))")).toBe(42);
    // the last pair's cdr of a proper 1-element list is the empty list.
    expect(await num("(if (null? (cdr (last-pair (list 42)))) 1 0)")).toBe(1);
  });

  it("last / last-pair on an improper (dotted) list — SRFI-1 semantics", async () => {
    const { num } = await accEnv();
    // last-pair of (1 2 . 3) is (2 . 3); last is its car.
    expect(await num("(last (cons 1 (cons 2 3)))")).toBe(2);
    expect(await num("(car (last-pair (cons 1 (cons 2 3))))")).toBe(2);
    expect(await num("(cdr (last-pair (cons 1 (cons 2 3))))")).toBe(3);
  });
});

// SRFI-95 `sort` — contract ELEMENT PRECISION. `sort` is a `symbol.sequence` (ctx-aware,
// term-dispatched): its impl signature is fixed `(args: unknown[], runCtx) => unknown`
// regardless of the contract (bakeSequence/sequence.ts never thread I/O through `Impl<I,O>`
// the way native/rosetta do), and the runtime harvest printer (schema-to-ts.ts) currently
// degrades EVERY unregistered `z.custom` schema to "unknown" (same as `z.unknown()`) — so
// neither the impl body nor `printType`/`signatureOf` can observe this fix. The only place
// the precision is provable is the schema TREE itself, introspected via zod v4's PUBLIC
// `.type` / `.def` / `.unwrap()` (the same style schema-to-ts.ts already uses internally).
function bakedSort(): SequenceSymbolDef {
  const symbols = srfi95.spec.symbols;
  // srfi-95.ts declares `symbols` as a plain record (not the activation-builder
  // function form), and `sort` as `symbol.sequence`. `symbol.sequence` mints the
  // ANativeProcedure directly — its contract (the SequenceSymbolDef this test
  // introspects) rides `.contract` on it.
  return (symbols as Record<string, ANativeProcedure>).sort.contract as SequenceSymbolDef;
}

/** `.def` (schemas.d.ts's `ZodType` interface) is public on every zod schema, but its
 *  STATIC type only gains `.items` once TS knows the concrete subtype is a tuple —
 *  `instanceof ZodTuple` (also a real, public zod v4 export) is the honest narrowing. */
function tupleItems(schema: ZodTypeAny): readonly ZodTypeAny[] {
  if (!(schema instanceof ZodTuple)) throw new Error("bakedSort: expected a zod tuple schema");
  // Cast: bare `instanceof ZodTuple` narrows to the class's DEFAULT generic (core's minimal
  // `$ZodType`), not `ZodTypeAny` (classic) — even though every item here IS a real classic
  // schema (srfi95 builds this tuple via z.tuple()'s classic builders throughout).
  return schema.def.items as readonly ZodTypeAny[];
}

describe("SRFI-95 sort — contract element precision", () => {
  it("declares the receiver as the representation-blind SCHEME identity (z.schemeValue), not host-blind z.unknown()", () => {
    const items = tupleItems(bakedSort().in);
    // Reference-identity (not just shape) — z.schemeValue is the shared module singleton, so this
    // proves the FILE chose it deliberately, not merely "some schema that happens to accept anything".
    expect(items[0]).toBe(z.schemeValue);
  });

  it("declares the comparator (less?) as a callable predicate schema, not z.unknown()", () => {
    const items = tupleItems(bakedSort().in);
    const comparator = items[1];
    expect(comparator.type).toBe("optional");
    // AValue.ts's single-source-of-truth member signature is
    // `(comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): SchemeValue`
    // (deriveSortCompare, op-helpers.ts, matches exactly) — a callable, never bare `unknown`.
    // Narrow to call `.unwrap()`: the assertion just above is the runtime proof it's optional.
    expect((comparator as ZodOptional<ZodTypeAny>).unwrap().type).toBe("custom");
  });

  it("declares the output as the representation-blind scheme identity (z.schemeValue), matching the receiver algebra's declared SchemeValue return", () => {
    const items = tupleItems(bakedSort().out);
    expect(items[0]).toBe(z.schemeValue);
  });
});

describe("SRFI-95 sort — end-to-end behavior (previously uncovered via the builtin dispatch)", () => {
  async function sortEnv() {
    const env = sandboxedEnv.child(`s95-${Math.random().toString(36).slice(2)}`);
    await applyCapability(env, [srfi95]);
    // execState (COMPLEX tier): toJS wants BOXED values — `exec` already unwraps.
    return async (src: string) => (await execStateOverFrame(src, { env })).values;
  }

  it("sorts a list by the elements' own total order (no comparator) — list in, list out", async () => {
    const raw = await sortEnv();
    const [result] = await raw("(sort (list 3 1 2))");
    expect(toJS(result, {})).toEqual([1, 2, 3]);
  });

  it("sorts a vector, container-preserving — vector in, vector out", async () => {
    const raw = await sortEnv();
    const [result] = await raw("(sort (vector 3 1 2))");
    expect(toJS(result, {})).toEqual([1, 2, 3]);
  });

  // A Scheme LAMBDA comparator cannot drive `Array.sort`: the lambda evaluates through
  // the trampoline, so `applyCallback` returns a Promise, and `Array.sort`'s comparator
  // contract is synchronous. `deriveSortCompare` (values/op-helpers.ts) invokes the
  // comparator through the sanctioned `applyCallback` seam (the earlier "bare
  // `comparator(a, b)`" call-site bug is FIXED), then DOORS the async result with a
  // teaching TypeError instead of silently mis-ordering. Native callable comparators
  // (`<`, `>`, a `symbol.native`/`tagless` bound op) work — their `applyCallback` result
  // is synchronous; only an `ALambda` comparator hits this door.
  //
  // The door itself (lambda comparator throws) is pinned in
  // src/__tests__/sort-lambda-comparator.test.ts with both `<` and `>` — not duplicated
  // here. Supporting lambda comparators is real feature work (a sync lambda eval path,
  // or an async sort). The IDEAL row below stays `it.fails` until that lands.
  it.fails("IDEAL: a lambda less? comparator sorts descending (needs async sort)", async () => {
    const raw = await sortEnv();
    const [result] = await raw("(sort (list 1 3 2) (lambda (a b) (> a b)))");
    expect(toJS(result, {})).toEqual([3, 2, 1]);
  });
});
