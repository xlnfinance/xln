/**
 * LAW N1b — LOCATION: every parsed value carries its source span on `.location`, an
 * IMMUTABLE, constructor-only channel living on the `AValue` base (see AValue.ts) —
 * not just on APair anymore. This supersedes the old two-channel ctx-mirror design
 * (a parse-origin `RunContext` / `PARSE_CTX` MIRRORING a mutating `setLocation()`
 * write) this file used to pin against `ctxOf`/`isParseCtx`:
 *
 *   (a) A parsed LEAF/CONTAINER literal's `.location` carries its source span — the
 *       capability the ctx-mirror design never delivered: strings/numbers/chars/
 *       vectors/bytevectors/dicts are ALL located now, not just APair. SYMBOLS are
 *       the one adjudicated carve-out: ASymbol's flyweight interning is keyed by
 *       identity, and raw `===` on interned symbols is load-bearing (memq/assq, the
 *       specials table), so parsed symbols carry NO location at all — per-occurrence
 *       span is blocked on those `===` sites delegating to `eq()` (see
 *       parse_argument's note).
 *   (b) Every spine cell of a parsed list is located; the list head carries the
 *       OPEN-PAREN's own location; the quote-family INNER cell (`'x`'s `(x . ())`)
 *       is now located too — CLOSING the one gap the old ctx-mirror channel never
 *       covered (it rode the ctx alone, which the mirror-agreement law never
 *       verified past APair's own `[LOCATION]` slot).
 *   (c) [RETIRED] — the old "parse ctxs carry no run state" / `isParseCtx`
 *       boundary pins pinned a run-CONTEXT species (cache, effects,
 *       signal — all `undefined` on the parse family). `.location` is not a run
 *       context at all — it is plain per-value data, so it has none of those facets
 *       to assert; there is nothing left to retire INTO, the whole species is gone
 *       from this file.
 *
 * Plus the two boundary pins the audit called out, re-pinned via plain reference
 * identity (no ctx):
 *   - the NOT-subsumed singletons (#t/#f/±inf/nan, the specials quote-symbol table)
 *     stay shared-by-reference across parses — never per-occurrence, never located;
 *   - per-occurrence symbol identity does not exist: parsed symbols stay flyweight-
 *     shared (memq/assq's `===` depends on it), carrying no location whatsoever.
 */
import { describe, expect, it } from "vitest";
import { parse } from "../../reader/parse.js";
import { eq } from "../../values/structural-equal.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { AVector } from "../../values/primitives/AVector.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { ADict } from "../../values/primitives/ADict.js";
import type { SourceLocation } from "../../errors.js";
import type { SchemeValue } from "../../values/types.js";

/** The location assertion: `.location` pins the leaf/container's offset (+ optional source). */
function expectParsedAt(value: { location?: SourceLocation }, src: string, token: string, source?: string) {
  expect(value.location).toBeDefined();
  expect(value.location!.offset).toBe(src.indexOf(token));
  if (source !== undefined) expect(value.location!.source).toBe(source);
}

/** Collect every reachable APair (spine + nested), cycle-safe. */
function allPairs(value: unknown, out: APair<any, any>[] = [], seen = new Set<unknown>()): APair<any, any>[] {
  if (!(value instanceof APair) || seen.has(value)) return out;
  seen.add(value);
  out.push(value);
  allPairs(value.car, out, seen);
  allPairs(value.cdr, out, seen);
  return out;
}

describe("law (a) — parsed leaf/container literals carry their source span on `.location`", () => {
  it("atoms: string, integer, float, character (symbols: see the interning carve-out row)", async () => {
    const src = String.raw`(foo "bar" 42 3.14 #\c)`;
    const [form] = await parse(src, "test.scm");
    const items: SchemeValue[] = [];
    for (let n: unknown = form; n instanceof APair; n = n.cdr) items.push(n.car);
    const [sym, str, int, flt, chr] = items;

    expect(sym).toBeInstanceOf(ASymbol);
    expect((sym as ASymbol).location).toBeUndefined(); // symbols: the interning carve-out
    expect(str).toBeInstanceOf(AString);
    expectParsedAt(str as AString, src, '"bar"', "test.scm");
    expect(int).toBeInstanceOf(AExact);
    expectParsedAt(int as AExact, src, "42", "test.scm");
    expect(flt).toBeInstanceOf(AInexact);
    expectParsedAt(flt as AInexact, src, "3.14", "test.scm");
    expect(chr).toBeInstanceOf(ACharacter);
    expectParsedAt(chr as ACharacter, src, String.raw`#\c`, "test.scm");
  });

  it("container literals: [] vector, #() vector, #u8() bytevector, {} dict", async () => {
    const src = "[1 2] #(3 4) #u8(5 6) {:a 7}";
    const [sq, hashVec, bytes, dict] = await parse(src);

    expect(sq).toBeInstanceOf(AVector);
    expectParsedAt(sq as AVector, src, "[");
    expect(hashVec).toBeInstanceOf(AVector);
    expectParsedAt(hashVec as AVector, src, "#(");
    expect(bytes).toBeInstanceOf(ABytevector);
    expectParsedAt(bytes as ABytevector, src, "#u8(");
    expect(dict).toBeInstanceOf(ADict);
    expectParsedAt(dict as ADict, src, "{");
  });

  it("elements INSIDE container literals carry their own leaf spans", async () => {
    const src = "[10 20]";
    const [vec] = await parse(src);
    const elements = (vec as AVector).valueOf() as SchemeValue[];
    expectParsedAt(elements[0] as AExact, src, "10");
    expectParsedAt(elements[1] as AExact, src, "20");
  });

  it("dict keys: string keys carry their span; keyword keys (symbols) stay interned-shared", async () => {
    const src = '{:a 1 b: 2 "c" 3}';
    const [dict] = await parse(src);
    const forms = (dict as ADict & { literalForms: readonly SchemeValue[] }).literalForms;
    expectParsedAt(forms[4] as AString, src, '"c"');
    // b: — the flip canonicalizes to the keyword twin: the interned symbol `:b`,
    // which — like every symbol — carries no location and stays reference-shared
    // with any other parse of `:b`.
    expect(String(forms[2])).toBe(":b");
    expect((forms[2] as ASymbol).location).toBeUndefined();
    const [kb] = await parse(":b");
    expect(forms[2]).toBe(kb);
  });

  it("quote-family expansion pairs carry the prefix span", async () => {
    const src = "'x";
    const [form] = await parse(src);
    expect(form).toBeInstanceOf(APair);
    const outer = form as APair<any, any>;
    expectParsedAt(outer, src, "'");
  });
});

describe("law (b) — every spine cell / re-stamped cell of a parsed list is located", () => {
  it("list head cells carry the OPEN-PAREN loc (the pre-existing final overwrite)", async () => {
    const src = "(a (b c))";
    const [form] = await parse(src);
    const outer = form as APair<any, any>;
    expect(outer.location?.offset).toBe(0);
    const inner = outer.cdr.car as APair<any, any>;
    expect(inner.location?.offset).toBe(src.indexOf("(b"));
  });

  it("the quote-family INNER cell is now located too (closes the old ctx-mirror gap)", async () => {
    const [form] = await parse("'x");
    const inner = (form as APair<any, any>).cdr as APair<any, any>;
    // Quote-family INNER cell (`'x`'s `(x . ())`) is located.
    expect(inner.location).toBeDefined();
    expect(inner.location?.offset).toBe(0);
  });

  it("every spine cell of a parsed list is located", async () => {
    const [form] = await parse("(a b c)");
    for (const pair of allPairs(form)) {
      expect(pair.location).toBeDefined();
    }
  });
});

describe("boundary pins — what the location channel deliberately does NOT subsume", () => {
  it("the true singletons stay shared by reference across parses (never per-occurrence, never located)", async () => {
    const [t1, inf1] = await parse("#t +inf.0");
    const [t2, inf2] = await parse("#t +inf.0");
    expect(t1).toBe(t2);
    expect(inf1).toBe(inf2);
  });

  it("the specials quote-symbol table stays shared (dispatch identity preserved)", async () => {
    const [q1] = await parse("'a");
    const [q2] = await parse("'b");
    expect((q1 as APair<any, any>).car).toBe((q2 as APair<any, any>).car);
  });

  it("parsed symbols stay flyweight-shared across parses, carrying no location (the interning carve-out — memq/assq's `===` depends on it)", async () => {
    const [a1] = await parse("foo");
    const [a2] = await parse("foo");
    expect(a1).toBe(a2); // ONE interned instance — reference identity preserved
    expect((a1 as ASymbol).location).toBeUndefined();
    expect(eq(a1, a2)).toBe(true);
  });
});
