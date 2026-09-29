// sexpr-color — subtle ANSI over serializer s-expr. The load-bearing invariant is
// identity-under-strip: coloring adds only escapes, never a byte of text.
import { describe, expect, it } from "vitest";

import { colorizeSexpr } from "../sexpr-color.js";
import { stripAnsi } from "./ansi-strip.js";

const SAMPLES = [
  "(1 2 3)",
  '(list "hello" "wo\\"rld" 42)',
  "(:verdict (car reactions))",
  "((a . b) [1 2] {x y})",
  "(define (f x) (* x x)) ; a comment\n(f 3)",
  "#| truncated: 40 more |#",
  '"unterminated string with (parens) and ;semicolons',
  "",
  "   \n\t  ",
  '(nested (deeply (list #t #f :key 3.14 -5 "s")))',
];

describe("colorizeSexpr — identity under strip", () => {
  for (const s of SAMPLES) {
    it(`round-trips: ${JSON.stringify(s).slice(0, 40)}`, () => {
      expect(stripAnsi(colorizeSexpr(s, "truecolor"))).toBe(s);
      expect(stripAnsi(colorizeSexpr(s, "256"))).toBe(s);
      expect(stripAnsi(colorizeSexpr(s, "16"))).toBe(s);
    });
  }
});

describe("colorizeSexpr — mode none is exact identity", () => {
  for (const s of SAMPLES) {
    it(`identity: ${JSON.stringify(s).slice(0, 40)}`, () => {
      expect(colorizeSexpr(s, "none")).toBe(s);
    });
  }
});

describe("colorizeSexpr — actually colors the structure", () => {
  it("emits escape codes for a paren'd expression on a color TTY", () => {
    const out = colorizeSexpr("(a b)", "truecolor");
    expect(out).not.toBe("(a b)");
    // eslint-disable-next-line no-control-regex -- asserting an escape IS present
    expect(out).toMatch(/\x1b\[/);
  });

  it("tints a keyword differently from a plain symbol", () => {
    const keyword = colorizeSexpr(":verdict", "truecolor");
    const symbol = colorizeSexpr("verdict", "truecolor");
    expect(keyword).not.toBe(symbol);
    // both colored, but by distinct hex — :keyword purple, symbol baseline gray-blue
    expect(symbol).not.toBe("verdict");
    expect(keyword.match(/38;2;[\d;]+/)?.[0]).not.toBe(symbol.match(/38;2;[\d;]+/)?.[0]);
  });

  it("leaves whitespace untinted (minimal diff)", () => {
    // three spaces between atoms come back verbatim, no escapes wrapping them
    const out = colorizeSexpr("a   b", "truecolor");
    expect(out).toContain("   ");
  });
});

describe("colorizeSexpr — darcula type coloring (each leaf type distinct)", () => {
  it("number, string, keyword, boolean, char, symbol each get a darcula color", () => {
    const num = colorizeSexpr("42", "truecolor");
    const str = colorizeSexpr('"x"', "truecolor");
    const kw = colorizeSexpr(":k", "truecolor");
    const bool = colorizeSexpr("#t", "truecolor");
    const sym = colorizeSexpr("foo", "truecolor");
    // symbol: baseline gray-blue (every leaf gets a color now)
    expect(sym).not.toBe("foo");
    // all colored (escapes present)
    for (const c of [num, str, kw, bool, sym]) expect(c).toMatch(/\x1b\[/);
    // and by distinct classes: number ≠ keyword ≠ string colors
    expect(num).not.toBe("42");
    expect(num.match(/38;2;[\d;]+/)?.[0]).not.toBe(kw.match(/38;2;[\d;]+/)?.[0]); // blue ≠ purple
    expect(str.match(/38;2;[\d;]+/)?.[0]).not.toBe(num.match(/38;2;[\d;]+/)?.[0]); // green ≠ blue
  });
  it("negative / decimal / rational / radix numbers all color as numbers", () => {
    const blue = colorizeSexpr("42", "truecolor").match(/38;2;[\d;]+/)?.[0];
    for (const nlit of ["-5", "3.14", "1/2", "#xff"]) {
      expect(colorizeSexpr(nlit, "truecolor").match(/38;2;[\d;]+/)?.[0]).toBe(blue);
    }
  });
});
