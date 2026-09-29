/**
 * LAW — the inbound claim registry (rosetta.ts INBOUND_CLAIMS) and the lazy
 * pending cells (values/primitives/pending-entry.ts).
 *
 * 1. REGISTRY ORDER IS LAW: jsToScheme's whole value-kind algebra is one declared,
 *    ordered table — first claiming row wins. The table is now three PHASES
 *    (rosetta.ts's own doc on OWNED_ARTIFACT_CLAIMS/FOREIGN_LENS_CLAIMS/
 *    INCOMPATIBILITY_DOOR_CLAIMS is the law): phase 1 (owned-artifact recognition)
 *    entirely before phase 2 (the foreign lens table) entirely before phase 3 (the
 *    incompatibility door). This file pins the flat concatenation's names IN ORDER
 *    so a reorder (or a silently added/removed claim) is a diff in a law test,
 *    never an accident.
 *
 * 2. PENDING CELLS: a Promise VALUE inside a structure (AJSObject/ADict entry,
 *    AJSArray element) is held INERT and settles lazily on FIRST ACCESS (maybeThen
 *    discipline: one settle chain, shared by concurrent readers), the settled box
 *    replaces the cell (sync-after-settled), and the box carries the container's
 *    provenance. A bare Promise reaching jsToScheme directly DOORS
 *    (jsToSchemeAsyncDoor — crossing.law.test.ts owns that violation row).
 *
 * 3. THE BINARY MEMBRANE (V's ruling, 2026-07-23): the warn-and-degrade middle tier
 *    is RETIRED. `undefined` is now a plain lens (no warn). A unique JS symbol, a
 *    host bigint, and an unbranded/exotic class instance (Date/Map/Set/RegExp/a
 *    plain class) now DOOR (`NoLensError`) instead of silently degrading to `#void`,
 *    raw-passthrough, or borrowing as an untethered AJSObject with a console
 *    warning — crossing.law.test.ts owns the per-shape crossing rows; here we pin
 *    "nothing non-scheme escapes the router UNCLAIMED" over a sweep of exotic shapes
 *    (a host `Error` is its own declared lens, carved out of the sweep —
 *    error-object-exit.law.test.ts owns that law).
 */
import { describe, expect, it } from "vitest";
import { INBOUND_CLAIMS, jsToScheme } from "../rosetta.js";
import { NoLensError } from "../../errors.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { APair } from "../../values/primitives/APair.js";
import { ADict } from "../../values/primitives/ADict.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";
import { eof } from "../../values/primitives/EOF.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

const PROV = new Set<number>([4242]);

describe("inbound registry — the declared, ordered claim table IS the law", () => {
  it("pins the claim names in their declared order (a reorder is a law diff, not an accident)", () => {
    expect(INBOUND_CLAIMS.map((c) => c.name)).toEqual([
      // PHASE 1 — owned-artifact recognition.
      "AValue → identity / provenance re-stamp (class term)",
      "R9 egress proxy → original box (re-admission)",
      "reverse-membrane wrapper → original callable (re-admission)",
      "reader token (EOF) → identity (not a SchemeValue)",
      "scheme orphan (R7RSError) → identity",
      "branded host instance → opaque handle (mint/reuse, whiteroom contract)",
      // PHASE 2 — the foreign lens table.
      "null → nil",
      "undefined → #void (lens)",
      "object → array/plain-object containment ladder",
      "host Error → borrowed AJSObject (declared lens)",
      "inherited interop-boundary → borrowed AJSObject (read-policy, not opaque)",
      "scalar → boxer table (fromJs)",
      "symbol → :keyword (registered)",
      "binary (Uint8Array/ArrayBuffer/DataView/Buffer) → raw passthrough (declared)",
      "function → callable (reverse membrane: args scheme→js, result js→scheme)",
      // PHASE 3 — the incompatibility door.
      "promise → door (settle first; container entries settle lazily)",
      "unique symbol → door (no lens)",
      "bigint → door (no lens)",
      "unbranded/exotic object → door (no lens)",
    ]);
  });

  it("order is semantic: a PLAIN-prototype thenable is claimed by the plain-object row, not the promise door", () => {
    const thenable = { then: 42, data: "not actually async" };
    const entered = jsToScheme(CONSTANT_CTX, thenable);
    expect(entered).toBeInstanceOf(AJSObject);
    expect(entered.source).toBe(thenable);
  });

  it("reader token (EOF) passes by identity — not a SchemeValue, not an opaque handle", () => {
    expect(jsToScheme(CONSTANT_CTX, eof)).toBe(eof);
    // …and a provenance stamp has no carrier: still identity.
    expect(jsToScheme(CONSTANT_CTX, eof, {}, PROV)).toBe(eof);
  });

  it("no lens ⇒ a loud door, never a silent raw leak (exotic sweep — the binary membrane's phase 3)", () => {
    for (const exotic of [new Date(0), new Map([["k", 1]]), new Set([1]), /re/]) {
      expect(() => jsToScheme(CONSTANT_CTX, exotic)).toThrow(NoLensError);
      try {
        jsToScheme(CONSTANT_CTX, exotic);
      } catch (e) {
        expect(e).toBeInstanceOf(NoLensError);
        expect((e as NoLensError).kind).toBe("unbranded-class");
      }
    }
    // A host Error is its OWN declared lens (phase 2, no warn), carved out of the
    // sweep — error-object-exit.law.test.ts owns the full law (stack hidden, message
    // readable).
    const err = new Error("boom");
    const entered = jsToScheme(CONSTANT_CTX, err);
    expect(entered).toBeInstanceOf(AJSObject);
    expect((entered as AJSObject).source).toBe(err);
    // The declared exception, by name: binary FFI identity.
    const u8 = new Uint8Array([1]);
    expect(jsToScheme(CONSTANT_CTX, u8)).toBe(u8);
  });

  it("deep re-stamp went CLASS-SIDE: a fresh stamp on a pair spine mints a fresh spine via arrival/withProvenanceDeep, children inherit the stamp; identity fast paths hold", () => {
    const car = new AString("a");
    const cdr = new AExact(1);
    const pair = new APair(car, cdr);

    // Empty stamp → identity fast path (no clone).
    expect(jsToScheme(CONSTANT_CTX, pair)).toBe(pair);

    // Fresh stamp → the class's own deep re-stamp: fresh spine, fresh children, all
    // carrying the new lineage (spec §5.3 Interpretation A, byte-stable with the
    // dissolved router arms) — the original spine untouched.
    const stamped = jsToScheme(CONSTANT_CTX, pair, {}, PROV);
    expect(stamped).toBeInstanceOf(APair);
    expect(stamped).not.toBe(pair);
    expect([...stamped.provenance]).toEqual([...PROV]);
    expect([...(stamped.car as AString).provenance]).toEqual([...PROV]);
    expect([...(stamped.cdr as AExact).provenance]).toEqual([...PROV]);
    expect(car.provenance.size).toBe(0);

    // A leaf re-stamps shallowly (withProvenance — no deep term needed).
    const leaf = jsToScheme(CONSTANT_CTX, car, {}, PROV);
    expect(leaf).toBeInstanceOf(AString);
    expect(leaf).not.toBe(car);
    expect([...leaf.provenance]).toEqual([...PROV]);
  });
});

describe("pending cells — a Promise inside a structure settles lazily on first access (maybeThen discipline)", () => {
  it("promise-in-DICT: first read returns the settle chain; it resolves to the boxed value CARRYING the dict's provenance; the read is SYNC after settlement", async () => {
    const dict = new ADict([[new ASymbol(":answer"), Promise.resolve(42) as unknown as Promise<SchemeValue>]], PROV);

    const first = dict.get("answer");
    expect(first).toBeInstanceOf(Promise);

    // Concurrent read during pendency shares the SAME chain — one settlement, ever.
    expect(dict.get("answer")).toBe(first);

    const settled = await (first as Promise<SchemeValue>);
    expect(settled).toBeInstanceOf(AExact);
    expect((settled as AExact).valueOf()).toBe(42);
    // Provenance carried: the raw settled value inherits the container's lineage.
    expect([...(settled as AExact).provenance]).toEqual([...PROV]);

    // Sync after settlement: the slot now holds the settled box itself.
    const second = dict.get("answer");
    expect(second).not.toBeInstanceOf(Promise);
    expect(second).toBe(settled);
  });

  it("promise-in-DICT: an already-AValue settlement passes through jsToScheme's fast path (same stamp → identity)", async () => {
    const boxed = new AString("ready", PROV);
    const dict = new ADict([[new ASymbol(":v"), Promise.resolve(boxed)]], PROV);
    const settled = await Promise.resolve(dict.get("v"));
    expect(settled).toBe(boxed);
    expect(dict.get("v")).toBe(boxed); // sync + identity thereafter
  });

  it("promise-in-AJSObject entry: settles on first .get, caches the box, sync after settlement", async () => {
    const source = { eager: "now", lazy: Promise.resolve("later") };
    const wrapper = new AJSObject(source, PROV);

    // The sync entry stays sync — pendency of a SIBLING never taxes it.
    const eager = wrapper.get("eager");
    expect(eager).toBeInstanceOf(AString);

    const first = wrapper.get("lazy");
    expect(first).toBeInstanceOf(Promise);
    expect(wrapper.get("lazy")).toBe(first); // shared chain during pendency

    const settled = await (first as Promise<SchemeValue>);
    expect(settled).toBeInstanceOf(AString);
    expect((settled as AString).valueOf()).toBe("later");
    expect([...(settled as AString).provenance]).toEqual([...PROV]); // container lineage

    const second = wrapper.get("lazy");
    expect(second).toBe(settled); // sync-after-settled, stable identity
  });

  it("promise-in-AJSArray element: vector-ref settles on first access, sync after settlement, container provenance carried", async () => {
    const arr = new AJSArray([1, Promise.resolve(2)], PROV);

    // Sync element: unchanged, no pendency tax.
    const sync = arr[tf("vector-ref")](0);
    expect(sync).toBeInstanceOf(AExact);

    const first = arr[tf("vector-ref")](1);
    expect(first).toBeInstanceOf(Promise);
    expect(arr[tf("vector-ref")](1)).toBe(first); // shared chain during pendency

    const settled = await (first as Promise<SchemeValue>);
    expect(settled).toBeInstanceOf(AExact);
    expect((settled as AExact).valueOf()).toBe(2);
    expect([...(settled as AValue).provenance]).toEqual([...PROV]);

    const second = arr[tf("vector-ref")](1);
    expect(second).toBe(settled); // sync-after-settled
  });

  it("egress of a pending DICT entry: the proxy read hands JS a Promise of the UNWRAPPED value, never a boxed AValue", async () => {
    const dict = new ADict([[new ASymbol(":n"), Promise.resolve(7) as unknown as Promise<SchemeValue>]]);
    const out = dict["arrival/toJS"]();
    const pending = out.n;
    expect(pending).toBeInstanceOf(Promise);
    const value = await (pending as Promise<unknown>);
    expect(value).toBe(7); // plain JS — the box unwrapped through its own arrival/toJS
    expect(value instanceof AValue).toBe(false);
  });
});
