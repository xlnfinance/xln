// Direct unit tests for the Parser's datum construction (the reader).
//
// Like lexer.test.ts, these drive `new Parser` directly rather than going
// through the full `exec` stack, so the `@arrival/reader` extraction (DAG P3)
// and the keystone's parse-time refactor have a fast behavioral floor.
//
// A bare Parser ({} — no env) covers the whole standard grammar plus the
// builtin quote-family sugar: those expand to lists WITHOUT consulting the
// environment, so no stdlib bootstrap is needed. (User-defined reader
// extensions, which DO hit the env, are out of scope here.)
//
// Assertions round-trip through `toString()` — parse→serialize is exactly the
// invariant the keystone must preserve, and it's robust to internal value-shape
// changes.
import { describe, expect, it } from "vitest";
import { EOF } from "../../values/primitives/EOF.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AString } from "../../values/primitives/AString.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { ADict } from "../../values/primitives/ADict.js";
import { Parser } from "../Parser.js";
import type { SchemeValue } from "../../values/types.js";

async function readAll(src: string): Promise<SchemeValue[]> {
  const parser = new Parser({});
  parser.parse(src);
  const out: SchemeValue[] = [];
  while (true) {
    const obj = await parser.read_object();
    if (obj instanceof EOF) break;
    out.push(obj as SchemeValue);
  }
  return out;
}

async function readOne(src: string): Promise<string> {
  const [datum] = await readAll(src);
  return String((datum as { toString(): string }).toString());
}

describe("Parser — atoms", () => {
  it("reads a symbol", async () => {
    expect(await readOne("foo")).toBe("foo");
  });

  it("reads integers and decimals", async () => {
    expect(await readOne("42")).toBe("42");
    expect(await readOne("-7")).toBe("-7");
  });

  it("reads booleans", async () => {
    expect(await readOne("#t")).toBe("#t");
    expect(await readOne("#f")).toBe("#f");
    expect(await readOne("#true")).toBe("#t");
    expect(await readOne("#false")).toBe("#f");
  });

  it("reads #\\' as the apostrophe character, not a quote", async () => {
    expect(await readOne("#\\'")).toBe("#\\'");
  });

  it('reads #\\" as the double-quote character, not a string opener', async () => {
    expect(await readOne('#\\"')).toBe('#\\"');
  });

  it("reads #\\' inside a list as a character, not a quote", async () => {
    const [form] = await readAll("(char=? x #\\')");
    const items = (form as APair<any, any>).to_array(false);
    expect(items[2]).toBeInstanceOf(ACharacter);
    expect((items[2] as ACharacter).valueOf()).toBe("'");
  });
});

describe("Parser — lists", () => {
  it("reads a flat list", async () => {
    expect(await readOne("(+ 1 2)")).toBe("(+ 1 2)");
  });

  it("reads a nested list", async () => {
    expect(await readOne("(a (b c) d)")).toBe("(a (b c) d)");
  });

  it("reads the empty list", async () => {
    expect(await readOne("()")).toBe("()");
  });

  it("reads a dotted pair", async () => {
    expect(await readOne("(a . b)")).toBe("(a . b)");
  });

  it("doors a second dot and a dotted hash-vector", async () => {
    await expect(readOne("(a . b . c)")).rejects.toMatchObject({ code: "E-DOT-EXTRA-ELEMENT" });
    await expect(readOne("#(a . b)")).rejects.toMatchObject({ code: "E-LITERAL-DOT" });
    await expect(readOne("#u8(1 . 2)")).rejects.toMatchObject({ code: "E-LITERAL-DOT" });
  });
});

describe("Parser — quote sugar (builtin extensions)", () => {
  it("expands quote", async () => {
    expect(await readOne("'x")).toBe("(quote x)");
  });

  it("expands quasiquote / unquote / unquote-splicing", async () => {
    expect(await readOne("`x")).toBe("(quasiquote x)");
    expect(await readOne(",x")).toBe("(unquote x)");
    expect(await readOne(",@x")).toBe("(unquote-splicing x)");
  });
});

describe("Parser — #attachment tagged literal (serializer extras)", () => {
  it("consumes the following datum as one form", async () => {
    const forms = await readAll('#attachment "att-1 (image/png, 34kB)"');
    expect(forms).toHaveLength(1);
    const form = forms[0] as APair<any, any>;
    expect(form).toBeInstanceOf(APair);
    expect((form.car as ASymbol).valueOf()).toBe("attachment");
    const payload = (form.cdr as APair<any, any>).car as AString;
    expect(payload).toBeInstanceOf(AString);
    expect(payload.valueOf()).toBe("att-1 (image/png, 34kB)");
  });

  it('fills a dict value slot so {:k #attachment "…"} has even arity', async () => {
    const forms = await readAll('{:img #attachment "att-1 (image/png, 64B)"}');
    expect(forms).toHaveLength(1);
    expect(forms[0]).toBeInstanceOf(ADict);
    const value = (forms[0] as ADict).get("img") as APair<any, any>;
    expect(value).toBeInstanceOf(APair);
    expect((value.car as ASymbol).valueOf()).toBe("attachment");
  });

  it("does not shift later keys when a vector follows", async () => {
    const forms = await readAll('{:img #attachment "att-1 (image/png, 34kB)" :list [1 2 3]}');
    expect(forms).toHaveLength(1);
    const dict = forms[0] as ADict;
    expect(dict.keys()).toEqual(["img", "list"]);
    expect(dict.get("list")).toBeInstanceOf(AVector);
  });
});

describe("Parser — vectors & strings", () => {
  it("reads a vector as a boxed SchemeVector of its elements", async () => {
    const [vec] = await readAll("#(1 2 3)");
    // Vectors are boxed into SchemeVector (boxing track): the raw element array
    // is the .__vector__ payload, not the value itself.
    expect(vec).toBeInstanceOf(AVector);
    expect((vec as AVector).__vector__.map((x) => String(x))).toEqual(["1", "2", "3"]);
  });

  it("reads a string literal (content, unquoted)", async () => {
    // bare toString() yields the raw content; toString(true) re-quotes it.
    expect(await readOne('"hello"')).toBe("hello");
  });
});

// R7RS §7.1.1 `|...|` bar-quoted symbols. A live sampler run had a model correctly emit
// `(list |Picnic Tables| |Public Restrooms|)` (valid R7RS) and the reader mis-scored it —
// this locks the actual reader behavior down at the Parser level (parse_symbol/ASymbol are
// exercised through the same entry every real caller uses).
describe("Parser — bar-quoted symbols (R7RS §7.1.1 |...|)", () => {
  it("reads a bar-quoted symbol with spaces", async () => {
    const [sym] = await readAll("|foo bar|");
    expect((sym as ASymbol).valueOf()).toBe("foo bar");
  });

  it("reads |Picnic Tables| and |Public Restrooms| as two symbols inside a list", async () => {
    const [list] = await readAll("(list |Picnic Tables| |Public Restrooms|)");
    const items = (list as APair<any, any>).to_array(false) as ASymbol[];
    expect(items.map((s) => s.valueOf())).toEqual(["list", "Picnic Tables", "Public Restrooms"]);
  });

  it("reads the empty bar-quoted symbol || as the empty-name symbol", async () => {
    const [sym] = await readAll("||");
    expect((sym as ASymbol).valueOf()).toBe("");
  });

  it("decodes an escaped bar \\| to a literal |", async () => {
    const [sym] = await readAll("|with\\|bar|");
    expect((sym as ASymbol).valueOf()).toBe("with|bar");
  });

  it("decodes an inline hex escape \\x41; to its codepoint", async () => {
    const [sym] = await readAll("|x\\x41;y|");
    expect((sym as ASymbol).valueOf()).toBe("xAy");
  });

  it("decodes the mnemonic escapes \\t \\n \\r inside bars", async () => {
    const [sym] = await readAll("|a\\tb\\nc\\rd|");
    expect((sym as ASymbol).valueOf()).toBe("a\tb\nc\rd");
  });

  it("decodes the mnemonic escapes \\a (alarm) and \\b (backspace)", async () => {
    const [sym] = await readAll("|x\\ay\\bz|");
    expect((sym as ASymbol).valueOf()).toBe("x\x07y\bz");
  });

  it("rejects an unrecognized backslash escape", async () => {
    await expect(readAll("|bad\\qescape|")).rejects.toThrow();
  });

  it("round-trips a symbol that needs bars through toString(true) and back through the reader", async () => {
    const [sym] = await readAll("|foo bar|");
    const printed = (sym as ASymbol).toString(true);
    expect(printed).toBe("|foo bar|");
    const [reparsed] = await readAll(printed);
    expect((reparsed as ASymbol).valueOf()).toBe((sym as ASymbol).valueOf());
  });

  it("round-trips a symbol whose name itself contains a bar and a backslash", async () => {
    const [sym] = await readAll("|with\\|bar|");
    const printed = (sym as ASymbol).toString(true);
    const [reparsed] = await readAll(printed);
    expect((reparsed as ASymbol).valueOf()).toBe((sym as ASymbol).valueOf());
    expect((reparsed as ASymbol).valueOf()).toBe("with|bar");
  });

  it("round-trips the empty symbol through toString(true) as ||", async () => {
    const [sym] = await readAll("||");
    const printed = (sym as ASymbol).toString(true);
    expect(printed).toBe("||");
    const [reparsed] = await readAll(printed);
    expect((reparsed as ASymbol).valueOf()).toBe("");
  });

  it("a plain symbol prints without bars even when asked to quote", async () => {
    const [sym] = await readAll("foo-bar");
    expect((sym as ASymbol).toString(true)).toBe("foo-bar");
  });
});

describe("Parser — multiple top-level forms", () => {
  it("reads each top-level datum", async () => {
    const all = await readAll("1 2 3");
    expect(all.map((d) => String((d as { toString(): string }).toString()))).toEqual(["1", "2", "3"]);
  });

  it("skips line comments", async () => {
    const all = await readAll("; a comment\n42");
    expect(all).toHaveLength(1);
    expect(String((all[0] as { toString(): string }).toString())).toBe("42");
  });
});
