import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../run/RunContext.js";

import { ABool } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { structuralEqual } from "../../values/structural-equal.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";

// LAW — the equality contract: representation-blindness (R7RS §6.1) (P0/P8).
//
// Survivor of `equality-representation.test.ts` (retired in the 2026-07-09 suite
// consolidation): the consolidation ledger originally scheduled these rows `[INVERTS: bare-value-purge/P4]`, expected to
// flip to strict-door throws once the purge landed. The A4 bare-value purge (landed 2026-07-09) settled
// the mechanism question instead — see each row's comment below for the per-type verdict —
// so this file relocates as ONE plain law table, no more `[INVERTS]` framing.
//
// `equal?` compares VALUES, not REPRESENTATIONS. A value that is BOXED (a SchemeString carrying
// provenance, minted by a chain-plane op) must compare equal to the SAME value UNBOXED (a plain JS
// string, e.g. a literal or a rosetta-unwrapped result) — `(equal? boxed unboxed)` is the SAME
// question as `(equal? unboxed unboxed)`. The chain plane boxes inconsistently (provenance-carrying
// inputs → boxed result; literals → plain), so any program that deduplicates / `member?`s / set-ops
// over derived values compares ACROSS the boxed↔unboxed boundary. If equal? is representation-strict
// there, dedup silently fails — the sift/closure.scm browser hang (unbounded doubling).
//
// Root cause: each primitive box's `arrival/tagless-final/equals` is `other instanceof X && content`, and
// structuralEqual consults the Setoid BEFORE its valueOf content-check — so boxed-vs-unboxed short-
// circuits to false. This pack asserts the contract per type so the regression can't reappear.

const eq = (a: unknown, b: unknown): boolean => structuralEqual(a, b);

describe("equality contract — boxed ≡ unboxed (representation-blind)", () => {
  // STRINGS — the confirmed closure.scm bug. A boxed SchemeString MUST equal a content-identical
  // plain JS string, in both argument orders, while differing content stays unequal.
  // Bare-value purge (A4/P4) VERDICT — mechanism, not aspiration (the A4 bare-value
  // purge, landed 2026-07-09; RULINGS.md R1): the purge (op-helpers.ts withInputProvenance always boxes now; ANil's
  // length boxes; AmbientRuntime.set boxes every stored scalar) closes every INTERNAL producer
  // of a raw string reaching scheme execution — a chain-plane op can no longer hand `equal?`
  // an unboxed operand. But that does NOT make this row invert to a Setoid-level throw: this
  // exact representation-blind assertion is independently pinned, unconditionally, by
  // scheme-string-algebra.test.ts ("equals is representation-blind... the representation-
  // blindness that fixes dedup over chain-boxed strings") — a file the 2026-07-08 manifest
  // sweep explicitly verified "Clean" (durable, not scheduled to change). Adding a throw here
  // would contradict that sibling, verified-durable test — an aspirational door, not the real
  // mechanism. The real mechanism: the membrane now guarantees no INTERNAL producer creates
  // this scenario; AString's Setoid keeps the tolerance as harmless, general JS-API-level
  // equality convenience for direct (non-scheme) callers of `equal?`/`structuralEqual`.
  it("string: boxed ≡ unboxed, symmetric, content-discriminating", () => {
    expect(eq(new AString("f|b"), "f|b")).toBe(true); // boxed vs plain  ← the bug
    expect(eq("f|b", new AString("f|b"))).toBe(true); // plain vs boxed (symmetry)
    expect(eq(new AString("f|b"), new AString("f|b"))).toBe(true); // boxed vs boxed
    expect(eq(new AString("f|b"), "f|c")).toBe(false); // different content
    expect(eq(new AString("f|b"), 5)).toBe(false); // string vs non-string
  });

  // BOOLEANS — same class (plain JS booleans appear via rosetta unwrapping).
  // Bare-value purge (A4/P4) VERDICT — same conclusion as the string row above, and
  // independently confirmed by boolean-landmine-regression.test.ts's own header comment:
  // "when [boxing all predicate/comparison returns] lands, EVERY predicate produces these
  // SchemeBools, and these stay green" — i.e. the codebase's OWN prior audit already
  // anticipated this exact post-purge state and declared the representation-blind Setoid
  // tolerance durable, not scheduled to die. No Setoid-level throw added (see the string
  // row's full reasoning) — retagged from a scheduled inversion to a settled design.
  it("boolean: boxed ≡ unboxed, content-discriminating", () => {
    expect(eq(new ABool(true), true)).toBe(true);
    expect(eq(true, new ABool(true))).toBe(true);
    expect(eq(new ABool(true), false)).toBe(false);
  });

  // NUMBERS — boxed ≡ boxed, and the exact/inexact GRADE must survive (R7RS: (equal? 1 1.0) ⇒ #f).
  // NOTE: plain-JS-number ↔ boxed-number is INTENTIONALLY NOT asserted representation-blind — a plain
  // JS number carries no exact/inexact grade, so equating it to a boxed exact would make
  // SchemeExact(1) ≡ plain-1 ≡ SchemeInexact(1.0) by transitivity, collapsing the grade. That's a
  // deferred design question (V). Strings/booleans have no grade, so they ARE representation-blind.
  it("number: boxed ≡ boxed, exact ≠ inexact (grade survives)", () => {
    expect(eq(new AExact(1, 1), new AExact(1, 1))).toBe(true);
    expect(eq(new AExact(1, 1), new AExact(2, 1))).toBe(false);
    expect(eq(new AExact(1, 1), new AInexact(1))).toBe(false); // 1 ≠ 1.0 (grade-strict)
  });

  // CHARACTERS & SYMBOLS — always boxed in practice (no plain-JS counterpart), so boxed-vs-boxed
  // is the live case; assert it stays correct (regression guard for the Setoid change).
  it("character & symbol: boxed ≡ boxed, content-discriminating", () => {
    expect(eq(new ACharacter("a"), new ACharacter("a"))).toBe(true);
    expect(eq(new ACharacter("a"), new ACharacter("b"))).toBe(false);
    expect(eq(new ASymbol("x"), new ASymbol("x"))).toBe(true);
    expect(eq(new ASymbol("x"), new ASymbol("y"))).toBe(false);
  });
});
