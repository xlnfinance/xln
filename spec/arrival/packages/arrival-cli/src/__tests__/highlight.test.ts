// highlight — terminal syntax highlighting for Scheme/sugarcoat. Load-bearing invariant:
// identity under strip (colour is escapes only). Plus a few classification checks.
import { describe, expect, it } from "vitest";

import { highlightScheme } from "../highlight.js";
import { stripAnsi } from "./ansi-strip.js";

const SAMPLES = [
  "(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))",
  "(map (lambda (n) (* n n)) (iota 6))",
  '(let ((x 1) (y "two")) (+ x 3)) ; comment',
  "(cond (#t :yes) (else :no))",
  "#| block |# (require x)",
  '(string-append "a\\"b" 42 -5)',
  "",
  "   \n\t ",
  "(define incomplete", // partial input mid-keystroke
];

describe("highlightScheme — identity under strip", () => {
  for (const s of SAMPLES) {
    it(`round-trips: ${JSON.stringify(s).slice(0, 40)}`, () => {
      expect(stripAnsi(highlightScheme(s, "truecolor"))).toBe(s);
      expect(stripAnsi(highlightScheme(s, "256"))).toBe(s);
      expect(stripAnsi(highlightScheme(s, "16"))).toBe(s);
    });
  }
});

describe("highlightScheme — mode none is exact identity", () => {
  for (const s of SAMPLES) {
    it(`identity: ${JSON.stringify(s).slice(0, 30)}`, () => {
      expect(highlightScheme(s, "none")).toBe(s);
    });
  }
});

describe("highlightScheme — classification", () => {
  it("definition and control keywords share ONE keyword colour (orange)", () => {
    const def = highlightScheme("define", "truecolor");
    const ctrl = highlightScheme("if", "truecolor");
    expect(def).not.toBe("define"); // coloured
    expect(ctrl).not.toBe("if");
    // same darcula keyword hex for both — structural keywords are one class
    expect(def).toBe(ctrl.replace("if", "define"));
  });

  it("a plain symbol / number each get a darcula colour, distinct from each other", () => {
    const sym = highlightScheme("my-var", "truecolor");
    const num = highlightScheme("42", "truecolor");
    expect(sym).not.toBe("my-var"); // symbol gray-blue
    expect(num).not.toBe("42"); // number blue
    expect(sym).not.toBe(num.replace("42", "my-var")); // different hex
  });

  it("strings and :keywords are coloured", () => {
    expect(highlightScheme('"hi"', "truecolor")).not.toBe('"hi"');
    expect(highlightScheme(":verdict", "truecolor")).not.toBe(":verdict");
  });
});
