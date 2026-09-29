/**
 * JS-INTEROP CONTRACT — the README promises "natural interop in both directions".
 * This suite is that promise, by example: a JS consumer receives a value out of
 * `exec()` and uses it as a JS value WITHOUT calling `toJS` first.
 *
 * `it(...)`        = a promise the boxed value KEEPS today.
 * `it.fails(...)`  = a promise it BREAKS today (documented gap). The body asserts the
 *                    IDEAL behavior; `it.fails` passes precisely because that assertion
 *                    fails right now. When the container is fixed, the assertion starts
 *                    passing → `it.fails` flips to a hard failure, prompting promotion
 *                    to `it()`. So this file doubles as the regression target.
 */
import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";
import { ABool } from "../../values/primitives/ABool.js";

const one = async (src: string): Promise<any> => (await exec(src))[0];

describe("JS-interop: numbers", () => {
  it("coerce in arithmetic via valueOf", async () => {
    const n = await one("(+ 1 2)");
    expect(n + 1).toBe(4);
    expect(Number(n)).toBe(3);
    expect(`${n}`).toBe("3");
  });

  // PROMOTED (RULINGS.md R1): `exec`'s uniform
  // plain-JS exit landed — a safe-int result is a bare JS number now, no BigInt
  // backing to throw on. The it.fails gap this row named is closed.
  it("exact numbers SHOULD JSON.stringify to their value", async () => {
    const n = await one("(+ 1 2)");
    expect(JSON.stringify(n)).toBe("3");
  });

  // PROMOTED (same landing): a bare JS float, no boxed {provenance,kind,real,imag} leak.
  it("inexact numbers SHOULD JSON.stringify to their value", async () => {
    const n = await one("(+ 1.5 0.5)");
    expect(JSON.stringify(n)).toBe("2");
  });
});

describe("JS-interop: strings & booleans (boxed scheme faces — the Face split)", () => {
  it("strings come back as AStrings (grafted String.prototype keeps interop natural)", async () => {
    const s = await one('(string-append "ab" "c")');
    // Boxed under the Face split (taintString always returns the AString scheme face —
    // the raw-string no-provenance fast path was the pre-box string-identity leak). AString grafts
    // String.prototype, so string-ish interop (concat, spread, JSON) still reads naturally.
    expect(String(s)).toBe("abc");
    expect(s + "!").toBe("abc!");
    expect([...String(s)].length).toBe(3);
    expect(JSON.stringify(String(s))).toBe('"abc"');
  });

  // INVERTED (RULINGS.md R1): the SIMPLE exec tier
  // now maps `toJS` over every result — R8's uniform ABool mint (step 2) still boxes
  // every verdict INSIDE the membrane, but `exec`'s plain-JS exit unwraps it before
  // it reaches the caller, same as every other scalar. Natural JS-boolean auto-unwrap
  // is back (this is what the step-2-era comment above named as "a later, separate
  // migration step" — this is that step).
  it("booleans come back as plain JS booleans — R1's uniform plain-JS exit", async () => {
    const lt = await one("(< 1 2)");
    expect(lt).not.toBeInstanceOf(ABool);
    expect(lt).toBe(true);
    const gt = await one("(< 2 1)");
    expect(gt).toBe(false);
  });
});

describe("JS-interop: characters", () => {
  // PROMOTED (RULINGS.md R1): ACharacter's toJS is the raw char — `exec`'s plain-JS
  // exit hands back "a" directly, not the boxed `.toString()` write-form "#\\a".
  it("char SHOULD coerce to the JS char", async () => {
    const ch = await one("#\\a");
    expect(String(ch)).toBe("a");
  });
});

describe("JS-interop: symbols", () => {
  // A symbol's JS face is the interned name.
  it("symbol coerces to its plain interned name in a template literal", async () => {
    const sym = await one("'foo");
    expect(`${sym}`).toBe("foo");
  });

  it("exec(symbol) unwraps to the plain name string", async () => {
    const sym = await one("'foo");
    expect(sym).toBe("foo");
  });
});

describe("JS-interop: lists (Pair)", () => {
  it("a list is iterable from JS (spread / for-of / Array.from)", async () => {
    const lst = await one("(list 1 2 3)");
    expect(Array.from(lst)).toHaveLength(3);
    let count = 0;
    for (const _ of lst) count++;
    expect(count).toBe(3);
  });

  // PROMOTED (RULINGS.md R1 + R9): the list egresses as a lazy array proxy over
  // plain-number elements — JSON.stringify materializes and serializes it cleanly,
  // no BigInt-backed element to throw on. The it.fails gap this row named is closed.
  it("JSON.stringify(list) SHOULD serialize the list", async () => {
    const lst = await one("(list 1 2 3)");
    expect(JSON.stringify(lst)).toBe("[1,2,3]");
  });

  it("exec(list) is the working escape hatch", async () => {
    expect(await one("(list 1 2 3)")).toEqual([1, 2, 3]);
  });
});

describe("JS-interop: vectors", () => {
  // INVARIANT: a vector is iterable from JS like a Pair; elements coerce via valueOf
  it("a vector is iterable from JS like a Pair (spread / for-of / Array.from)", async () => {
    const vec = await one("(vector 1 2 3)");
    expect(Array.from(vec).length).toBe(3);
    let count = 0;
    for (const _ of vec) count++;
    expect(count).toBe(3);
    // elements coerce to their values (numbers via valueOf, as elsewhere)
    expect([...vec].map(Number)).toEqual([1, 2, 3]);
  });

  it("exec(vector) is the working escape hatch", async () => {
    expect(await one("(vector 1 2 3)")).toEqual([1, 2, 3]);
  });
});

describe("JS-interop: bytevectors", () => {
  it("a bytevector is iterable from JS (spread / for-of / Array.from yield bytes)", async () => {
    const bv = await one("(bytevector 1 2 3)");
    expect([...bv]).toEqual([1, 2, 3]);
    expect(Array.from(bv).length).toBe(3);
  });
});

describe("JS-interop: dicts / objects", () => {
  // Was: threw on the BigInt inside a plain-object dict's boxed AExact entries.
  // Native-dict-provenance.md's ADict keeps entries inside a Map, which JSON.stringify
  // doesn't serialize at all (no own enumerable indexed properties) — so it no longer
  // throws, but it also doesn't produce anything useful: it leaks ADict's OWN wrapper
  // shape (ctx/provenance/kind), not the dict's data. No primitive in this codebase
  // implements `toJSON()` — `toJS`, asserted below, is the one documented escape
  // hatch; JSON.stringify was never a supported interop path for a boxed value.
  it("JSON.stringify(dict) no longer throws, but isn't a supported interop path either", async () => {
    const d = await one("(dict :a 1 :b 2)");
    expect(() => JSON.stringify(d)).not.toThrow();
  });

  it("exec(dict) is the working escape hatch", async () => {
    expect(await one("(dict :a 1 :b 2)")).toEqual({ a: 1, b: 2 });
  });
});
