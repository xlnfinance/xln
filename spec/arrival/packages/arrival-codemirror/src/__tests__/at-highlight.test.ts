// at-expression syntax highlighting (scheme-sugarcoat StreamLanguage).
import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";

import { parser } from "../scheme-sugarcoat.js";

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

describe("at-expression highlighting", () => {
  it("single-line @{…}: opener keyword, prose string, interp variableName", () => {
    const toks = tokens("@{Pitch @product now}");
    expect(toks).toEqual([
      ["@{", "sugarcoatAtOpen"],
      ["Pitch ", "string"],
      ["@product", "sugarcoatInterp"],
      [" now", "string"],
      ["}", "sugarcoatAtClose"],
    ]);
  });

  it("@dedent head + @(graft) + quotes-as-literal", () => {
    const toks = tokens('@dedent{Say "@x" or @(f y)}');
    expect(toks).toEqual([
      ["@dedent{", "sugarcoatAtOpen"],
      ['Say "', "string"],
      ["@x", "sugarcoatInterp"],
      ['" or ', "string"],
      ["@(", "sugarcoatInterp"],
      ["f", "variableName"],
      [" ", ""],
      ["y", "variableName"],
      [")", "sugarcoatInterp"],
      ["}", "sugarcoatAtClose"],
    ]);
  });

  it("multi-line body carries the text mode across lines", () => {
    const toks = tokens("@dedent{first @a\n  second @b}");
    // spot-check: interps on both lines pop, close brace ends it
    expect(toks.filter(([, tag]) => tag === "sugarcoatInterp").map(([txt]) => txt)).toEqual(["@a", "@b"]);
    expect(toks.at(-1)).toEqual(["}", "sugarcoatAtClose"]);
  });

  it("bare @foo (no brace) stays a symbol, not an at-opener", () => {
    const toks = tokens("(@ obj key)");
    expect(toks.some(([, tag]) => tag === "sugarcoatAtOpen")).toBe(false);
  });

  it("tight @id[…] accessor chain is one interpolation token", () => {
    const toks = tokens("@{/@config/hero-id@persona[:id]@replay-idx}");
    expect(toks).toEqual([
      ["@{", "sugarcoatAtOpen"],
      ["/", "string"],
      ["@config/hero-id", "sugarcoatInterp"],
      ["@persona[:id]", "sugarcoatInterp"],
      ["@replay-idx", "sugarcoatInterp"],
      ["}", "sugarcoatAtClose"],
    ]);
  });

  it("spaced @id […] leaves brackets as prose", () => {
    const toks = tokens("@{count @n [approx]}");
    expect(toks.filter(([, tag]) => tag === "sugarcoatInterp").map(([txt]) => txt)).toEqual(["@n"]);
    expect(toks.some(([txt, tag]) => tag === "string" && txt.includes("[approx]"))).toBe(true);
  });

  it("@() graft interior is code-highlighted (not one opaque interp blob)", () => {
    const toks = tokens("@{pre@(map (lambda (h) h) xs)post}");
    expect(toks[0]).toEqual(["@{", "sugarcoatAtOpen"]);
    // map is a controlKeyword in the highlighter; lambda is definitionKeyword
    expect(toks.some(([txt, tag]) => txt === "map" && tag === "controlKeyword")).toBe(true);
    expect(toks.some(([txt, tag]) => txt === "lambda" && tag === "definitionKeyword")).toBe(true);
    expect(toks.some(([txt, tag]) => txt === "@(" && tag === "sugarcoatInterp")).toBe(true);
    expect(toks.some(([txt, tag]) => txt === ")" && tag === "sugarcoatInterp")).toBe(true);
    const prose = toks
      .filter(([, tag]) => tag === "string")
      .map(([txt]) => txt)
      .join("");
    expect(prose).toContain("pre");
    expect(prose).toContain("post");
  });

  it("nested @{…} opener is recognized inside an at-body", () => {
    const toks = tokens("@{a@{b@x}c}");
    const opens = toks.filter(([, tag]) => tag === "sugarcoatAtOpen").map(([txt]) => txt);
    expect(opens).toContain("@{");
    // nested @{
    expect(opens.length).toBeGreaterThanOrEqual(2);
  });
});
