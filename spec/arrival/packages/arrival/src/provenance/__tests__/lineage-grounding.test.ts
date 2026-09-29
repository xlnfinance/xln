/**
 * Gsec — the per-value GROUNDING invariant (mechanism-1), in PURE arrival.
 *
 * THE CORE SECURITY GATE the provenance migration must not break. Hermetic: no
 * sift, no sift evidence env, no live model — a rosetta fake source mints
 * deterministically. (sift's `leafGrounded`/`checkSignable` seal in
 * sift-submission/ is an APPLIED/downstream consumer being ejected; it is NOT a
 * core gate. But the SUBSTRATE the seal stands on IS a core invariant, and that
 * substrate is pinned here so a future `merge`-barrier corruption or an `AValue`
 * flip is caught in core CI without sift.)
 *
 * THE INVARIANT (mechanism-1 — the per-value `AValue.provenance` Set, the eager
 * stamp read by `provOf`, fed to the serializer's `size===0` cache key, ~64 stamp
 * sites): every value's LEAVES carry a per-value provenance Set, and grounding is
 * decided PER LEAF —
 *   - a bare literal / input leaf has EMPTY provenance (`size === 0` — UNgrounded);
 *   - a source-derived leaf has NON-EMPTY provenance (`size > 0` — GROUNDED).
 *
 * Why PER-LEAF, not the unioned cone: `provOf` / `deepProvenance` UNION every leaf
 * (`deep-provenance.ts`), so a partial fabrication — one real leaf beside one
 * fabricated literal — reads as GROUNDED at the top level (the union is non-empty)
 * while one of its leaves is a bare literal. The seal grounds PER LEAF over the
 * runtime value tree for exactly this reason. The property a `merge`-barrier
 * corruption would break is the partial case: flatten the structure's provenance to
 * one set and the literal leaf is no longer distinguishable from the source leaf —
 * laundered. So this file walks the Pair spine itself and asserts each leaf's OWN
 * `provenance.size`, never the union. (No per-leaf helper exists — `deepProvenance`
 * unions; this walk is the per-leaf analogue.)
 *
 * SOURCE-MINT MECHANISM (the hermetic stand-in for a Rosetta-IN crossing): a
 * `symbol.rosetta` with a host fn whose `fn` returns an already-STAMPED AValue. A
 * registered rosetta defaults to a Rosetta-IN SOURCE; returning a stamped value
 * makes "data is born at the membrane" observable deterministically without a live
 * model — the same fixture shape as golden-prov-infer.test.ts. The mint id values
 * are arbitrary-but-fixed; the INVARIANT under test is the grounded/ungrounded
 * SHAPE per leaf, not the id values.
 */
import { describe, it, expect } from "vitest";
import { is_nil, is_pair } from "../../values/value-guards.js";
import { AValue } from "../../values/primitives/AValue.js";
import { sStr, runRaw, type EnvSetup } from "../../__tests__/_lineage-test-helpers.js";
import { ANil } from "../../values/primitives/ANil.js";
import { APair } from "../../values/primitives/APair.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";

// Fixed mint ids — stand-ins for "whatever the membrane minted at this crossing".
const MINT_A = 500;
const MINT_B = 600;

// Deterministic fake sources, wired via a test-local `EnvCapability`; see
// golden-prov-infer.test.ts's `inferSources` for the full WORLD-FLIP REBASELINE
// rationale (ruling 2026-08-13): a rosetta impl may no longer return an already-
// stamped AValue, so a fixture minting its OWN stamps is a `symbol.native` with
// `z.schemeValue` slots — no membrane, no auto-mint, the custom stamp survives by
// construction. `provenance: "source"` keeps the source role the old rosetta
// defaulted to (mint-on-invocation; no pure-pipe).
const sources: EnvSetup = async (env) => {
  const cap = EnvCapability.define("test/grounding-sources", {
    symbols: (symbol, z) => ({
      "source-a": symbol.native`source-a: fake source (A)`(
        { input: [z.schemeValue], output: [z.schemeValue], provenance: "source" },
        () => sStr("SRC-A", MINT_A),
      ),
      "source-b": symbol.native`source-b: fake source (B)`(
        { input: [z.schemeValue], output: [z.schemeValue], provenance: "source" },
        () => sStr("SRC-B", MINT_B),
      ),
    }),
  });
  await applyCapability(env, [cap]);
};

/**
 * Per-leaf grounding sizes of a value, in spine order. Walks the Pair spine
 * ourselves (the per-leaf analogue of the UNIONING `deepProvenance`) and records
 * each DATA leaf's OWN `provenance.size`. The list spine's terminating `nil` is a
 * structural cell, not a data leaf, so it is skipped — we assert on the values the
 * structure carries, not the cons machinery. A non-AValue (raw JS) counts as a
 * size-0 (ungrounded) leaf: an unstamped value is exactly the ungrounded case.
 */
function leafGroundingSizes(v: unknown, out: number[] = []): number[] {
  if (v instanceof APair) {
    leafGroundingSizes(v.car, out);
    leafGroundingSizes(v.cdr, out);
    return out;
  }
  if (v instanceof ANil) return out; // structural list terminator — not a data leaf
  out.push(v instanceof AValue ? v.provenance.size : 0);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) SCALAR GROUNDING — a bare literal is UNGROUNDED, a source is GROUNDED.
//     The atomic fact every higher structure is built from.
// ─────────────────────────────────────────────────────────────────────────────
describe("Gsec — scalar grounding (the per-value AValue.provenance substrate)", () => {
  it("a bare literal is UNGROUNDED — provenance.size === 0", async () => {
    const r = await runRaw(`"x"`, {}, sources);
    expect(r).toBeInstanceOf(AValue);
    expect((r as AValue).provenance.size).toBe(0);
  });

  it("a bare numeric literal is UNGROUNDED — provenance.size === 0", async () => {
    const r = await runRaw(`42`, {}, sources);
    expect(r).toBeInstanceOf(AValue);
    expect((r as AValue).provenance.size).toBe(0);
  });

  it("a source-derived value is GROUNDED — provenance.size > 0", async () => {
    const r = await runRaw(`(source-a "ignored")`, {}, sources);
    expect(r).toBeInstanceOf(AValue);
    expect((r as AValue).provenance.size).toBeGreaterThan(0);
  });

  it("a pure pipe over a source STAYS grounded — propagation never drops to 0", async () => {
    // string-upcase mints nothing of its own; the source's grounding must survive.
    const r = await runRaw(`(string-upcase (source-a "p"))`, {}, sources);
    expect(r).toBeInstanceOf(AValue);
    expect((r as AValue).provenance.size).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) PARTIAL FABRICATION — one source-derived leaf + one literal leaf in ONE
//     structure. This is the load-bearing case: the two leaves MUST be per-leaf
//     distinguishable — grounded leaf `size > 0`, literal leaf `size === 0`. A
//     `merge`-barrier corruption that flattens the structure's provenance to one
//     set would erase this distinction (the literal would read as grounded) — so
//     it is asserted LOUDLY, leaf by leaf, never via the union.
// ─────────────────────────────────────────────────────────────────────────────
describe("Gsec — partial fabrication is per-leaf distinguishable (the merge-barrier gate)", () => {
  it('(list (source-a …) "literal") — grounded leaf size>0 AND literal leaf size===0', async () => {
    // Mirrors sift's partial-fabrication probe `(list (:k (source)) "literal")`, in
    // PURE arrival. The structure's UNION is non-empty (it contains the source), so a
    // top-level / unioned read would call the whole thing grounded — that is exactly
    // the laundering this per-leaf walk refuses.
    const r = await runRaw(`(list (source-a "p") "literal")`, {}, sources);
    const sizes = leafGroundingSizes(r);
    expect(sizes).toHaveLength(2); // exactly the two DATA leaves (nil tail skipped)

    const grounded = sizes.filter((s) => s > 0);
    const ungrounded = sizes.filter((s) => s === 0);
    expect(grounded).toHaveLength(1); // the source leaf is GROUNDED
    expect(ungrounded).toHaveLength(1); // the literal leaf is UNGROUNDED — not laundered
  });

  it('order-independent: (list "literal" (source-a …)) is still one-grounded-one-not', async () => {
    // The same property must hold regardless of where the literal sits in the spine,
    // so the gate cannot be satisfied by a positional accident.
    const r = await runRaw(`(list "literal" (source-a "p"))`, {}, sources);
    const sizes = leafGroundingSizes(r);
    expect(sizes).toHaveLength(2);
    expect(sizes.filter((s) => s > 0)).toHaveLength(1);
    expect(sizes.filter((s) => s === 0)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) FULLY GROUNDED — every leaf source-derived ⇒ EVERY leaf `size > 0`. The
//     positive counterpart: a wholly-sourced structure has no ungrounded leaf.
// ─────────────────────────────────────────────────────────────────────────────
describe("Gsec — a fully-grounded structure has ALL leaves grounded", () => {
  it("(list (source-a …) (source-b …)) — every data leaf has provenance.size > 0", async () => {
    const r = await runRaw(`(list (source-a "a") (source-b "b"))`, {}, sources);
    const sizes = leafGroundingSizes(r);
    expect(sizes).toHaveLength(2);
    expect(sizes.every((s) => s > 0)).toBe(true); // no ungrounded leaf anywhere
  });

  it("nested fully-grounded structure stays all-grounded down every spine", async () => {
    // A grounded leaf beside a grounded sub-list — the per-leaf walk descends both
    // spines, and no leaf may be ungrounded.
    const r = await runRaw(`(list (source-a "a") (list (source-b "b")))`, {}, sources);
    const sizes = leafGroundingSizes(r);
    expect(sizes).toHaveLength(2);
    expect(sizes.every((s) => s > 0)).toBe(true);
  });
});
