// Delimiter discrimination: dict vs n-expr braces, free list vs subscript brackets.
import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";

import { parser, classifyCurlyForms, scanCurlyBody, type DelimKind } from "../scheme-sugarcoat.js";

/** Drive the StreamParser over multi-line source → [text, tag] pairs (tag "" = null). */
function tokens(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const state = parser.startState!(2);
  for (const line of src.split("\n")) {
    const s = new StringStream(line, 2, 2, () => 0);
    while (!s.eol()) {
      s.start = s.pos;
      const tag = parser.token(s, state);
      if (s.pos === s.start) {
        s.pos++;
        continue;
      }
      out.push([line.slice(s.start, s.pos), tag ?? ""]);
    }
  }
  return out;
}

function braceTags(src: string): string[] {
  return tokens(src)
    .filter(([txt]) => txt === "{" || txt === "}")
    .map(([, tag]) => tag);
}

function bracketTags(src: string): string[] {
  return tokens(src)
    .filter(([txt]) => txt === "[" || txt === "]")
    .map(([, tag]) => tag);
}

describe("classifyCurlyForms (pure)", () => {
  it("empty → dict", () => expect(classifyCurlyForms([])).toBe("dict"));
  it("single form → nexpr unwrap", () => expect(classifyCurlyForms(["x"])).toBe("nexpr"));
  it("even kv → dict", () => {
    expect(classifyCurlyForms([":a", "1", ":b", "2"])).toBe("dict");
    expect(classifyCurlyForms(["name:", '"Ada"'])).toBe("dict");
  });
  it("odd op alternation → nexpr", () => {
    expect(classifyCurlyForms(["a", "+", "b"])).toBe("nexpr");
    expect(classifyCurlyForms(["a", "and", "b", "or", "c"])).toBe("nexpr");
    expect(classifyCurlyForms(["a", "==", "b"])).toBe("nexpr");
  });
  it("broken shapes → err when closed", () => {
    expect(classifyCurlyForms(["a", "b", "c"])).toBe("err");
    expect(classifyCurlyForms(["a", "+"])).toBe("err");
  });
});

describe("scanCurlyBody", () => {
  it("splits top-level forms and reports closed", () => {
    expect(scanCurlyBody("{a + b}", 1)).toEqual({ forms: ["a", "+", "b"], closed: true });
    expect(scanCurlyBody("{:a 1 :b 2}", 1)).toEqual({ forms: [":a", "1", ":b", "2"], closed: true });
    expect(scanCurlyBody("{a +", 1).closed).toBe(false);
  });
  it("keeps nested groups as one form", () => {
    expect(scanCurlyBody("{a + (b * c)}", 1).forms).toEqual(["a", "+", "(b * c)"]);
  });
});

describe("dict vs n-expr braces", () => {
  it("{} and {:a 1} are dict braces", () => {
    expect(braceTags("{}")).toEqual(["sugarcoatDictBrace", "sugarcoatDictBrace"]);
    expect(braceTags("{:a 1}")).toEqual(["sugarcoatDictBrace", "sugarcoatDictBrace"]);
    expect(braceTags('{name: "Ada" age: 36}')).toEqual(["sugarcoatDictBrace", "sugarcoatDictBrace"]);
  });

  it("{a + b} and {a and b} are n-expr braces", () => {
    expect(braceTags("{a + b}")).toEqual(["sugarcoatNexprBrace", "sugarcoatNexprBrace"]);
    expect(braceTags("{a and b}")).toEqual(["sugarcoatNexprBrace", "sugarcoatNexprBrace"]);
    expect(braceTags("{(x) => x * 2}")).toEqual(["sugarcoatNexprBrace", "sugarcoatNexprBrace"]);
  });

  it("trailing-lambda braces after method-dot are n-expr", () => {
    const tags = braceTags("xs.map{ it * 2 }");
    expect(tags).toEqual(["sugarcoatNexprBrace", "sugarcoatNexprBrace"]);
  });

  it("at-body braces stay at-open / at-close (not dict/n-expr)", () => {
    const toks = tokens("@{hello @x}");
    expect(toks[0]).toEqual(["@{", "sugarcoatAtOpen"]);
    expect(toks.at(-1)).toEqual(["}", "sugarcoatAtClose"]);
  });

  it("nested dict inside n-expr gets both kinds", () => {
    // `{d == {:a 1}}` — outer n-expr, inner dict
    const tags = braceTags("{d == {:a 1}}");
    expect(tags).toEqual(["sugarcoatNexprBrace", "sugarcoatDictBrace", "sugarcoatDictBrace", "sugarcoatNexprBrace"]);
  });
});

describe("list vs subscript brackets", () => {
  it("free [1 2 3] / [] are list brackets", () => {
    expect(bracketTags("[]")).toEqual(["sugarcoatListBracket", "sugarcoatListBracket"]);
    expect(bracketTags("[1 2 3]")).toEqual(["sugarcoatListBracket", "sugarcoatListBracket"]);
  });

  it("tight xs[0] / f[:key] are subscript brackets", () => {
    expect(bracketTags("xs[0]")).toEqual(["sugarcoatSubBracket", "sugarcoatSubBracket"]);
    expect(bracketTags("f[:key]")).toEqual(["sugarcoatSubBracket", "sugarcoatSubBracket"]);
    expect(bracketTags("obj[k]")).toEqual(["sugarcoatSubBracket", "sugarcoatSubBracket"]);
  });

  it("chained subscripts are each sub pairs", () => {
    expect(bracketTags("xs[0][1]")).toEqual([
      "sugarcoatSubBracket",
      "sugarcoatSubBracket",
      "sugarcoatSubBracket",
      "sugarcoatSubBracket",
    ]);
  });

  it("spaced free list after a call head is list, not sub", () => {
    // `(f [1 2])` — space before `[`
    expect(bracketTags("(f [1 2])")).toEqual(["sugarcoatListBracket", "sugarcoatListBracket"]);
  });

  it("list of dicts mixes list brackets + dict braces", () => {
    const b = braceTags("[{:a 1}]");
    const k = bracketTags("[{:a 1}]");
    expect(k).toEqual(["sugarcoatListBracket", "sugarcoatListBracket"]);
    expect(b).toEqual(["sugarcoatDictBrace", "sugarcoatDictBrace"]);
  });
});

describe("graft code path uses the same delimiter tags", () => {
  it("subscript inside @() graft is sub, not list", () => {
    const tags = bracketTags("@{v: @(xs[0])}");
    // Only the graft's xs[0] brackets — at-body has no free list here.
    expect(tags).toEqual(["sugarcoatSubBracket", "sugarcoatSubBracket"]);
  });
});

// Keep DelimKind export honest for theme/docs consumers.
describe("DelimKind surface", () => {
  it("exports the six kinds used by the stack", () => {
    const kinds: DelimKind[] = ["dict", "nexpr", "list", "sub", "ambig", "err"];
    expect(kinds).toHaveLength(6);
  });
});
