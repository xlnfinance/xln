// markdown — primitive md → ANSI for value output. Detection is conservative; rendering
// asserts structure (via stripAnsi) and that spans get escapes.
import { describe, expect, it } from "vitest";

import { looksLikeMarkdown, renderMarkdown, topLevelString } from "../markdown.js";
import { stripAnsi } from "./ansi-strip.js";

describe("topLevelString", () => {
  it("extracts + unescapes a single top-level string literal", () => {
    expect(topLevelString('"hi"')).toBe("hi");
    expect(topLevelString('"a\\nb"')).toBe("a\nb"); // \n unescaped to a real newline
    expect(topLevelString('"a\\tb\\"c"')).toBe('a\tb"c');
  });
  it("is null for non-strings and non-top-level", () => {
    expect(topLevelString("42")).toBeNull();
    expect(topLevelString("(list 1 2)")).toBeNull();
    expect(topLevelString('(f "x")')).toBeNull(); // string is nested, not the whole value
  });
});

describe("looksLikeMarkdown — conservative", () => {
  it("true for real block structure", () => {
    expect(looksLikeMarkdown("# Heading")).toBe(true);
    expect(looksLikeMarkdown("- item\n- item")).toBe(true);
    expect(looksLikeMarkdown("1. first")).toBe(true);
    expect(looksLikeMarkdown("> quote")).toBe(true);
    expect(looksLikeMarkdown("text\n```\ncode\n```")).toBe(true);
  });
  it("false for a plain string with a stray marker", () => {
    expect(looksLikeMarkdown("hello world")).toBe(false);
    expect(looksLikeMarkdown("a * b * c")).toBe(false); // multiplication, not a list
    expect(looksLikeMarkdown("2 > 1")).toBe(false); // comparison, not a quote
  });
});

describe("renderMarkdown", () => {
  it("headers, bullets, ordered, quotes render their structure (stripped)", () => {
    const lines = renderMarkdown("# Title\n- a\n- b\n1. one\n> note", "truecolor");
    const stripped = lines.map(stripAnsi);
    expect(stripped[0]).toBe("Title"); // header text, no `#`
    expect(stripped[1]).toBe("  • a");
    expect(stripped[3]).toBe("  1. one");
    expect(stripped[4]).toBe("│ note");
  });
  it("fenced code drops the ``` markers and keeps the body", () => {
    const lines = renderMarkdown("```\nx = 1\n```", "truecolor").map(stripAnsi);
    expect(lines).toEqual(["  x = 1"]);
  });
  it("inline bold / code emit escapes; a link becomes an OSC 8 hyperlink", () => {
    const bold = renderMarkdown("**hi**", "truecolor")[0]!;
    expect(bold).toMatch(/\x1b\[1m/); // SGR bold
    expect(stripAnsi(bold)).toBe("hi");
    const link = renderMarkdown("[docs](https://x.test)", "truecolor")[0]!;
    expect(link).toContain("]8;;https://x.test"); // OSC 8
    expect(stripAnsi(link)).toContain("docs");
  });
  it('mode "none" renders structure without color/escapes', () => {
    const lines = renderMarkdown("# H\n- a", "none");
    expect(lines).toEqual(["H", "  • a"]);
  });
});
