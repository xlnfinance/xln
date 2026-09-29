/**
 * SRFI-13 string library (env/srfi/srfi-13.ts) — the completion pack.
 *
 * scheme/srfi-13 owns `string-contains` / `string-contains?` plus the rest of the
 * standard string library the case trio (scheme/strings) does not cover. This suite
 * pins the completed surface: contains, predicates, index/count (char OR one-arg
 * predicate criteria — no charsets), slices (take/drop and -right twins, out-of-range
 * IS an error), trim/pad, reverse, join/tokenize, and SRFI-152's `string-split`.
 *
 * Provenance: booleans/indices carry the searched strings' lineage; derived strings
 * carry the source's; split/tokenize taint EACH piece so list elements stay grounded.
 */
import { describe, it, expect } from "vitest";
import type { EnvWithInternals, ResolvingAmbient } from "../../AmbientRuntime.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { execOverFrame, execStateOverFrame, execInFrame } from "../../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import { AString } from "../../../values/primitives/AString.js";
import { AValue } from "../../../values/primitives/AValue.js";
import { requireEagerOracle } from "../../../__tests__/_require-eager-oracle.js";

// Q20b: SRFI-13's provenance assertions run real programs — force the oracle ON
// for this file's lifetime.
requireEagerOracle();

const stamped = (s: string, ...points: number[]) => new AString(s, new Set(points));
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
// Literal-string args carry no provenance, so results come back raw (JS boolean/string
// or a bare SchemeExact); a provenanced input boxes it. Unwrap either shape.
const js = (x: unknown) => (x instanceof AValue ? x["arrival/toJS"]() : x);

let seq = 0;
async function run(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  const env = inferenceEnv.child(`srfi-13-${seq++}`) as EnvWithInternals<ResolvingAmbient>;
  for (const [k, v] of Object.entries(bindings)) env.bind(k, v);
  const [r] = await execOverFrame(src, { env });
  return r;
}

// execState (COMPLEX tier): the "carries the provenance" cells below assert box
// discipline directly (`toBeInstanceOf(AValue)`, `.provenance` — RULINGS.md R1).
async function runBoxed(src: string, bindings: Record<string, AString> = {}): Promise<unknown> {
  const env = inferenceEnv.child(`srfi-13-${seq++}`) as EnvWithInternals<ResolvingAmbient>;
  for (const [k, v] of Object.entries(bindings)) env.bind(k, v);
  const [r] = (await execStateOverFrame(src, { env })).values;
  return r;
}

describe("string-null? — emptiness predicate", () => {
  it.each([
    { name: "empty string is null", input: '(string-null? "")', value: true },
    { name: "non-empty string is not null", input: '(string-null? "a")', value: false },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-prefix? / string-suffix? — SRFI-13 affix-first argument order", () => {
  it.each([
    { name: "matching prefix", input: '(string-prefix? "foo" "foobar")', value: true },
    { name: "non-matching prefix", input: '(string-prefix? "bar" "foobar")', value: false },
    { name: "empty prefix always matches", input: '(string-prefix? "" "foobar")', value: true },
    { name: "matching suffix", input: '(string-suffix? "bar" "foobar")', value: true },
    { name: "non-matching suffix", input: '(string-suffix? "foo" "foobar")', value: false },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
  it("carries the provenance of the searched string", async () => {
    const r = await runBoxed('(string-prefix? "Al" name)', { name: stamped("Alloy.exe", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-index — index of first match, or #f (char OR predicate)", () => {
  it.each([
    { name: "char criterion — match", input: '(string-index "abc" #\\b)', value: 1 },
    { name: "char criterion — no match", input: '(string-index "abc" #\\z)', value: false },
    { name: "index 0 is truthy in an if", input: '(if (string-index "abc" #\\a) 1 0)', value: 1 },
    { name: "index 0 is a real (non-#f) index", input: '(string-index "abc" #\\a)', value: 0 },
    {
      name: "predicate criterion — named predicate",
      input: '(string-index "hello world" char-whitespace?)',
      value: 5,
    },
    {
      name: "predicate criterion — lambda",
      input: '(string-index "abc123" (lambda (c) (char-numeric? c)))',
      value: 3,
    },
    { name: "empty string never matches", input: '(string-index "" #\\a)', value: false },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-count — how many chars match", () => {
  it.each([
    { name: "char criterion", input: '(string-count "banana" #\\a)', value: 3 },
    { name: "predicate criterion", input: '(string-count "a1b2c3" char-numeric?)', value: 3 },
    { name: "empty string counts zero", input: '(string-count "" #\\a)', value: 0 },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-take / string-drop and the -right twins", () => {
  it.each([
    { name: "string-take normal slice", input: '(string-take "hello" 2)', value: "he" },
    { name: "string-drop normal slice", input: '(string-drop "hello" 2)', value: "llo" },
    { name: "string-take-right normal slice", input: '(string-take-right "hello" 2)', value: "lo" },
    { name: "string-drop-right normal slice", input: '(string-drop-right "hello" 2)', value: "hel" },
    { name: "string-take n=0 boundary", input: '(string-take "hello" 0)', value: "" },
    { name: "string-take n=length boundary", input: '(string-take "hello" 5)', value: "hello" },
    { name: "string-drop n=0 boundary", input: '(string-drop "hello" 0)', value: "hello" },
    { name: "string-drop n=length boundary", input: '(string-drop "hello" 5)', value: "" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });

  it.each([
    { name: "string-take overruns the string", input: '(string-take "hi" 3)' },
    { name: "string-drop-right overruns the string", input: '(string-drop-right "hi" 3)' },
  ])("n out of range is an error (SRFI-13) · $name", async ({ input }) => {
    await expect(run(input)).rejects.toThrow(/out of range/);
  });

  it("slices carry the source string's lineage", async () => {
    const r = await runBoxed("(string-take name 2)", { name: stamped("Alloy", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-trim family — SRFI-13 left/right/both; char/predicate criteria", () => {
  it.each([
    { name: "default: string-trim (left only)", input: '(string-trim "  hi  ")', value: "hi  " },
    { name: "default: string-trim-both", input: '(string-trim-both "  hi  ")', value: "hi" },
    {
      name: "default: string-trim-left (alias of string-trim)",
      input: '(string-trim-left "  hi  ")',
      value: "hi  ",
    },
    { name: "default: string-trim-right", input: '(string-trim-right "  hi  ")', value: "  hi" },
    { name: "char criterion: string-trim", input: '(string-trim "xxhixx" #\\x)', value: "hixx" },
    {
      name: "char criterion: string-trim-both",
      input: '(string-trim-both "xxhixx" #\\x)',
      value: "hi",
    },
    {
      name: "predicate criterion: string-trim",
      input: '(string-trim "12hi34" char-numeric?)',
      value: "hi34",
    },
    {
      name: "predicate criterion: string-trim-both",
      input: '(string-trim-both "12hi34" char-numeric?)',
      value: "hi",
    },
    { name: "all-whitespace string-trim", input: '(string-trim "   ")', value: "" },
    { name: "all-whitespace string-trim-both", input: '(string-trim-both "   ")', value: "" },
    { name: "empty string-trim", input: '(string-trim "")', value: "" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-pad / string-pad-right — to EXACTLY len (SRFI-13 truncation)", () => {
  it.each([
    { name: "pads on the left with space by default", input: '(string-pad "7" 3)', value: "  7" },
    {
      name: "pads on the right with space by default",
      input: '(string-pad-right "7" 3)',
      value: "7  ",
    },
    { name: "custom pad char", input: '(string-pad "7" 3 #\\0)', value: "007" },
    {
      name: "string-pad TRUNCATES too-long input, keeps the tail",
      input: '(string-pad "hello" 3)',
      value: "llo",
    },
    {
      name: "string-pad-right TRUNCATES too-long input, keeps the head",
      input: '(string-pad-right "hello" 3)',
      value: "hel",
    },
    { name: "len equal to length is identity", input: '(string-pad "abc" 3)', value: "abc" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-reverse", () => {
  it.each([
    { name: "reverses a string", input: '(string-reverse "abc")', value: "cba" },
    { name: "empty string stays empty", input: '(string-reverse "")', value: "" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-join — list of strings to one (default delimiter: single space)", () => {
  it.each([
    {
      name: "default delimiter (single space)",
      input: '(string-join (list "a" "b" "c"))',
      value: "a b c",
    },
    {
      name: "explicit delimiter",
      input: '(string-join (list "a" "b" "c") ", ")',
      value: "a, b, c",
    },
    { name: "empty list folds to the empty string", input: "(string-join '())", value: "" },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
  it("collapsing op: re-stamps the union of element lineage", async () => {
    const r = await runBoxed('(string-join (list name "x") "-")', { name: stamped("Alloy", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
  });
});

describe("string-tokenize — maximal runs of TOKEN chars (inverse of trim's criterion)", () => {
  it.each([
    {
      name: "default: non-whitespace runs, count",
      input: '(length (string-tokenize "  foo bar  baz "))',
      value: 3,
    },
    {
      name: "default: non-whitespace runs, first token",
      input: '(car (string-tokenize "  foo bar"))',
      value: "foo",
    },
    {
      name: "criterion selects token chars, first token",
      input: '(car (string-tokenize "12ab34" char-numeric?))',
      value: "12",
    },
    {
      name: "criterion selects token chars, count",
      input: '(length (string-tokenize "12ab34" char-numeric?))',
      value: 2,
    },
    { name: "no tokens yields '()", input: '(null? (string-tokenize "   "))', value: true },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });
});

describe("string-split — SRFI-152 literal-delimiter split", () => {
  it.each([
    { name: "basic split — count", input: '(length (string-split "a,b,c" ","))', value: 3 },
    { name: "basic split — second field", input: '(cadr (string-split "a,b,c" ","))', value: "b" },
    {
      name: "absent delimiter yields one field — count",
      input: '(length (string-split "abc" ","))',
      value: 1,
    },
    {
      name: "absent delimiter yields one field — value",
      input: '(car (string-split "abc" ","))',
      value: "abc",
    },
    {
      name: "empty subject yields '() (SRFI-152 refinement over JS .split)",
      input: '(null? (string-split "" ","))',
      value: true,
    },
    {
      name: "trailing delimiter keeps the empty trailing field (JS .split semantics)",
      input: '(length (string-split "a," ","))',
      value: 2,
    },
    {
      name: "character delimiter — count, behaviorally identical to string form",
      input: '(length (string-split "a,b,c" #\\,))',
      value: 3,
    },
    {
      name: "character delimiter — second field",
      input: '(cadr (string-split "a,b,c" #\\,))',
      value: "b",
    },
    {
      name: "character delimiter — absent delimiter yields one field",
      input: '(car (string-split "abc" #\\,))',
      value: "abc",
    },
    {
      name: "character delimiter — empty subject yields '()",
      input: '(null? (string-split "" #\\,))',
      value: true,
    },
  ])("$name", async ({ input, value }) => {
    expect(js(await run(input))).toBe(value);
  });

  it("pieces carry the source string's lineage (grounded list elements)", async () => {
    const r = await runBoxed('(car (string-split name ","))', { name: stamped("Alloy,exe", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
    expect(js(r)).toBe("Alloy");
  });

  // Gauche/Guile/MIT accept a CHARACTER delimiter, not just a string — the idiom a
  // model trained on those dialects reaches for by reflex. MCP-Atlas error-corpus
  // class `invariant-type-mismatch:string-split:expected-string-got-character` (9x
  // rate, a cascade seed) is this exact mistake. Grain-completion: accept it, coerce
  // to the single-char string it denotes; string-only behavior is unchanged.

  it("a character delimiter still taints pieces with the source string's lineage", async () => {
    const r = await runBoxed("(car (string-split name #\\,))", { name: stamped("Alloy,exe", 7) });
    expect(r).toBeInstanceOf(AValue);
    expect(sorted((r as AValue).provenance as Set<number>)).toEqual([7]);
    expect(js(r)).toBe("Alloy");
  });

  it("a non-string, non-character delimiter still errors with the type-mismatch door", async () => {
    await expect(run('(string-split "a,b,c" 42)')).rejects.toThrow(/string-split/);
  });
});
