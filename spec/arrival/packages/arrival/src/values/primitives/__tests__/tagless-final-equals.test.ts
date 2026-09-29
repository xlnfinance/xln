// NOTE (2026-07-14): these cycles are tied through `__tieKnot`, the designed door, rather than by
// raw `p.cdr = p` assignment. `APair`'s car/cdr became prototype GETTERS (so `AJSArrayList`, the
// lazy spine view over a borrowed JS array, can override them) — and a getter-only property cannot
// be assigned, so the old raw writes now throw `TypeError: Cannot set property cdr`.
//
// That they threw is the useful part: these tests were the ONLY code in the tree still tying knots
// outside the door. `__tieKnot`'s doc has always said it is "the ONE mutation path through APair's
// readonly slots" — the tests just quietly weren't using it, and nothing could tell. The getters
// made the fence real.
import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../../../run/RunContext.js";

import { AValue } from "../AValue.js";
import { __tieKnot, APair } from "../APair.js";
import { AVector } from "../AVector.js";
import { AString } from "../AString.js";
import { ABool } from "../ABool.js";
import { ASymbol } from "../ASymbol.js";
import { ABytevector } from "../ABytevector.js";
import { AExact } from "../AExact.js";
import { AInexact } from "../AInexact.js";
import { AJSObject } from "../../../membrane/AJSObject.js";
import { ANil, nil } from "../ANil.js";
import { ACharacter } from "../ACharacter.js";
import { eq, eqv, structuralEqual } from "../../structural-equal.js";
import listsCap from "../../../env/r7rs/lists.js";
import type { EnvCapability } from "../../../common/capability.js";
import type { AList, AListAlike, SchemeValue } from "../../types.js";
import { tf } from "../../tagless-final.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

// ─────────────────────────────────────────────────────────────────────────────
// B2 — arrival/tagless-final/equals as a totalic, cycle-safe, tagless-final Setoid.
//
// Every AValue subtype owns its equality; structuralEqual is a thin co-induction
// harness that records the (a, b) partner pair BEFORE descending and threads a
// shared seen map so mutually-cyclic structures terminate.
// ─────────────────────────────────────────────────────────────────────────────

// Source op fns FROM THE CAPABILITY's inlined `symbols` (the bare *_OPS map was
// inlined into the constructor; the capability default export is the single
// declaration site). These packs are all the record form of `spec.symbols`.
const opsOf = (cap: EnvCapability): Record<string, (...a: any[]) => any> =>
  Object.fromEntries(
    // Stage A2: the CONTRACT (native's raw `.impl`) rides `.contract` on the minted
    // ANativeProcedure now; `harvestContracts` pulls it off (the shared read-side seam).
    // The untagged `{ value }` form is the fallback for any entry not yet on the symbol.*
    // API. Entries resolving to neither (no `impl`, no `value`) are DROPPED so the
    // record's values are honestly all-functions — the op-helpers below call them as such.
    Object.entries(harvestContracts(cap.spec.symbols)).flatMap(([k, v]) => {
      const op =
        (v as { impl?: (...a: any[]) => any; value?: (...a: any[]) => any }).impl ??
        (v as { value?: (...a: any[]) => any }).value;
      return op ? [[k, op] as const] : [];
    }),
  );
const LIST_OPS = opsOf(listsCap);

// Build a proper list of Pairs terminated by nil.
function list(...xs: SchemeValue[]): AListAlike {
  let acc: AListAlike = nil;
  for (let i = xs.length - 1; i >= 0; i--) acc = new APair(xs[i], acc) as AListAlike;
  return acc;
}

// A value that defines EQ (typeof v[EQ] === "function"). Build a representative
// of every concrete AValue subtype; the abstract method forces totality.
function representativeValues(): { name: string; value: AValue }[] {
  const reps: { name: string; value: AValue }[] = [
    { name: "Nil", value: nil },
    { name: "Pair", value: new APair(new AExact(1), nil) },
    { name: "SchemeString", value: new AString("x") },
    { name: "SchemeExact", value: new AExact(1) },
    { name: "SchemeInexact", value: new AInexact(1.5) },
    { name: "SchemeBool", value: new ABool(true) },
    { name: "SchemeCharacter", value: new ACharacter("a") },
    { name: "SchemeSymbol", value: new ASymbol("sym") },
    { name: "SchemeVector", value: new AVector([new AExact(1)]) },
    { name: "SchemeBytevector", value: new ABytevector([1, 2, 3]) },
    { name: "SchemeJSObject", value: new AJSObject({ a: 1 }) },
  ];
  return reps;
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 — TOTALITY: every representative AValue defines arrival/tagless-final/equals.
// ─────────────────────────────────────────────────────────────────────────────
describe("G1 totality — every AValue subtype defines arrival/tagless-final/equals", () => {
  it.each(representativeValues())("$name has a callable arrival/tagless-final/equals", ({ value }) => {
    expect(typeof (value as unknown as Record<string, unknown>)[tf("equals")]).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G2 — PAIR SETOID: equal/unequal/pair-vs-nonpair/nested + cycles via the term.
// ─────────────────────────────────────────────────────────────────────────────
describe("G2 Pair Setoid", () => {
  // Invoke EQ as a METHOD on the receiver so `this` is bound (the protocol is a
  // method on the term). Pre-impl, Pair has no EQ → "not a function" (a clean RED).
  const pairEq = (p: APair<any, any>, other: unknown, seen?: Map<object, Set<object>>): boolean =>
    p[tf("equals")](other, seen);

  it("equal proper lists compare equal through the Pair Setoid", () => {
    const a = list(new AExact(1), new AExact(2), new AExact(3)) as APair<any, any>;
    const b = list(new AExact(1), new AExact(2), new AExact(3)) as APair<any, any>;
    expect(pairEq(a, b)).toBe(true);
  });

  it("unequal lists compare unequal", () => {
    const a = list(new AExact(1), new AExact(2)) as APair<any, any>;
    const b = list(new AExact(1), new AExact(9)) as APair<any, any>;
    expect(pairEq(a, b)).toBe(false);
  });

  it("pair vs non-pair is false", () => {
    const a = list(new AExact(1)) as APair<any, any>;
    expect(pairEq(a, new AExact(1))).toBe(false);
    expect(pairEq(a, nil)).toBe(false);
  });

  it("nested lists compare structurally", () => {
    const a = list(list(new AExact(1), new AExact(2)), new AString("k")) as APair<any, any>;
    const b = list(list(new AExact(1), new AExact(2)), new AString("k")) as APair<any, any>;
    const c = list(list(new AExact(1), new AExact(7)), new AString("k")) as APair<any, any>;
    expect(pairEq(a, b)).toBe(true);
    expect(pairEq(a, c)).toBe(false);
  });

  it("self-cyclic pairs (a.cdr=a, b.cdr=b) compare equal AND terminate", () => {
    // A `set-cdr!` cycle: the cdr slot holds any SchemeValue at runtime (here the pair
    // itself), so the locals carry the real slot type rather than the nil-narrowed infer.
    const a: APair<AExact, SchemeValue> = new APair(new AExact(1), nil);
    __tieKnot(a, "cdr", a);
    const b: APair<AExact, SchemeValue> = new APair(new AExact(1), nil);
    __tieKnot(b, "cdr", b);
    expect(pairEq(a, b)).toBe(true);
  });

  it("mutually-cyclic pairs (a↔b vs c↔d) compare equal AND terminate", () => {
    const a: APair<AExact, SchemeValue> = new APair(new AExact(1), nil);
    const b: APair<AExact, SchemeValue> = new APair(new AExact(2), nil);
    __tieKnot(a, "cdr", b);
    __tieKnot(b, "cdr", a);
    const c: APair<AExact, SchemeValue> = new APair(new AExact(1), nil);
    const d: APair<AExact, SchemeValue> = new APair(new AExact(2), nil);
    __tieKnot(c, "cdr", d);
    __tieKnot(d, "cdr", c);
    expect(pairEq(a, c)).toBe(true);
  });

  it("an explicit seen Map argument is honored", () => {
    const a = list(new AExact(1)) as APair<any, any>;
    const b = list(new AExact(1)) as APair<any, any>;
    expect(pairEq(a, b, new Map())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G3 — VECTOR SETOID: mutually-cyclic vectors must terminate.
//
// INVESTIGATED SIGNAL (the prompt predicted this group RED-now; it is GREEN-now):
// the documented fresh-seen stack-blow is LATENT today, masked by the inline
// SchemeVector special-case in structuralEqual (structural-equal.ts:50-63) which
// threads a SHARED seen and intercepts vectors BEFORE the arrival/tagless-final/equals
// hook. A direct a[EQ](c) call recurses through structuralEqual's inline block
// (shared seen) — never through the vector method's own fresh-seen — so it
// terminates. The blow-up only manifests if the refactor removes that inline
// block and routes vectors through the method WITHOUT threading seen. So this
// group is a REGRESSION GUARD: green now, and it MUST STAY GREEN after the
// refactor — proving the new seen-threaded SchemeVector Setoid still terminates
// on mutual cycles once it owns the recursion.
// ─────────────────────────────────────────────────────────────────────────────
describe("G3 Vector Setoid — cyclic vectors terminate", () => {
  const vecEq = (v: AVector, other: unknown, seen?: Map<object, Set<object>>): boolean => v[tf("equals")](other, seen);

  it("mutually-cyclic vectors a↔b vs c↔d compare equal AND terminate", () => {
    const a = new AVector([new AExact(1)]);
    const b = new AVector([new AExact(2)]);
    // @ts-expect-error __vector__ is private + readonly; mutating for cycle test
    (a.__vector__ as unknown as AExact[]).push(b);
    // @ts-expect-error __vector__ is private + readonly; mutating for cycle test
    (b.__vector__ as unknown as AExact[]).push(a);
    const c = new AVector([new AExact(1)]);
    const d = new AVector([new AExact(2)]);
    // @ts-expect-error __vector__ is private + readonly; mutating for cycle test
    c.__vector__.push(d);
    // @ts-expect-error __vector__ is private + readonly; mutating for cycle test
    d.__vector__.push(c);
    expect(vecEq(a, c)).toBe(true);
  });

  it("equal acyclic vectors compare equal; unequal differ", () => {
    const a = new AVector([new AExact(1), new AExact(2)]);
    const b = new AVector([new AExact(1), new AExact(2)]);
    const c = new AVector([new AExact(1), new AExact(3)]);
    expect(vecEq(a, b)).toBe(true);
    expect(vecEq(a, c)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G4 — equal? REGRESSION: structuralEqual deep + cyclic, routing through Setoids.
// ─────────────────────────────────────────────────────────────────────────────
describe("G4 equal? regression — structuralEqual", () => {
  it("deep nested structures: true and false", () => {
    const a = list(list(new AExact(1)), new AString("k"), new AVector([new ABool(true)]));
    const b = list(list(new AExact(1)), new AString("k"), new AVector([new ABool(true)]));
    const c = list(list(new AExact(1)), new AString("k"), new AVector([new ABool(false)]));
    expect(structuralEqual(a, b)).toBe(true);
    expect(structuralEqual(a, c)).toBe(false);
  });

  it("cyclic list via structuralEqual terminates", () => {
    const a: APair<AExact, SchemeValue> = new APair(new AExact(1), nil);
    __tieKnot(a, "cdr", a);
    const b: APair<AExact, SchemeValue> = new APair(new AExact(1), nil);
    __tieKnot(b, "cdr", b);
    expect(structuralEqual(a, b)).toBe(true);
    // self-equality on a cyclic list must also terminate (the bridge.ts war story)
    expect(structuralEqual(a, a)).toBe(true);
  });

  it("cyclic vector via structuralEqual terminates", () => {
    const a = new AVector([new AExact(1)]);
    // @ts-expect-error __vector__ is private + readonly; mutating for cycle test
    (a.__vector__ as unknown as AExact[]).push(a);
    const b = new AVector([new AExact(1)]);
    // @ts-expect-error __vector__ is private + readonly; mutating for cycle test
    (b.__vector__ as unknown as AExact[]).push(b);
    expect(structuralEqual(a, b)).toBe(true);
  });

  it("Pair & Vector now route through their own Setoid (sanity)", () => {
    // tagless-final/equals is declared directly on AValue subtypes — no cast needed.
    expect(typeof new APair(new AExact(1), nil)[tf("equals")]).toBe("function");
    expect(typeof new AVector([])[tf("equals")]).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G5 — eq?/eqv? LANDMINE: these stay identity/scalar. structuralEqual is structural.
// ─────────────────────────────────────────────────────────────────────────────
describe("G5 eq?/eqv? landmine — must stay identity/scalar", () => {
  it("eq?/eqv? on distinct equal lists is #f; equal? is #t", () => {
    expect(eq(list(new AExact(1)), list(new AExact(1)))).toBe(false);
    expect(eqv(list(new AExact(1)), list(new AExact(1)))).toBe(false);
    expect(structuralEqual(list(new AExact(1)), list(new AExact(1)))).toBe(true);
  });

  it("eqv? exact vs inexact #f; exact vs exact #t", () => {
    expect(eqv(new AExact(1), new AInexact(1))).toBe(false);
    expect(eqv(new AExact(1), new AExact(1))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G6 — EQUALITY-SUITE CLEANUP (tagless-final wave). Two changes under test:
//   (1) the duplicate op-helpers `eqv` is collapsed onto the canonical
//       structural-equal `eqv` (= `eq`); env/lists' memv/assv now use the
//       canonical semantics, fixing the latent symbol/nil divergence.
//   (2) eq()'s scalar cases route THROUGH each term's arrival/tagless-final/equals Setoid
//       (de-dup of the per-scalar compare) — with the SchemeBool boundary pinned.
//
// Interning note (verified): SchemeSymbol interns by default, so two bare
// `new SchemeSymbol("a")` calls are `===` (same heap instance). The op-helpers
// vs canonical divergence is therefore LATENT for interned symbols (the `===`
// fast-path masks it). It MANIFESTS only for distinct-instance symbols of the
// same name — which is exactly what a provenance clone is
// (`sym.withProvenance(p)` mints an UNINTERNED copy). The memv/assv tests below
// build that distinct instance to make the divergence real.
// ─────────────────────────────────────────────────────────────────────────────
describe("G6 equality-suite cleanup", () => {
  // A distinct-instance symbol of the same name (uninterned provenance clone).
  const distinctSym = (name: string): ASymbol => new ASymbol(name).withProvenance(new Set([1]));

  // INVARIANT: eqv? over scalars matches exactness/char/bool identity, and
  // treats distinct-instance same-name symbols and nil clones as eqv.
  describe("eqv? over scalars (canonical structural-equal)", () => {
    it("exact ≡ exact (same value) → true", () => {
      expect(eqv(new AExact(1), new AExact(1))).toBe(true);
    });
    it("exact vs inexact → false (exactness distinguishes)", () => {
      expect(eqv(new AExact(1), new AInexact(1))).toBe(false);
    });
    it("char same/diff", () => {
      expect(eqv(new ACharacter("a"), new ACharacter("a"))).toBe(true);
      expect(eqv(new ACharacter("a"), new ACharacter("b"))).toBe(false);
    });
    it("bool same/diff", () => {
      expect(eqv(new ABool(true), new ABool(true))).toBe(true);
      expect(eqv(new ABool(true), new ABool(false))).toBe(false);
    });
    it("two DISTINCT-instance symbols of the same name → true", () => {
      const a = distinctSym("a");
      const b = distinctSym("a");
      expect(a).not.toBe(b);
      expect(eqv(a, b)).toBe(true);
    });
    it("two Nil → true", () => {
      expect(eqv(nil, nil)).toBe(true);
      expect(eqv(nil, nil.withProvenance(new Set([1])))).toBe(true);
    });
  });

  describe("eq()/eqv() scalar result == the term's own Setoid", () => {
    const EQM = (x: AValue, y: unknown): boolean => x[tf("equals")](y);
    const pairs: { name: string; x: AValue; y: AValue }[] = [
      { name: "exact==exact", x: new AExact(1), y: new AExact(1) },
      { name: "exact!=exact", x: new AExact(1), y: new AExact(2) },
      { name: "inexact==inexact", x: new AInexact(1.5), y: new AInexact(1.5) },
      { name: "char==char", x: new ACharacter("a"), y: new ACharacter("a") },
      { name: "char!=char", x: new ACharacter("a"), y: new ACharacter("b") },
      { name: "bool==bool", x: new ABool(true), y: new ABool(true) },
      { name: "bool!=bool", x: new ABool(true), y: new ABool(false) },
      { name: "sym==sym(distinct)", x: distinctSym("a"), y: distinctSym("a") },
      { name: "nil==nil", x: nil, y: nil.withProvenance(new Set([1])) },
    ];
    it.each(pairs)("$name: eq() routes identically to the Setoid", ({ x, y }) => {
      expect(eq(x, y)).toBe(EQM(x, y));
      expect(eqv(x, y)).toBe(EQM(x, y));
    });
  });

  describe("memv/assv consistency with eqv? on distinct-instance symbols/nil", () => {
    // memv('a, (b a c)) finds the 'a — matches eqv?. With the op-helpers eqv this
    // is RED for a distinct-instance 'a (no SchemeSymbol case → #f).
    it("memv finds a distinct-instance symbol of the same name", () => {
      const needle = distinctSym("a");
      const lst = list(new ASymbol("b"), new ASymbol("a"), new ASymbol("c"));
      const found = LIST_OPS.memv(needle, lst);
      expect(found).not.toBe(false);
      expect((found as APair<any, any>).car).toBeInstanceOf(ASymbol);
      expect(((found as APair<any, any>).car as ASymbol).__name__).toBe("a");
    });

    it("memv finds a distinct-instance nil", () => {
      const needle = nil.withProvenance(new Set([1]));
      const lst = list(new ASymbol("x"), nil);
      const found = LIST_OPS.memv(needle, lst);
      expect(found).not.toBe(false);
      expect((found as APair<any, any>).car).toBeInstanceOf(ANil);
    });

    it("assv finds a distinct-instance symbol key of the same name", () => {
      const needle = distinctSym("k");
      const alist = list(new APair(new ASymbol("j"), new AExact(1)), new APair(new ASymbol("k"), new AExact(2)));
      const found = LIST_OPS.assv(needle, alist);
      expect(found).not.toBe(false);
      expect(((found as APair<any, any>).car as ASymbol).__name__).toBe("k");
      expect(((found as APair<any, any>).cdr as AExact).valueOf()).toBe(2);
    });

    // Numeric eqv? path (interned-symbol-independent): assv still matches numbers.
    it("memv matches distinct-instance exact numbers (eqv? numeric path)", () => {
      const needle = new AExact(2);
      const lst = list(new AExact(1), new AExact(2), new AExact(3));
      const found = LIST_OPS.memv(needle, lst);
      expect(found).not.toBe(false);
      expect(((found as APair<any, any>).car as AExact).valueOf()).toBe(2);
    });
  });

  describe("G5 reaffirm — eq/eqv stay pointer-grade on Pairs (NOT deep)", () => {
    it("distinct equal Pairs: eq/eqv #f, equal? #t", () => {
      const a = list(new AExact(1), new AExact(2)) as APair<any, any>;
      const b = list(new AExact(1), new AExact(2)) as APair<any, any>;
      expect(eq(a, b)).toBe(false);
      expect(eqv(a, b)).toBe(false);
      expect(structuralEqual(a, b)).toBe(true);
    });
  });

  describe("LANDMINE pin — eq?/eqv? scalar boundary must NOT widen", () => {
    // SchemeBool's Setoid is representation-BLIND: it also matches a RAW JS boolean
    // (`this.value === other`). eq?/eqv? must NOT inherit that — a raw JS boolean
    // is not eq? to a boxed SchemeBool. This test
    // pins eq()'s SchemeBool case so a naive route-through-Setoid (which would
    // flip #f→#t here) is caught.
    it("eq?/eqv? of a boxed SchemeBool vs a raw JS boolean is #f", () => {
      // eq/eqv take `unknown` (identity-grade), so raw boolean IS accepted — no cast.
      // The point of this test is the SEMANTIC boundary (representation-blind Setoid vs identity).
      expect(eq(new ABool(true), true)).toBe(false);
      expect(eqv(new ABool(true), true)).toBe(false);
      // but the Setoid itself IS representation-blind (documents the divergence):
      // The return type of [tf("equals")] is `boolean`; the inner `true` is the `other`
      // arg (also `unknown`). No cast needed — the method is typed on ABool directly.
      // Bare-value purge (A4/P4) VERDICT — mechanism, not aspiration: op-helpers.ts's
      // withInputProvenance now always boxes, ANil's length boxes, AmbientRuntime.set boxes
      // every stored scalar — so no INTERNAL producer inside the membrane can hand
      // `equal?`/`eq?`/`eqv?` a raw JS boolean anymore during real scheme execution. That
      // does NOT flip this assertion to a strict-door throw: laws/equality.law.test.ts
      // (see its boolean row) and boolean-landmine-regression.test.ts's own header comment
      // ("EVERY predicate produces these SchemeBools, and these stay green") both
      // independently pin the Setoid's representation-blindness as DURABLE, general JS-API
      // convenience, not a transitional accommodation. A throw here would contradict those
      // verified-durable siblings — the aspirational door the purge explicitly warns against.
      expect(new ABool(true)[tf("equals")](true)).toBe(true);
    });
  });
});
