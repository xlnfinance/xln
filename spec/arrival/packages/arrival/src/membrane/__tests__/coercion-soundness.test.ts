/**
 * G6 — carrier-coercion soundness (Wave A / W2).
 *
 * The claim under test: provenance must survive `map`/`filter`/`length`/`sort`
 * across ALL carriers (Pair / SchemeVector / AJSArray) with no
 * SILENT box-drop. The crossing audited is the FL-interop overlay
 * (`env/fl-interop.ts`) — the genuine interop members of the inference plane,
 * where a AJSArray (a non-AValue membrane wrapper) and the eager
 * carriers all meet the polymorphic `map`/`filter`/`length`/`reduce`.
 *
 * DR5 (pre-mortem): every assertion inspects `.provenance` DIRECTLY — never via
 * `equal?`. `structuralEqual` is representation-blind (laws/equality.law.test.ts):
 * it sees a value's content, NOT whether a provenance box was dropped, so it is
 * the wrong oracle for "did the box survive."
 *
 * Two strata of assertion, kept visibly separate:
 *
 *   1. SOUND — the box that a consumer (the teleological seal) genuinely needs
 *      survives the coercion. These are the G6 guarantees, including the one this
 *      wave REPAIRED (the `collectElements` SchemeVector gap).
 *
 *   2. RULED (R2, docs/RULINGS.md) — the container's own grouping-
 *      fact stamp used to be silently dropped by every rebuilding op (`length`/
 *      `sort`/`map`/`filter`); the R2 container structural-facts batch fixed this
 *      at the root — length-PRESERVING ops (map/sort) PROXY the container's own
 *      stamp through, length-CHANGING ops (filter) PROVENANCE a fresh derived
 *      stamp, and `length` itself reads the container's OWN flat stamp instead of
 *      deep-unioning elements (the A13 fix). Was "GOLDEN(eager-parity) —
 *      characterization, not fixed"; now the fixed, ruled behavior, asserted
 *      directly. See `_tables/terms.ts`'s `containerBox` column for the full
 *      per-term law table.
 */

import { describe, it, expect } from "vitest";
import { idContour, keepAllContour, reduceContour, contourCallback } from "../../__tests__/_contour-callback.js";
import { CONSTANT_CTX, RunContext } from "../../run/RunContext.js";
import { PortabilityError } from "../../errors.js";
import { APair } from "../../values/primitives/APair.js";
import { ABool } from "../../values/primitives/ABool.js";
import { AVector } from "../../values/primitives/AVector.js";
import { AString } from "../../values/primitives/AString.js";
import { AJSArray } from "../AJSArray.js";
import listsCap from "../../env/r7rs/lists.js";
import vectorsCap from "../../env/r7rs/vectors.js";
import { vector, schemeValue } from "../../common/scheme-zod/index.js";
import type { EnvCapability } from "../../common/capability.js";
import { nil } from "../../values/primitives/ANil.js";
import { provOf } from "../../provenance/lineage.js";
import { tf } from "../../values/tagless-final.js";
import { requireEagerOracle } from "../../__tests__/_require-eager-oracle.js";
import { harvestContracts } from "../../__tests__/_symbols-harvest.js";
import { AExact } from "../../values/primitives/AExact.js";

// Q20b: this file calls carrier ops (map/filter/length/sort) directly against
// pre-stamped fixtures, which route through op-helpers.ts's accumulation — force
// the oracle ON for the file's lifetime.
requireEagerOracle();

// Source op fns FROM THE CAPABILITY's inlined `symbols` (the bare *_OPS map was
// inlined into the constructor; the capability default export is the single
// declaration site). These packs are all the record form of `spec.symbols`.
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    Object.entries(harvestContracts(cap.spec.symbols))
      // Stage A2: the CONTRACT (native's raw `.impl`) rides `.contract` on the minted
      // ANativeProcedure now, pulled off via `harvestContracts`/`contractOf` (the shared
      // read-side seam) — same `v.impl ?? v.value` idiom as before, just off the contract.
      .map(
        ([k, v]) =>
          [
            k,
            (v as { impl?: (...a: any[]) => any; value?: (...a: any[]) => any }).impl ??
              (v as { value?: (...a: any[]) => any }).value,
          ] as const,
      )
      // A def may carry neither `impl` nor `value` (a baked bare-`Fn` def) — that's
      // not a callable op for this test's purposes, so drop it rather than admit an
      // `undefined` into the op map (honest narrowing, not a cast over the union).
      .filter((e): e is [string, (...a: any[]) => any] => e[1] !== undefined),
  );
const listOps = opsOf(listsCap); // r7rs scheme/lists — assoc lives here now

// ── DR5 helpers (provOf is the canonical one; never `equal?`) ─────────────────
/** A provenance-bearing scalar element. SchemeString so `unwrapSchemeValue` (the
 *  asyncFLMap box-strip) treats it as a real boxed value, not an inert host num. */
const el = (s: string, p: number) => new AString(s, new Set([p]));
/** Element-level provenance of a returned collection, in order — the soundness
 *  signal the seal reads (per-element grounding survives the transform). */
const elemProvs = (r: unknown): number[][] => {
  const out: number[][] = [];
  if (r instanceof APair) {
    let n: unknown = r;
    while (n instanceof APair) {
      out.push(provOf(n.car));
      n = n.cdr;
    }
  } else if (r instanceof AVector) {
    for (const e of r.__vector__) out.push(provOf(e));
  } else if (r instanceof AJSArray) {
    for (const e of r.source) out.push(provOf(e));
  } else if (Array.isArray(r)) {
    for (const e of r) out.push(provOf(e));
  }
  return out;
};
/** Awaits the FL-interop result (live ops may return a Promise). */
const force = async (r: unknown): Promise<unknown> => (r && typeof (r as any).then === "function" ? await r : r);

// idContour / keepAllContour imported from _contour-callback (W8 ACallable callbacks).
const cmp = contourCallback((args) => {
  const a = args[0] as AString;
  const b = args[1] as AString;
  // Host number verdict — deriveSortCompare's number branch (CallResult cast).
  return String(a.valueOf()).localeCompare(
    String(b.valueOf()),
  ) as unknown as import("../../values/types.js").SchemeValue;
}, "locale-cmp");

const mkPair = () => new APair(el("a", 100), new APair(el("b", 101), nil)).withProvenance(new Set([7]));
const mkVec = () => new AVector([el("a", 100), el("b", 101)], new Set([7]));
// A BORROWED array holds JS-world values only (V's hygiene law, 2026-07-14 — `JSWorldArray` in
// values/types.ts), so its elements are RAW and carry no lineage of their own. It therefore has
// exactly ONE origin — the crossing that made it — and every element inherits THAT on the way back
// in (AJSArray's Option-C discipline). Per-element ids on a borrowed array were always a fiction:
// a tool returns one JSON payload from one call, and there is no second source to attribute to.
//
// The old fixture minted `new AJSArray([el("a",100), el("b",101)])` — boxed AValues buried in a
// JS store — which production cannot construct and which `jsToScheme` would silently re-stamp anyway.
// Container id 7 matches mkPair/mkVec above; unlike those OWNED carriers, the elements share it.
const ARR_ORIGIN = 7;
const mkArr = () => new AJSArray(["a", "b"], new Set([ARR_ORIGIN]));

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND: per-element provenance survives the structure-preserving
// transforms. This is the grounding the teleological seal walks; a drop here is
// a silent hole. (Container-grouping behavior is stratum 2.)
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — element provenance survives map/filter/sort", () => {
  it("Pair · map preserves every element's box", async () => {
    expect(elemProvs(await force(mkPair()[tf("map")](idContour, CONSTANT_CTX)))).toEqual([[100], [101]]);
  });
  it("Pair · filter preserves every kept element's box", async () => {
    expect(elemProvs(await force(mkPair()[tf("filter")](keepAllContour, CONSTANT_CTX)))).toEqual([[100], [101]]);
  });
  it("Pair · sort preserves every element's box (only reorders)", async () => {
    // sort dissolved onto the term: call it directly (the fl-interop sort is now a
    // symbol.sequence dispatcher with no .impl). The term takes the optional comparator.
    expect(elemProvs(await force(mkPair()[tf("sort")](cmp, CONSTANT_CTX)))).toEqual([[100], [101]]);
  });

  it("SchemeVector · filter preserves every element's box", async () => {
    expect(elemProvs(await force(mkVec()[tf("filter")](keepAllContour, CONSTANT_CTX)))).toEqual([[100], [101]]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 1 — SOUND (REPAIRED an earlier wave): the `collectElements` SchemeVector gap.
//
// `collectElements` (used by `length`) had no SchemeVector branch — a vector
// matched none of {Pair-spine, AJSArray, raw array} and silently collected
// []. So `(length vec)` counted 0, dropping every element's provenance with NO error.
// Its twin `collapseProvenance` (provenance-collapse.ts) already walked
// `__vector__`; the two near-twin deep-walkers disagreed (pre-mortem DR6). Fixed
// by adding the symmetric SchemeVector branch.
//
// C4/A13 UPDATE (docs/RULINGS.md R2): the count no longer carries a deep
// union of the ELEMENTS' own provenance (the over-attribution the A13 golden pinned) —
// `length` now reads the CONTAINER's own flat grouping-fact stamp instead (see
// _tables/terms.ts's `containerBox` column). The gap this describe block repaired
// (length(vector) used to silently count 0) stays fixed; only the provenance the count
// carries changed shape.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 sound — collectElements over a SchemeVector (repaired)", () => {
  it("length(vector) counts every element (not 0) and carries the CONTAINER's own grounding", async () => {
    const r = await force(listOps.length(mkVec()));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    // C4: the CONTAINER's own stamp (mkVec's {7}), NOT a deep union of the elements' own
    // {100,101} — the old over-attributing design the A13 golden documented.
    expect(provOf(r)).toEqual([7]);
  });

  it("length(AJSArray) reads the CONTAINER's own stamp — mkArr's borrowed container carries {7} (the crossing's provenance), so C4's flat read surfaces it", async () => {
    const r = await force(listOps.length(mkArr()));
    expect(Number((r as { valueOf(): unknown }).valueOf())).toBe(2);
    // Hygiene law (V, 2026-07-14): mkArr() is minted `new AJSArray(["a","b"], new
    // Set([ARR_ORIGIN]))` — the CONTAINER's own top-level provenance is no longer empty (unlike
    // the old, now-illegal fixture that stamped nothing at the container level and buried boxed
    // AValues in the raw store instead). C4 reads that flat stamp directly — not a deep union of
    // the (now-unboxed, ungrounded) elements — so the count carries the container's {7}, the same
    // shape as mkVec's row above.
    expect(provOf(r)).toEqual([ARR_ORIGIN]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRATUM 2 — RULED (R2, docs/RULINGS.md): the container's own
// grouping-fact stamp is no longer silently dropped by a rebuild. C2 threads it
// explicitly: length-PRESERVING ops (map/sort) PROXY the container's own stamp
// through unchanged; length-CHANGING ops (filter) PROVENANCE a fresh derived
// stamp = union(the input container's own stamp, the decision lineage that
// changed the length — here, the surviving elements' own provenance). `length`
// itself (C4/A13) reads the container's OWN flat stamp, never the elements'
// deep union — see _tables/terms.ts's containerBox column for the full table.
// mkPair()/mkVec() are explicitly minted with container provenance {7}
// (`.withProvenance(new Set([7]))`), so these rows exercise a REAL, non-empty
// grouping fact — the golden-prov-fan fixture (an unminted `fromArray` list)
// covers the empty-stamp case instead.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 RULED (R2) — container-grouping is PROXIED (map/sort) / PROVENANCED (filter), never silently dropped", () => {
  it("Pair · length reads the CONTAINER's own grouping-fact stamp {7}, NOT the elements' union {100,101}", async () => {
    const r = await force(listOps.length(mkPair()));
    expect(provOf(r)).toEqual([7]); // C4: the container's own MINTED stamp, not a deep element union
  });

  it("Pair · sort is LENGTH-PRESERVING — PROXIES the container's own grouping-fact stamp through", async () => {
    // APair's arrival/tagless-final/sort re-cons the spine via `Pair.fromArray(_, false)` but
    // threads `withInputProvenance([this], …)` (C2) — the container's own {7} stamp survives
    // the rebuild, agreeing with AVector's sort below (P8 — ONE answer, the old divergence
    // this row used to pin is gone).
    expect(provOf(await force(mkPair()[tf("sort")](cmp, CONSTANT_CTX)))).toEqual([7]);
  });

  it("Pair · map is LENGTH-PRESERVING (PROXIES {7} through); filter is LENGTH-CHANGING (PROVENANCES a fresh union)", async () => {
    // map: the container's own {7} stamp threads through unchanged (PROXIED).
    expect(provOf(await force(mkPair()[tf("map")](idContour, CONSTANT_CTX)))).toEqual([7]);
    // filter (keepAll — nothing dropped): PROVENANCED mints union(container's own {7},
    // survivors' own {100,101}) — a fresh derived fact, not a bare passthrough of {7} alone.
    expect(provOf(await force(mkPair()[tf("filter")](keepAllContour, CONSTANT_CTX)))).toEqual([7, 100, 101]);
  });

  it("SchemeVector · map PRESERVES every element's box, rebuilding a fresh AVector [FIXED: DR4]", async () => {
    // FIXED (was the DR4 cross-out): a vector's `map` used to strip each element to its raw
    // JS value and re-present the stripped array as an AJSArray impersonator, DROPPING the
    // raw value's provenance at the raw layer. Per P8 ("one algebra, every carrier") a term's
    // box discipline cannot vary by carrier — vector-filter and pair-map already preserved
    // element boxes, so map's cross-out was the outlier. Now map mirrors APair's box-preserving
    // map: it returns a FRESH AVector holding the SAME element boxes (scheme-vector-algebra.
    // test.ts pins the Functor identity law over this box-preserving behavior).
    const r = await force(mkVec()[tf("map")](idContour, CONSTANT_CTX));

    // (a) a fresh AVector, not a cross-out impersonator.
    expect(r).toBeInstanceOf(AVector);

    // (b) every element's own box survives by reference — no re-boxing, no provenance loss.
    expect(elemProvs(r)).toEqual([[100], [101]]);

    // (c) R2/C2: map is LENGTH-PRESERVING — the container's own grouping-fact stamp {7}
    // PROXIES through (agrees with Pair · map above, P8 — one algebra, every carrier).
    expect(provOf(r)).toEqual([7]);

    const vec = r as AVector;
    expect(vec.__vector__.every((e) => e instanceof AString)).toBe(true);
    expect(vec.__vector__.map((e) => String((e as AString).valueOf()))).toEqual(["a", "b"]);
  });
});

describe("G6 sound — sort over a SchemeVector (DR4 fix: container-preserving, box-preserving)", () => {
  // FLIPPED (DR4 fix): the old overlay's `sort` had no SchemeVector branch, so a vector
  // silently fell through to nil — worse-than-throw. Now sort is dissolved onto the term:
  // AVector's arrival/tagless-final/sort returns a FRESH sorted vector, PRESERVING every
  // element's box (no unwrapForeign — this is the box-preserving reorder, not the cross-out
  // map). Container-preserving (vector→vector) by the term returning its own shape — AND
  // (R2/C2) the container's own grouping-fact stamp PROXIES through too (the claim this
  // describe's title always made, now actually asserted, not just documented).
  it("sort(vector) returns a sorted VECTOR (boxes preserved, container preserved)", async () => {
    const r = await force(mkVec()[tf("sort")](cmp, CONSTANT_CTX));
    expect(r).toBeInstanceOf(AVector);
    expect(elemProvs(r)).toEqual([[100], [101]]); // element boxes survive the reorder
    expect(provOf(r)).toEqual([7]); // R2/C2: container's own grouping-fact stamp PROXIES through
  });
  it("sort(vector) actually REORDERS (not a passthrough): reversed input comes back sorted", async () => {
    const reversed = new AVector([el("b", 101), el("a", 100)], new Set([7]));
    const r = (await force(reversed[tf("sort")](cmp, CONSTANT_CTX))) as AVector;
    expect(r.__vector__.map((e) => String((e as AString).valueOf()))).toEqual(["a", "b"]);
    expect(elemProvs(r)).toEqual([[100], [101]]); // boxes ride along through the reorder
    expect(provOf(r)).toEqual([7]); // container stamp proxies through the reorder too
  });

  // RESOLVED (was CONTESTED): a borrowed JS array is now a VECTOR — it answers the
  // sequence algebra by DELEGATING to a lazily-materialized vector (AJSArray.ts),
  // so `(map f borrowed)` works uniformly with `(map f #(...))`. This is the membrane's
  // Rosetta promise: iterate the same for real vectors and borrowed JS arrays. The
  // delegated `map` is box-preserving (DR4 fix), so the result is a FRESH AVector —
  // identical to `map` over a native vector above.
  it("map(AJSArray) delegates to the box-preserving Functor — a borrowed array answers map [RESOLVED]", async () => {
    expect(tf("map") in mkArr()).toBe(true);
    const r = await force(mkArr()[tf("map")](idContour, CONSTANT_CTX));
    expect(r).toBeInstanceOf(AVector); // box-preserving, not the cross-out impersonator
    expect((r as AVector).length).toBe(2);
    expect((r as AVector).__vector__.every((e) => e instanceof AString)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G6 TOTALITY — element-projection accessors (car/cdr/assoc) + reduce across
// carriers. The audit flagged these as ZERO-coverage cells, yet car/cdr IS the
// §5.3 element projection and the wrong-carrier silent-nil/throw is the DR4 risk.
// Characterization (run-pinned): which carriers project the box, which fall
// through to a scheme builtin that typechecks pair|nil and throws.
// ════════════════════════════════════════════════════════════════════════════
describe("G6 — element-projection (car/cdr/assoc) + reduce across carriers", () => {
  // car/cdr project ONE element — its box must survive (this IS §5.3 element
  // provenance; the golden-prov-arithmetic car/cons goldens depend on it).
  it("car(Pair) projects the head element WITH its box", async () => {
    expect(provOf(await force(mkPair()[tf("car")]()))).toEqual([100]);
  });
  it("car(AJSArray): loose projects index 0 WITH its box; strict throws (a vector is not a pair)", async () => {
    expect(tf("car") in mkArr()).toBe(true);
    expect(provOf(await force(mkArr()[tf("car")](CONSTANT_CTX)))).toEqual([ARR_ORIGIN]);
    expect(() => mkArr()[tf("car")](new RunContext({ strict: true }))).toThrow(PortabilityError);
  });
  it("cdr(Pair): the tail spine carries the remaining element's box", async () => {
    expect(elemProvs(await force(mkPair()[tf("cdr")]()))).toEqual([[101]]);
  });
  it("cdr(AJSArray): loose returns the rest as a vector (boxes preserved); strict throws", async () => {
    expect(tf("cdr") in mkArr()).toBe(true);
    expect(elemProvs(await force(mkArr()[tf("cdr")](CONSTANT_CTX)))).toEqual([[ARR_ORIGIN]]);
    expect(() => mkArr()[tf("cdr")](new RunContext({ strict: true }))).toThrow(PortabilityError);
  });
  it("assoc(key, alist): the matched pair's key + value boxes both survive", async () => {
    const alist = new APair(new APair(el("k", 100), el("v", 101)), nil);
    const found = (await force(listOps.assoc(el("k", 200), alist))) as APair<any, any>;
    expect(provOf(found.car)).toEqual([100]);
    expect(provOf(found.cdr)).toEqual([101]);
  });

  // A SchemeVector (and a borrowed AJSArray) DOES answer car/cdr now — but as a TOLERANT-LOOSE
  // reading (car → index 0 WITH its box, cdr → a vector slice). In STRICT mode the gate fires
  // (a vector is not a pair → vector-ref) — the DR4 errors-as-doors surface, now mode-gated.
  it("car(SchemeVector): loose projects index 0 WITH its box; strict throws [DR4 — not a pair]", () => {
    expect(tf("car") in mkVec()).toBe(true);
    expect(provOf(mkVec()[tf("car")](CONSTANT_CTX))).toEqual([100]);
    expect(() => mkVec()[tf("car")](new RunContext({ strict: true }))).toThrow(PortabilityError);
  });
  it("reduce(AJSArray) folds the borrowed elements via a vector [RESOLVED]", async () => {
    expect(tf("reduce") in mkArr()).toBe(true);
    const n = await force(
      mkArr()[tf("reduce")](
        reduceContour((_e, acc: number) => acc + 1),
        new AExact(0),
        CONSTANT_CTX,
      ),
    );
    expect(n).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VECTOR PROTOCOL via dispatch — `vector?` (symbol.taglessGuard) and `vector-ref`
// ask the operand's OWN arrival/tagless-final/{vector?,vector-ref} instead of the
// builtin reaching around the box with `instanceof AVector`. Both a real
// SchemeVector and a borrowed AJSArray answer; a non-vector gracefully #f (vector?)
// or throws (vector-ref). This is the Family-2 "reached around the box" dissolution.
// ════════════════════════════════════════════════════════════════════════════
const vectorSymbols = harvestContracts(vectorsCap.spec.symbols) as Record<
  string,
  { run?: (...a: unknown[]) => unknown; impl?: (...a: unknown[]) => unknown }
>;
describe("vector? / vector-ref dispatch via the tagless protocol (no instanceof reach-around)", () => {
  // R8 mint (RULINGS.md R8): taglessGuard's `run` now boxes its verdict (mintVerdict) —
  // out: z.schemeValue skips any generic codec crossing here, so this WAS the one raw-boolean
  // escape hatch a taglessGuard predicate had; `.valueOf()` reads the boxed truth.
  it("vector? (taglessGuard): a SchemeVector and a borrowed AJSArray both answer #t", async () => {
    expect(((await vectorSymbols["vector?"].run!(mkVec())) as ABool).valueOf()).toBe(true);
    expect(((await vectorSymbols["vector?"].run!(mkArr())) as ABool).valueOf()).toBe(true);
  });
  it("vector? (taglessGuard): a non-vector declares no method → graceful #f, NOT a throw", async () => {
    expect(((await vectorSymbols["vector?"].run!(mkPair())) as ABool).valueOf()).toBe(false);
    expect(((await vectorSymbols["vector?"].run!(el("x", 1))) as ABool).valueOf()).toBe(false);
  });
  it("vector-ref dispatches to the operand's method — borrowed array's element inherits the CONTAINER's provenance (no per-element id survives the raw store)", () => {
    // Hygiene law (V, 2026-07-14): mkArr()'s source is raw JS ("a","b") with no lineage of its
    // own — AJSArray.boxElement stamps every lazy read with the CONTAINER's own provenance
    // ({ARR_ORIGIN}), not a distinct per-index id. mkVec's elements are individually boxed (an
    // OWNED carrier), so index 0 still projects its own minted id.
    expect(provOf(vectorSymbols["vector-ref"].impl!(mkArr(), 1))).toEqual([ARR_ORIGIN]);
    expect(provOf(vectorSymbols["vector-ref"].impl!(mkVec(), 0))).toEqual([100]);
  });
  it("vector-ref on a non-vector throws (the operation form — unlike vector?'s #f)", () => {
    expect(() => vectorSymbols["vector-ref"].impl!(mkPair(), 0)).toThrow(/not a vector/i);
  });
  it("the whole vector family works on a borrowed array via asVector's protocol dispatch", () => {
    // vector-length boxes its count now (AExact — the scheme face of z.number's output).
    expect(Number((vectorSymbols["vector-length"].impl!(mkArr()) as { valueOf(): unknown }).valueOf())).toBe(2);
    // Hygiene law: every element materialized off a borrowed array inherits the CONTAINER's own
    // provenance ({ARR_ORIGIN}) — there is no per-element id left to carry (raw JS never had one).
    expect(elemProvs(vectorSymbols["vector->list"].impl!(mkArr()))).toEqual([[ARR_ORIGIN], [ARR_ORIGIN]]);
    expect(vectorSymbols["vector-copy"].impl!(mkArr())).toBeInstanceOf(AVector);
  });
  it("z.vector accepts a borrowed AJSArray as well as a boxed AVector (the union codec), rejects a pair", () => {
    // This assertion is the one that surfaced a LIVE, PRE-EXISTING BUG — worth recording, because it
    // is the same shape as every other defect this session.
    //
    // `z.vector` is a union of two codecs, and they used to decode into DIFFERENT WORLDS: the
    // AVector arm yielded `__vector__` (BOXED elements, which the element codec can then decode),
    // while the AJSArray arm yielded the RAW `.source`. The element schema is a SCHEME-face codec
    // (`schemeValue` demands an AValue; `z.number` demands an AExact), so raw JSON elements failed
    // validation every single time. Every `symbol.define` verb contracted on `z.vector` — SRFI-43's
    // vector-fold / vector-fold-right / vector-count / vector-index / vector-any — therefore threw a
    // raw ZodError on ANY tool-returned JSON array, while working fine on a `#(1 2 3)` literal.
    // (The vector NATIVES kept working because `symbol.native` never validates — which is exactly
    // what hid the split.)
    //
    // It stayed GREEN only because the old fixture put boxed AStrings in a borrowed `source` — a
    // value production cannot construct (the hygiene law). The single arrangement under which that
    // decode succeeded was the single arrangement that cannot exist: the illegal fixture was masking
    // the bug. The borrowed arm now decodes to `__vector__` like its sibling, so the union is
    // genuinely representation-blind and this row is true again, for the right reason.
    // Pinned end-to-end in `listalike-divergence.law.test.ts` (the vector-surface block).
    expect(vector(schemeValue).safeParse(mkArr()).success).toBe(true);
    expect(vector(schemeValue).safeParse(mkVec()).success).toBe(true);
    expect(vector(schemeValue).safeParse(mkPair()).success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRICT-MODE DIVERGENCE via the tagless methods — because each term method gets
// the run's RunContext, a loose tolerance gates itself: generic map/filter/reduce
// are R7RS/SRFI-1 LIST ops, so on a vector they work in LOOSE mode but throw a
// PortabilityError in STRICT (the R7RS-portability control). sort is NOT gated
// (SRFI-132 accepts vectors). Generalizes ANil's car/cdr nil-tolerance.
// ════════════════════════════════════════════════════════════════════════════
describe("strict mode gates generic list-ops on a vector (loose tolerates, strict explains)", () => {
  const strict = new RunContext({ strict: true });
  it("map(vector): loose works; strict throws PortabilityError pointing at vector-map", async () => {
    // loose tolerates: the box-preserving Functor returns a fresh AVector — getting a value
    // back at all is the "loose works" signal.
    expect(await force(mkVec()[tf("map")](idContour, CONSTANT_CTX))).toBeInstanceOf(AVector);
    // map is sync up to the gate → it throws synchronously, not a rejected promise
    expect(() => mkVec()[tf("map")](idContour, strict)).toThrow(PortabilityError);
    expect(() => mkVec()[tf("map")](idContour, strict)).toThrow(/vector-map/);
  });
  it("filter/reduce(vector): strict rejects them (SRFI-1 list-ops)", async () => {
    await expect(mkVec()[tf("filter")](keepAllContour, strict)).rejects.toThrow(PortabilityError);
    await expect(
      mkVec()[tf("reduce")](
        reduceContour((_e, a: number) => a),
        new AExact(0),
        strict,
      ),
    ).rejects.toThrow(PortabilityError);
  });
  it("sort(vector) is NOT gated — SRFI-132 accepts vectors", () => {
    expect(mkVec()[tf("sort")](cmp, strict)).toBeInstanceOf(AVector);
  });
  it("a borrowed AJSArray inherits the gate via delegation (strict map throws)", () => {
    expect(() => mkArr()[tf("map")](idContour, strict)).toThrow(PortabilityError);
  });
});
