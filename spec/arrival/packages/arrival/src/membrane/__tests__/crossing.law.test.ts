/**
 * LAW F3 — the membrane converts everything, once, uniformly (P4/P5/P9).
 *
 * Driven entirely by _tables/crossings.ts: entry form, exit form (ONE convention
 * column — R1-RULED), round-trip promise. Plus the violation table: every
 * forbidden crossing throws its teaching door.
 *
 * BODY PHASE: titles stay data-driven off the table (row.entryForm / row.exitForm /
 * row.roundTrip decide the TEXT); bodies are per-row because the table doesn't carry
 * a sample JS value. RULINGS.md R1 settled the scalar exit
 * convention — `exec`'s SIMPLE tier fully unwraps via `toJS`, so the boolean/
 * safe-int/float/bigint/string exit cells are now live, asserted against REAL
 * `exec` output (end-to-end through the parser/evaluator, not just `toJS` directly
 * — the other cells in this file already exercise `toJS` in isolation). The
 * registered-symbol exit cell stays `it.todo` — ASymbol's opaque-exit mapping is
 * still design-pending, unrelated to this ruling.
 */
import { describe, expect, it, vi } from "vitest";
import { CROSSINGS, VIOLATIONS } from "../../__tests__/laws/_tables/crossings.js";
import { toJS, jsToScheme, modeKeyOf } from "../rosetta.js";
import { isSchemeValue } from "../membrane.js";

import { exec } from "../../eval/generator-exec.js";
import { setMembraneWarnings } from "../membrane-warn.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { ABool } from "../../values/primitives/ABool.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import { APair } from "../../values/primitives/APair.js";
import { AVector } from "../../values/primitives/AVector.js";
import { ADict } from "../../values/primitives/ADict.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { ARosettaProcedure } from "../../values/primitives/ARosettaProcedure.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../region-scope.js";
import { RedundantCrossingError, RegionEscapeError } from "../../errors.js";
import { AJSArray } from "../AJSArray.js";
import { AJSObject } from "../AJSObject.js";
import type { SchemeValue } from "../../values/types.js";
import { isInteropBoundary, markInteropPrivate } from "../interop-access.js";
import { AOpaqueHandle } from "../../values/primitives/AOpaqueHandle.js";

const PROV = new Set<number>([777]);

/** P4: nothing that crosses OUT carries a stray `provenance` own-property — a raw
 *  JS value (a primitive, or a wrapper's original `.source`) never had one to begin
 *  with; this is the negative half of "exit leaves lineage in the trace, none on
 *  the JS value." */
function expectNoProvenanceProperty(x: unknown): void {
  if (x !== null && typeof x === "object") {
    expect(Object.prototype.hasOwnProperty.call(x, "provenance")).toBe(false);
  }
}

/** Inbound entry for this grid — the one JS→Scheme door. */
const enter = <T>(v: T) => jsToScheme(CONSTANT_CTX, v);

const exitJS = (entered: unknown): unknown => toJS(entered as SchemeValue);

describe.each(CROSSINGS.map((r) => [r.type, r] as const))("crossing: %s", (_t, row) => {
  const entryTitle = `entry (JS→scheme): becomes ${row.entryForm}`;
  // R1 (RULINGS.md) settled the single exit convention — every row's exitForm is
  // now the ruled text, no "gated" placeholder branch needed.
  const exitTitle = `exit (scheme→JS): becomes ${row.exitForm}`;
  const roundTripTitle = row.roundTrip
    ? "round-trip: exact (promised, tested as a law — P9)"
    : "one-way: total honest projection, no reconstruction markers (P9)";
  const provenanceTitle = "provenance: entry deep-stamps; exit leaves lineage in the trace, none on the JS value (P4)";

  switch (row.type) {
    case "boolean": {
      it(entryTitle, () => {
        const entered = enter(true);
        expect(entered).toBeInstanceOf(ABool);
        expect((entered as ABool).valueOf()).toBe(true);
      });
      it(exitTitle, async () => {
        // REAL exec output, end-to-end (RULINGS.md R1) — the SIMPLE tier's plain-JS exit.
        const [t] = await exec("#t");
        const [f] = await exec("#f");
        expect(t).toBe(true);
        expect(f).toBe(false);
      });
      it(roundTripTitle, () => {
        expect(exitJS(enter(true))).toBe(true);
        expect(exitJS(enter(false))).toBe(false);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, true, {}, PROV);
        expect(stamped).toBeInstanceOf(ABool);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "safe-int number": {
      it(entryTitle, () => {
        const entered = enter(42);
        expect(entered).toBeInstanceOf(AExact);
        expect((entered as AExact).num).toBe(42);
      });
      it(exitTitle, async () => {
        const [n] = await exec("42");
        expect(n).toBe(42);
        expect(typeof n).toBe("number");
      });
      it(roundTripTitle, () => {
        expect(exitJS(enter(42))).toBe(42);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, 42, {}, PROV);
        expect(stamped).toBeInstanceOf(AExact);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "float number": {
      it(entryTitle, () => {
        const entered = enter(3.14);
        expect(entered).toBeInstanceOf(AInexact);
        expect((entered as AInexact).real).toBe(3.14);
      });
      it(exitTitle, async () => {
        const [n] = await exec("3.14");
        expect(n).toBe(3.14);
        expect(typeof n).toBe("number");
      });
      it(roundTripTitle, () => {
        expect(exitJS(enter(3.14))).toBe(3.14);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, 3.14, {}, PROV);
        expect(stamped).toBeInstanceOf(AInexact);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "bigint": {
      // Host bigint DOORS (NoLensError kind `"bigint"`) — same spirit as unique-symbol.
      // Exact numbers are safe-int ratios; convert with Number/bigintToNumber in the
      // safe range (or pass inexact/string) before re-crossing. Codecs that speak
      // bigint on the host face (`z.bigint`) encode to AExact BEFORE the membrane.
      it(entryTitle, () => {
        expect(() => enter(10n)).toThrow(/no lens for a host bigint/);
      });
      // exitForm: "n/a" — no exit cell (the crossing doors before any box exists).
      it(roundTripTitle, () => {
        expect(() => enter(10n)).toThrow(/no lens for a host bigint/);
        expect(() => jsToScheme(CONSTANT_CTX, 12345678901234567890n)).toThrow(/no lens for a host bigint/);
      });
      it(provenanceTitle, () => {
        // No carrier to stamp: the crossing doors BEFORE any box could carry a
        // provenance set — loud at the crossing, never a stray degrade (P5).
        expect(() => jsToScheme(CONSTANT_CTX, 10n, {}, PROV)).toThrow(/no lens for a host bigint/);
      });
      break;
    }

    case "string": {
      it(entryTitle, () => {
        const entered = enter("hello");
        expect(entered).toBeInstanceOf(AString);
        expect((entered as AString).valueOf()).toBe("hello");
      });
      it(exitTitle, async () => {
        const [s] = await exec('"hello"');
        expect(s).toBe("hello");
        expect(typeof s).toBe("string");
      });
      it(roundTripTitle, () => {
        expect(exitJS(enter("hello"))).toBe("hello");
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, "hello", {}, PROV);
        expect(stamped).toBeInstanceOf(AString);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "null": {
      it(entryTitle, () => {
        expect(enter(null)).toBe(nil);
      });
      it(exitTitle, () => {
        // nil-as-array (V ruling 2026-07-13): '()'s JS face is [] — the empty case of
        // the ONE list projection; emptiness must not flip the list's JS type to null.
        expect(toJS(nil)).toEqual([]);
      });
      // Round-trip is asymmetric BY LAW: ingress is permissive (null → nil), egress is
      // canonical (nil → []). null → nil → [] — a JS null re-emerges as the empty
      // list's array face, matching what a non-empty list does and what the compiled
      // world emits for '() (the differential oracle compares through this face).
      it(roundTripTitle, () => {
        expect(toJS(jsToScheme(CONSTANT_CTX, null))).toEqual([]);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, null, {}, PROV);
        expect(stamped).toBeInstanceOf(ANil);
        expect([...stamped.provenance]).toEqual([...PROV]);
        const out = toJS(stamped);
        expect(out).toEqual([]);
        expectNoProvenanceProperty(out);
      });
      break;
    }

    case "undefined": {
      it(entryTitle, () => {
        // V's ruling (2026-07-23): undefined is a FAMILIAR concept (the other host
        // bottom, alongside null → nil) — a plain LENS now, never a warn. The old
        // warn-then-void tolerance is retired.
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          expect(enter(undefined)).toBe(theVoid);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
      it(exitTitle, () => {
        expect(toJS(theVoid)).toBe(undefined);
      });
      it(roundTripTitle, () => {
        expect(exitJS(enter(undefined))).toBe(undefined);
      });
      it(provenanceTitle, () => {
        // theVoid is a shared, data-free singleton (the "unspecified" marker) — jsToScheme
        // returns it unconditionally for every non-portable JS input, never a fresh
        // provenance-stamped clone. There is no payload here for a stamp to attach to.
        const stamped = jsToScheme(CONSTANT_CTX, undefined, {}, PROV);
        expect(stamped).toBe(theVoid);
        expect(stamped.provenance.size).toBe(0);
        expect(toJS(stamped)).toBe(undefined);
      });
      break;
    }

    case "registered symbol (Symbol.for)": {
      it(entryTitle, () => {
        const entered = enter(Symbol.for("test"));
        expect(entered).toBeInstanceOf(ASymbol);
        expect((entered as ASymbol).__name__).toBe(":test");
      });
      // Not R1-gated (R1 is settled) — ASymbol's opaque-exit mapping is its OWN
      // deferred design (still design-pending, R1-doc'd separately); filling
      // this now would invent that unrelated decision.
      it.todo(exitTitle);
      it(`${roundTripTitle} — a symbol exits as a string, never the original JS Symbol`, () => {
        const out = exitJS(enter(Symbol.for("test")));
        expect(typeof out).toBe("string");
        // ⚖️ 2026-07-14 representation ruling (compiler campaign, constitution §2.1):
        // symbol egress = the INTERNED NAME, plain — the apostrophe marker died
        // (it leaked interpreter texture into compiled artifacts and cache keys).
        // One-way fold stays total and honest; distinguishability lives boxed-side.
        expect(out).toBe(":test");
      });
      it(provenanceTitle, () => {
        // A DISTINCT name from the entry test above, deliberately: ASymbol's flyweight
        // intern table (per-ctx, keyed by NAME only — see ASymbol.ts's "Provenance ×
        // interning invariant" doc) would otherwise hand back the entry test's already-
        // cached empty-provenance ":test" instance instead of minting a fresh stamped one.
        const stamped = jsToScheme(CONSTANT_CTX, Symbol.for("test-provenance-row"), {}, PROV);
        expect(stamped).toBeInstanceOf(ASymbol);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "unique symbol": {
      // V's ruling (2026-07-23): a unique (unregistered) symbol has no portable
      // cross-realm key — no lens exists for it in the algebra. The old
      // warn-then-void tolerance is retired; it now DOORS (NoLensError), naming the
      // cure (register it, or pass a string/keyword instead).
      it(entryTitle, () => {
        expect(() => enter(Symbol("test"))).toThrow(/no lens for a unique JS symbol/);
      });
      // exitForm: "n/a" — no exit cell for this row (the crossing doors before any
      // box exists to exit).
      it(roundTripTitle, () => {
        expect(() => enter(Symbol("x"))).toThrow(/no lens for a unique JS symbol/);
      });
      it(provenanceTitle, () => {
        // No carrier to stamp: the crossing doors BEFORE any box could carry a
        // provenance set — loud at the crossing, never a stray degrade (P5).
        expect(() => jsToScheme(CONSTANT_CTX, Symbol("test"), {}, PROV)).toThrow(/no lens for a unique JS symbol/);
      });
      break;
    }

    case "array": {
      it(entryTitle, () => {
        const arr = [1, 2, 3];
        const entered = enter(arr);
        expect(entered).toBeInstanceOf(AJSArray);
        expect((entered as AJSArray).source).toBe(arr);
        expect((entered as AJSArray).kind).toBe("vector");
      });
      it(exitTitle, () => {
        const arr = [1, 2, 3];
        expect(exitJS(enter(arr))).toBe(arr);
      });
      it(roundTripTitle, () => {
        const arr = [1, 2, 3];
        expect(exitJS(enter(arr))).toBe(arr);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, ["a", "b"], {}, PROV);
        expect(stamped).toBeInstanceOf(AJSArray);
        expect([...stamped.provenance]).toEqual([...PROV]);
        const elems = (stamped as AJSArray).__vector__ as AString[];
        expect(elems[0]).toBeInstanceOf(AString);
        expect([...elems[0].provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "plain object": {
      it(entryTitle, () => {
        const obj = { a: 1 };
        const entered = enter(obj);
        expect(entered).toBeInstanceOf(AJSObject);
        expect((entered as AJSObject).source).toBe(obj);
      });
      it(exitTitle, () => {
        const obj = { a: 1 };
        expect(exitJS(enter(obj))).toBe(obj);
      });
      it(roundTripTitle, () => {
        const obj = { a: 1 };
        expect(exitJS(enter(obj))).toBe(obj);
      });
      // Regression, carried from rosetta-environment.test.ts (retired in the 2026-07-09
      // suite consolidation): `Object.entries` in toJS used to drop symbol keys, so
      // opaque/private backing data on objects crossing the membrane was silently lost.
      // String keys must be unchanged; symbol-keyed slots must survive the round-trip.
      it(`${roundTripTitle} — symbol-keyed properties survive alongside string keys`, () => {
        const SECRET = Symbol("secret");
        const original: Record<string | symbol, unknown> = { visible: 1 };
        original[SECRET] = [4, 5, 6];
        const roundTripped = exitJS(enter(original)) as Record<string | symbol, unknown>;
        expect(roundTripped.visible).toBe(1);
        expect(roundTripped[SECRET]).toEqual([4, 5, 6]);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, { name: "claude" }, {}, PROV);
        expect(stamped).toBeInstanceOf(AJSObject);
        expect([...stamped.provenance]).toEqual([...PROV]);
        const name = (stamped as AJSObject).get("name") as AString;
        expect(name).toBeInstanceOf(AString);
        expect([...name.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "Uint8Array/ArrayBuffer/DataView": {
      it(entryTitle, () => {
        const u8 = new Uint8Array([1, 2, 3]);
        expect(enter(u8)).toBe(u8);
        expect(isSchemeValue(enter(u8))).toBe(false); // stays raw, never boxed
        const ab = new ArrayBuffer(10);
        expect(enter(ab)).toBe(ab);
        const dv = new DataView(new ArrayBuffer(10));
        expect(enter(dv)).toBe(dv);
      });
      it(exitTitle, () => {
        // Never boxed on entry — there is no SchemeValue to exit. toJS is a
        // strict door (raw FFI identity stays on the JS side).
        const u8 = new Uint8Array([1, 2, 3]);
        expect(isSchemeValue(enter(u8))).toBe(false);
        expect(() => toJS(enter(u8) as never)).toThrow(RedundantCrossingError);
      });
      it(roundTripTitle, () => {
        const u8 = new Uint8Array([1, 2, 3]);
        // Identity is the inbound FFI passthrough, not an egress peel.
        expect(enter(u8)).toBe(u8);
        expect(() => toJS(u8 as never)).toThrow(RedundantCrossingError);
      });
      it(provenanceTitle, () => {
        // FFI-identity named superset (P4): the binary never boxes, so a supplied
        // provenance has no carrier to attach to — jsToScheme's exotic-object fallback
        // returns it as-is.
        const u8 = new Uint8Array([1, 2, 3]);
        expect(jsToScheme(CONSTANT_CTX, u8, {}, PROV)).toBe(u8);
        expectNoProvenanceProperty(u8);
      });
      break;
    }

    case "Promise": {
      it(entryTitle, () => {
        // Bare Promise doors (jsToSchemeAsyncDoor): settle first, or let the holding
        // structure's entry read settle it lazily (the inbound-registry law owns
        // the pending-cell rows).
        expect(() => enter(Promise.resolve(42))).toThrow(/bare Promise cannot cross/);
      });
      it(roundTripTitle, () => {
        expect(() => enter(Promise.resolve(42))).toThrow(/bare Promise cannot cross/);
      });
      it(provenanceTitle, () => {
        // No carrier to stamp: the crossing doors BEFORE any box could carry a
        // provenance set — loud at the crossing, never a stray stamped leak (P5).
        const p = Promise.resolve(1);
        expect(() => jsToScheme(CONSTANT_CTX, p, {}, PROV)).toThrow(/bare Promise cannot cross/);
      });
      break;
    }

    case "exotic object (class instance)": {
      // V's ruling (2026-07-23): the binary membrane. An unbranded class instance has
      // NO lens in the algebra (unlike a host `Error`, which is its own declared
      // lens — error-object-exit.law.test.ts) — the old warn-and-borrow tolerance
      // tier (an AJSObject wrap with a console warning) is retired, replaced by a
      // loud door naming the two cures: brand the class `@arrival.private`, or hand
      // plain data instead.
      class Widget {
        constructor(readonly size: number) {}
      }
      it(entryTitle, () => {
        const w = new Widget(7);
        expect(() => jsToScheme(CONSTANT_CTX, w)).toThrow(/no lens for a Widget instance/);
      });
      it(exitTitle, () => {
        // exitForm: "n/a" — the crossing doors before any box exists to exit.
        const w = new Widget(7);
        expect(() => jsToScheme(CONSTANT_CTX, w)).toThrow(/no lens for a Widget instance/);
      });
      it(roundTripTitle, () => {
        const w = new Widget(7);
        expect(() => jsToScheme(CONSTANT_CTX, w)).toThrow(/no lens for a Widget instance/);
      });
      it(provenanceTitle, () => {
        // No carrier to stamp: the crossing doors BEFORE any box could carry a
        // provenance set — loud at the crossing, never a stray degrade (P5).
        const w = new Widget(7);
        expect(() => jsToScheme(CONSTANT_CTX, w, {}, PROV)).toThrow(/no lens for a Widget instance/);
      });
      it("marking the class @arrival.private is the escape hatch — it crosses as an opaque handle instead of dooring", () => {
        class BrandedWidget {
          constructor(readonly size: number) {}
        }
        markInteropPrivate(BrandedWidget);
        const w = new BrandedWidget(7);
        // `<unknown>`: an explicit class T isn't in jsToScheme's known-input union, so its
        // static AWrap<T> fallback isn't AOpaqueHandle-shaped; widening to `unknown` collapses
        // AWrap to the honest SchemeValue union (which AOpaqueHandle is a member of) — same
        // technique opaque-crossing.law.test.ts's own `mintHandle` helper uses.
        const entered = jsToScheme<unknown>(CONSTANT_CTX, w);
        expect(entered).toBeInstanceOf(AOpaqueHandle);
        expect((entered as AOpaqueHandle).instance).toBe(w);
      });
      break;
    }

    case "function (borrowed)": {
      it(entryTitle, () => {
        // V's ruling (2026-07-24): a bare host function is a genuine LENS now, no
        // warn — it mints a scheme-callable ARosettaProcedure (the reverse-membrane
        // lens, ACallable.ts's hostFnToCallable).
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const entered = enter(() => 42);
          expect(entered).toBeInstanceOf(ARosettaProcedure);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
      it.todo(exitTitle); // [INVERTS: reverse-membrane/P6] — staged on the region-discipline
      // migration (region.law.test.ts owns its acceptance tests); today there is no
      // region-scoped wrapper to test, so filling this now would just re-pin the gap.
      it(`${roundTripTitle} — a host fn crosses in as a callable, out as a marshaling wrapper (not the SAME fn object, but SAME behavior)`, async () => {
        const out = exitJS(enter(() => 42));
        expect(typeof out).toBe("function");
        await expect((out as (...a: unknown[]) => unknown)()).resolves.toBe(42);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, () => 42, {}, PROV);
        expect(stamped).toBeInstanceOf(ARosettaProcedure);
        expect([...stamped.provenance]).toEqual([...PROV]);
      });
      break;
    }

    case "proper list (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only — no JS value produces this entry form
      it(exitTitle, () => {
        const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)]);
        const out = toJS(list);
        // R9: the proxy is observationally a plain array — deep-equal to the eager
        // projection, native Array.isArray, JSON round-trips.
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2, 3]);
        expect(JSON.stringify(out)).toBe("[1,2,3]");
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        // Not just a synthetic toJS(hand-built-APair) call — a real parsed/evaluated
        // program's exec() result (RULINGS.md R1's actual end-to-end contract).
        const [out] = await exec("(list 1 2 3)");
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2, 3]);
        expect(JSON.stringify(out)).toBe("[1,2,3]");
      });
      it(roundTripTitle, () => {
        const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2)]);
        const out = toJS(list);
        expect(Array.isArray(out)).toBe(true);
        expect(Object.keys(out as object).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        // scheme→JS only — no entry side to check; exit must leave the array (and its
        // elements) with no stray `provenance` property.
        const list = APair.fromArray(CONSTANT_CTX, [new AExact(1)]);
        const out = toJS(list) as unknown[];
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out[0]);
      });
      // RESOLVED (V ruling 2026-07-13, "nil-as-array"): the open design question closed —
      // the empty list exits as [] like every proper list exits as an array; emptiness no
      // longer flips the JS type. The feared "deep rewrite of runtime" was one method
      // (ANil["arrival/toJS"]). Reverse metadata is NOT preserved by design: ingress stays
      // permissive/borrowing (null → nil, [] → borrowed vector) — projection∘borrow, not id.
      it("exit: (list) — the empty list — as an empty array, not null (resolved: nil-as-array)", () => {
        expect(toJS(nil)).toEqual([]);
      });
      break;
    }

    case "dotted pair (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only
      it(exitTitle, () => {
        const dotted = new APair(new AExact(1), new AExact(2));
        expect(toJS(dotted)).toEqual([1, 2]);
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        const [out] = await exec("(cons 1 2)");
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2]);
      });
      it(`${roundTripTitle} — no {__dotted__} escape shape`, () => {
        const dotted = new APair(new AExact(1), new AExact(2));
        const out = toJS(dotted);
        expect(Array.isArray(out)).toBe(true);
        expect(Object.keys(out as object).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        const dotted = new APair(new AExact(1), new AExact(2));
        const out = toJS(dotted) as unknown[];
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out[0]);
        expectNoProvenanceProperty(out[1]);
      });
      break;
    }

    case "native vector (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only — enter(array) mints a BORROWED AJSArray, never an AVector
      it(exitTitle, () => {
        const vec = new AVector([new AExact(1), new AString("two"), new AExact(3)]);
        const out = toJS(vec);
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, "two", 3]);
        expect(JSON.stringify(out)).toBe('[1,"two",3]');
        expect([...(out as unknown[])]).toEqual([1, "two", 3]); // spread/iteration
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        const [out] = await exec('#(1 "two" 3)');
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, "two", 3]);
        expect(JSON.stringify(out)).toBe('[1,"two",3]');
      });
      it(roundTripTitle, () => {
        const vec = new AVector([new AExact(1)]);
        const out = toJS(vec) as object;
        expect(Object.keys(out).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        const stamped = new AVector([new AExact(1, 1, PROV)], PROV);
        const out = toJS(stamped) as unknown[];
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out[0]);
        expect(out[0]).toBe(1); // the element unwrapped, not a box
      });
      break;
    }

    case "native dict (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only — enter(object) mints a BORROWED AJSObject, never an ADict
      it(exitTitle, () => {
        const dict = new ADict([
          [new ASymbol("a"), new AExact(1)],
          [new ASymbol("b"), new AString("two")],
        ]);
        const out = toJS(dict);
        expect(Array.isArray(out)).toBe(false);
        expect(out).toEqual({ a: 1, b: "two" });
        expect(JSON.stringify(out)).toBe('{"a":1,"b":"two"}');
        expect(Object.keys(out as object)).toEqual(["a", "b"]);
        expect({ ...(out as object) }).toEqual({ a: 1, b: "two" }); // spread
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        const [out] = await exec('(dict "a" 1 "b" "two")');
        expect(Array.isArray(out)).toBe(false);
        expect(out).toEqual({ a: 1, b: "two" });
        expect(JSON.stringify(out)).toBe('{"a":1,"b":"two"}');
      });
      it(roundTripTitle, () => {
        const dict = new ADict([[new ASymbol("a"), new AExact(1)]]);
        const out = toJS(dict) as object;
        expect(Object.keys(out).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        const dict = new ADict([[new ASymbol("a"), new AExact(1, 1, PROV)]], PROV);
        const out = toJS(dict) as Record<string, unknown>;
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out.a);
        expect(out.a).toBe(1);
      });
      break;
    }

    default: {
      // Exhaustiveness guard: a row added to the table without a case here is a
      // design bug the stub grid should catch (F3 design note: "a stub grid that
      // can't express an invariant is a design bug caught free").
      throw new Error(`crossing.law.test.ts: unhandled crossing row type "${row.type}" — add a case above`);
    }
  }
});

describe("R9 lazy egress laws — containers exit as ref-tracking proxies (RULINGS.md R9)", () => {
  it("identity: the same box always egresses as the SAME proxy", () => {
    const vec = new AVector([new AExact(1)]);
    expect(toJS(vec)).toBe(toJS(vec));
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(1)]);
    expect(toJS(list)).toBe(toJS(list));
    const dict = new ADict([[new ASymbol("a"), new AExact(1)]]);
    expect(toJS(dict)).toBe(toJS(dict));
  });

  it("aliasing: a child container shared by two parents egresses as ONE object (reference equality observable from JS)", () => {
    const child = new AVector([new AExact(42)]);
    const parentA = new AVector([child]);
    const parentB = new ADict([[new ASymbol("kid"), child]]);
    const outA = toJS(parentA) as unknown[];
    const outB = toJS(parentB) as Record<string, unknown>;
    expect(outA[0]).toBe(outB.kid);
    expect(outA[0]).toBe(toJS(child));
  });

  it("cycles: a container reaching itself through an element egresses without recursion (WeakMap registration precedes materialization)", () => {
    // Immutable values can't self-reference through the language; build the knot on the
    // JS side, exactly how a host embedding could — the payload array is captured by
    // reference, so pushing after construction closes the cycle.
    const payload: SchemeValue[] = [];
    const vec = new AVector(payload);
    payload.push(vec);
    const out = toJS(vec) as unknown[];
    expect(out[0]).toBe(out); // the reach-back resolves to the SAME proxy, structurally
    // …and the result behaves like a genuinely cyclic plain array (observationally
    // plain JS): JSON refuses it the same way it refuses any circular structure.
    expect(() => JSON.stringify(out)).toThrow(/circular/i);
  });

  it("laziness: an element's unwrap runs on first read, not at egress (second read is a cache hit — same materialized object)", () => {
    const inner = new AVector([new AExact(7)]);
    const outer = new AVector([inner]);
    const out = toJS(outer) as unknown[];
    const first = out[0];
    expect(first).toBe(out[0]); // target-as-cache: one materialization, stable identity
    expect(first).toBe(toJS(inner)); // and it IS the child's own canonical proxy
  });

  it("write family throws the taught membrane door (P5 — the egressed value is a projection, not a mailbox)", () => {
    const vec = new AVector([new AExact(1)]);
    const arr = toJS(vec) as unknown[];
    expect(() => {
      arr[0] = 99;
    }).toThrow(/writes are banned/);
    expect(() => {
      delete arr[0];
    }).toThrow(/mutations are banned/);
    expect(() => Object.defineProperty(arr, "0", { value: 99 })).toThrow(/mutations are banned/);
    expect(() => Object.setPrototypeOf(arr, null)).toThrow(/mutations are banned/);
    const dict = new ADict([[new ASymbol("a"), new AExact(1)]]);
    const obj = toJS(dict) as Record<string, unknown>;
    expect(() => {
      obj.a = 99;
    }).toThrow(/writes are banned/);
    expect(() => {
      delete obj.a;
    }).toThrow(/mutations are banned/);
    expect((toJS(vec) as unknown[])[0]).toBe(1);
    expect((toJS(dict) as Record<string, unknown>).a).toBe(1);
  });
});

describe("R9 RE-ADMISSION — jsToScheme∘toJS = id on containers (the bifunctor law closes the container leg, egress-proxy.ts's PROXY_ORIGIN)", () => {
  const PROV = new Set<number>([777]);

  it("list: round-trips to the SAME box (eq?/reference); car/cdr still work", () => {
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2)]) as APair<AExact, any>;
    const out = toJS(list);
    const back = jsToScheme(CONSTANT_CTX, out);
    expect(back).toBe(list);
    expect(back["arrival/tagless-final/car"]()).toBe(list.car);
  });

  it("vector: round-trips to the SAME box", () => {
    const vec = new AVector([new AExact(1), new AExact(2)]);
    const out = toJS(vec);
    const back = jsToScheme(CONSTANT_CTX, out);
    expect(back).toBe(vec);
  });

  it("dict: round-trips to the SAME box", () => {
    const dict = new ADict([[new ASymbol("a"), new AExact(1)]]);
    const out = toJS(dict);
    const back = jsToScheme(CONSTANT_CTX, out);
    expect(back).toBe(dict);
  });

  it("re-admission goes through the SAME 'AValue → identity / provenance re-stamp' row: a fresh provenance stamp on re-entry unions onto the original box's own lineage, never overwrites", () => {
    const vec = new AVector([new AExact(1)]);
    const out = toJS(vec);
    const stamped = jsToScheme(CONSTANT_CTX, out, {}, PROV);
    // A fresh stamp forces a re-stamp (not the identity fast path) — but it's still the
    // registry's EXISTING "AValue → identity" row doing the work (re-dispatched with the
    // ORIGINAL box), not a duplicated re-stamp implementation in the new R9 row.
    expect(stamped).not.toBe(vec); // withProvenance mints a fresh wrapper on a lineage change…
    expect([...stamped.provenance]).toEqual([...PROV]); // …but the union is the SAME merge law.
    expect(vec.provenance.size).toBe(0); // the original is untouched.
  });

  it("a plain (non-egressed) array/object still borrows FRESH — R9 re-admission never fires on ordinary JS data", () => {
    expect(jsToScheme(CONSTANT_CTX, [1, 2, 3]).constructor.name).toBe("AJSArray");
    expect(jsToScheme(CONSTANT_CTX, { a: 1 }).constructor.name).toBe("AJSObject");
  });

  it("an array-shaped R9 proxy (a vector's egress) is re-admitted as the ORIGINAL vector, not re-borrowed as an AJSArray — the ordering-is-load-bearing row placement", () => {
    const vec = new AVector([new AExact(9)]);
    const out = toJS(vec); // Array.isArray(out) is true — the proxy target is `[]`
    expect(Array.isArray(out)).toBe(true);
    const back = jsToScheme(CONSTANT_CTX, out);
    expect(back).toBeInstanceOf(AVector);
    expect(back).toBe(vec); // NOT a fresh AJSArray wrapping the proxy
  });
});

describe("foreign Proxy at the membrane — freeze failure doors loudly (P5), never leaves the source silently mutable", () => {
  it("a Proxy whose ownKeys trap violates the invariants Object.freeze requires throws ForeignProxyFreezeError, naming the cause", () => {
    // A `ownKeys` trap that reports a key `getOwnPropertyDescriptor` refuses to back is a
    // Proxy invariant violation — `Object.freeze`'s own internal `[[OwnPropertyKeys]]` walk
    // throws a TypeError on it. This is the "genuinely foreign Proxy" case the new door exists
    // for; an ordinary object/array always freezes cleanly (js-wrapper-freeze.test.ts).
    const target: Record<string, unknown> = {};
    const foreign = new Proxy(target, {
      ownKeys() {
        return ["ghost"];
      },
      getOwnPropertyDescriptor(t, key) {
        if (key === "ghost") return undefined; // disagrees with ownKeys — the invariant break
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    const wrapped = new AJSObject(foreign);
    expect(() => wrapped.has("x")).toThrow(/foreign Proxy with a non-standard ownKeys trap/);
  });

  it("the same door fires for AJSArray over a foreign Proxy", () => {
    const target: unknown[] = [];
    const foreign = new Proxy(target, {
      ownKeys() {
        return ["0", "length"];
      },
      getOwnPropertyDescriptor(t, key) {
        if (key === "0") return undefined; // disagrees with ownKeys
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    }) as unknown[];
    const wrapped = new AJSArray(foreign);
    expect(() => wrapped.length).toThrow(/foreign Proxy with a non-standard ownKeys trap/);
  });
});

describe.each(VIOLATIONS.map((v) => [v.name, v] as const))("forbidden crossing: %s", (_n, v) => {
  const title = `throws the teaching door: ${String(v.door)} (P5 — loud at the crossing, never later)`;

  switch (v.name) {
    case "bare Promise into jsToScheme": {
      it(title, () => {
        expect(() => jsToScheme(CONSTANT_CTX, Promise.resolve(1))).toThrow(v.door);
        // A non-plain thenable (async-shaped class instance) doors the same way —
        // only a PLAIN-prototype thenable stays a dict-shaped borrow (registry order:
        // the plain-object claim precedes the promise claim).
        class Deferred {
          then(res: (x: number) => void): void {
            res(1);
          }
        }
        expect(() => jsToScheme(CONSTANT_CTX, new Deferred())).toThrow(v.door);
      });
      break;
    }

    case "raw JS value into toJS": {
      it(title, () => {
        // Deliberately breach the type-level door: `toJS`'s parameter is `SchemeValue` —
        // passing a raw number requires an explicit unsound `never` cast. That breach IS
        // the test: the runtime invariant must catch what the type system alone would have
        // refused to compile.
        expect(() => toJS(42 as never)).toThrow(v.door);
      });
      break;
    }

    case "membrane write": {
      it(title, () => {
        const source: { a: number } = { a: 1 };
        const obj = new AJSObject(source);
        expect(() => obj.set("a", new AExact(42))).toThrow(v.door);
        expect(source.a).toBe(1);
      });
      break;
    }

    case "membrane delete": {
      it(title, () => {
        const source: { a: number } = { a: 1 };
        const obj = new AJSObject(source);
        expect(() => obj.delete("a")).toThrow(v.door);
        expect(source.a).toBe(1);
      });
      break;
    }

    default: {
      throw new Error(`crossing.law.test.ts: unhandled violation row "${v.name}" — add a case above`);
    }
  }
});

describe("forgery guard: a borrowed object's own arrival/*-named key is DATA, never protocol (F3, key-taxonomy corollary — PRINCIPLES.md P7 / RULINGS.md key taxonomy)", () => {
  // The key taxonomy puts algebra instruction keys ("arrival/class" — retired, "arrival/toJS",
  // …) in plain-string space so every static interpreter can read them as data — which means a
  // FOREIGN object crossing inbound can carry an own data property with that exact name by
  // coincidence. The guard is structural: the object ladder wraps a plain object in an
  // AJSObject, and every protocol read is off the WRAPPER — never the source's data keys.
  it('jsToScheme({"arrival/class": "fake"}) crosses as plain data — the forged key never masquerades as protocol', () => {
    const forged = { "arrival/class": "fake" };
    const entered = enter(forged) as AJSObject;
    expect(entered).toBeInstanceOf(AJSObject);
    // The protocol identity is the WRAPPER's own class — never derived from the wrapped
    // source's data. AJSObject extends AValue, so it answers the family's interop-boundary
    // check regardless of what data keys the wrapped source happens to carry.
    expect(entered.constructor).toBe(AJSObject);
    expect(isInteropBoundary(AJSObject.prototype)).toBe(true);
    // The forged key round-trips as ordinary data through the read protocol.
    const read = entered.get("arrival/class");
    expect(read).toBeInstanceOf(AString);
    expect((read as AString).valueOf()).toBe("fake");
  });

  it('jsToScheme({"arrival/toJS": fn}) crosses as plain data — the forged key is never invoked as the toJS protocol method', () => {
    const forged = { "arrival/toJS": () => "pwned" };
    const entered = enter(forged) as AJSObject;
    expect(entered).toBeInstanceOf(AJSObject);
    // toJS(entered) invokes the WRAPPER's own `arrival/toJS` method (AJSObject.ts), which
    // reconstructs a plain object from the source's members — it never looks up (let alone
    // calls) a same-named key living ON the source.
    const out = toJS(entered) as Record<string, unknown>;
    expect(typeof out["arrival/toJS"]).toBe("function");
    expect(out["arrival/toJS"]).toBe(forged["arrival/toJS"]); // crosses back unchanged, uninvoked
  });
});

// ── Egress membrane exit laws (docs/design-history/arrival-egress-membrane-exit.md) ──
// ONE crossing protocol `arrival/toJS(exit?)`, keyed on `exit`: no exit = SERIALIZATION
// (callables stringify — a law, not an accident), exit present = MEMBRANE crossing
// (options + reverse-membrane wrappers reach every depth). Identity: bare=(box);
// membrane=(box, mode, SCOPE).
describe("egress membrane exit — the two modes and their identity laws", () => {
  const native = (tag: string): ANativeProcedure =>
    new ANativeProcedure({
      name: `test-${tag}`,
      arity: { min: 0, max: null },
      contract: undefined,
      impl: (_args, runCtx) => new AExact(7),
    });
  const dictOf = (entries: ReadonlyArray<readonly [string, SchemeValue | Promise<SchemeValue>]>): ADict =>
    new ADict(entries.map(([k, v]) => [new ASymbol(k), v] as const));

  it("nested callable crosses as a host FUNCTION via toJS AND membrane.toJS (the flip, pinned)", async () => {
    const d = dictOf([["f", native("a")]]);
    const viaRosetta = toJS(d) as Record<string, unknown>;
    expect(typeof viaRosetta.f).toBe("function");
    // Invoking round-trips through the reverse membrane (DETACHED scope — always open).
    await expect((viaRosetta.f as () => Promise<unknown>)()).resolves.toBe(7);
    // membrane.toJS (exec's exit) shares the default-mode slot — same face, same proxy.
    const viaToJS = toJS(d) as Record<string, unknown>;
    expect(typeof viaToJS.f).toBe("function");
    expect(viaToJS).toBe(viaRosetta);
  });

  it("depth ≥ 2: the innermost callable crosses as a host FN under membrane AND bare (toJS is the membrane)", async () => {
    const inner = dictOf([["f", native("deep")]]);
    const outerDict = dictOf([["inner", inner]]);
    const outerVec = new AVector([inner]);
    const viaDict = toJS(outerDict) as { inner: { f: unknown } };
    expect(typeof viaDict.inner.f).toBe("function");
    const viaVec = toJS(outerVec) as unknown as ReadonlyArray<{ f: unknown }>;
    expect(typeof viaVec[0].f).toBe("function");
    // Bare protocol answers the SAME faithful crossing (previously the print string —
    // the display/membrane conflation this law now pins the fix of). Display is
    // `arrival/print`'s job; a callable's toJS is host-callable at every depth.
    const bare = outerDict["arrival/toJS"]() as { inner: { f: unknown } };
    expect(typeof bare.inner.f).toBe("function");
    // Region-disciplined (ACallable.ts's hostProjectionOf): always resolves via withRegionCall.
    await expect((bare.inner.f as () => Promise<unknown>)()).resolves.toBe(7);
  });

  it("mode isolation: bare vs mem are distinct, stable slots (the forceBigInt mem:0/mem:1 split retired — one membrane mode now)", () => {
    const d = dictOf([["n", new AExact(1)]]);
    const bare1 = d["arrival/toJS"]();
    const bare2 = d["arrival/toJS"]();
    expect(bare1).toBe(bare2);
    const mem1 = toJS(d);
    const mem2 = toJS(d);
    expect(mem1).toBe(mem2); // same DETACHED scope, same mode
    expect(bare1).not.toBe(mem1);
    // Wrapper-call-only options never split the mode — and since forceBigInt (the one
    // field that used to) is retired, modeKeyOf is now a constant.
    expect(modeKeyOf({})).toBe("mem");
    expect(modeKeyOf({ returnEither: true })).toBe("mem");
    expect(modeKeyOf({ argProvenance: true })).toBe("mem");
  });

  it("membrane proxies are SCOPE-owned: a second invocation mints its own; the closed scope's wrapper doors", async () => {
    const d = dictOf([["f", native("scoped")]]);
    const scopeA = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const proxyA = withRegionScope(scopeA, () => toJS(d)) as Record<string, unknown>;
    const fnA = proxyA.f as () => Promise<unknown>; // materializes lazily — under the PINNED scopeA
    closeRegionScope(scopeA);
    await expect(fnA()).rejects.toThrow(RegionEscapeError); // A's discipline, not silent CONSTANT_CTX
    const scopeB = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const proxyB = withRegionScope(scopeB, () => toJS(d)) as Record<string, unknown>;
    expect(proxyB).not.toBe(proxyA); // (box, mode, SCOPE) — never resurrect A's projection
    await expect((proxyB.f as () => Promise<unknown>)()).resolves.toBe(7); // B is live
    closeRegionScope(scopeB);
    // Scope-less egress (DETACHED singleton) is a third, distinct identity.
    const detached = toJS(d);
    expect(detached).not.toBe(proxyA);
    expect(detached).not.toBe(proxyB);
  });

  it("crossing law: bare toJS on a callable-bearing dict yields a host FN (display is print's job)", async () => {
    const d = dictOf([["f", native("ser")]]);
    const bare = d["arrival/toJS"]() as Record<string, unknown>;
    expect(typeof bare.f).toBe("function");
    // Region-disciplined now (the toJS-protocol collapse, ACallable.ts's hostProjectionOf):
    // every host projection — bare or membrane — resolves through `withRegionCall`, so the
    // wrapper always answers a Promise, never a bare synchronous value.
    await expect((bare.f as () => Promise<unknown>)()).resolves.toBe(7);
    // The display face did not move — it lives on `arrival/print`, unchanged.
    expect(native("ser")["arrival/print"]()).toMatch(/^#<procedure:/);
  });

  it("ADict pending entry settling to a callable: host FN through BOTH exits", async () => {
    const membraneDict = dictOf([["f", Promise.resolve<SchemeValue>(native("pend-m"))]]);
    const viaMembrane = toJS(membraneDict) as Record<string, unknown>;
    expect(typeof (await viaMembrane.f)).toBe("function");
    const bareDict = dictOf([["f", Promise.resolve<SchemeValue>(native("pend-b"))]]);
    const viaBare = bareDict["arrival/toJS"]() as Record<string, unknown>;
    expect(typeof (await viaBare.f)).toBe("function");
  });

  it("wrapper cache is (callable, scope)-keyed: repeated egress in the same scope shares a wrapper (identity-stable; the old mem:0/mem:1 comparison retired with forceBigInt)", () => {
    const f = native("wrap");
    const d = dictOf([["f", f]]);
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const p0 = withRegionScope(scope, () => toJS(d)) as Record<string, unknown>;
    const w0 = p0.f;
    const w0again = (withRegionScope(scope, () => toJS(d)) as Record<string, unknown>).f;
    expect(typeof w0).toBe("function");
    expect(w0).toBe(w0again); // same (callable, scope, mem) — the wrapper closes over options
    closeRegionScope(scope);
  });

  it("THE TWO-CACHES SPLIT IS DEAD: toJS of a dict holding a callable answers the SAME wrapper as a direct protocol call on that callable, under the same scope (ACallable.ts's hostProjectionOf is the ONE cache)", async () => {
    const f = native("unified");
    const d = dictOf([["f", f]]);
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const viaDict = (withRegionScope(scope, () => toJS(d)) as Record<string, unknown>).f;
    const viaDirect = withRegionScope(scope, () => f["arrival/toJS"]());
    expect(typeof viaDict).toBe("function");
    expect(viaDict).toBe(viaDirect);
    await expect((viaDirect as () => Promise<unknown>)()).resolves.toBe(7);
    closeRegionScope(scope);
  });
});
